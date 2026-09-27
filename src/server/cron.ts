import type { Env } from "./app";
import { fetchAllTickers, aggregate } from "./market/sources";
import { rpc, getSizeOnDisk } from "./xelis";
import { rotateShards } from "./shards";
import { syncAssetRegistry } from "./asset-registry";

/**
 * Cron: every 2 min — market snapshot, mempool snapshot, chain size snapshot,
 * peer network snapshot.
 * Cron: hourly — node version/pruned counts, tag + prefix + country concentration, daily rollup.
 */

// A peer is "lagging" when its topoheight falls this far behind ours.
const LAG_BLOCKS = 50;
// A peer is "stale" when we haven't heard a ping in over an hour.
const STALE_S = 3600;

// GeoIP lookup service (country/city aggregates only). It requires an Origin
// header matching the allowed front-end, so a plain server-side fetch is rejected.
const GEOIP_URL = "https://geoip.xelis.io/";

interface GeoIpEntry {
  success?: boolean;
  country?: string;
  country_code?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

// Extract the bare host from a peer address, handling "host:port" and
// "[ipv6]:port" forms.
function hostOf(addr: string | undefined): string {
  const a = addr ?? "";
  if (a.startsWith("[")) {
    const end = a.indexOf("]");
    return end > 0 ? a.slice(1, end) : a;
  }
  const colon = a.indexOf(":");
  return colon > 0 ? a.slice(0, colon) : a;
}

// Resolve a batch of peer hosts to country + city (with coordinates). Returns
// only successful hits; unresolved hosts are bucketed as "Unknown" by the caller.
async function resolveGeo(hosts: string[]): Promise<Map<string, { country: string; code: string; city: string; lat: number; lon: number }>> {
  const out = new Map<string, { country: string; code: string; city: string; lat: number; lon: number }>();
  if (!hosts.length) return out;
  try {
    const res = await fetch(`${GEOIP_URL}?ips=${encodeURIComponent(hosts.join(","))}`, {
      headers: { Origin: "https://xelis.io", Accept: "application/json" },
    });
    if (!res.ok) return out;
    const data = await res.json<Record<string, GeoIpEntry>>();
    for (const [ip, v] of Object.entries(data)) {
      if (v?.success && v.country) {
        out.set(ip, {
          country: v.country,
          code: v.country_code ?? "",
          city: v.city ?? "",
          lat: Number(v.latitude),
          lon: Number(v.longitude),
        });
      }
    }
  } catch (err) {
    console.error("geoip:", (err as Error).message);
  }
  return out;
}

export interface PeerEntry {
  addr?: string;
  version?: string;
  topoheight?: number;
  top_block_hash?: string;
  pruned_topoheight?: number | null;
  tag?: string;
  connected_on?: number;
  last_ping?: number;
  bytes_recv?: number;
  bytes_sent?: number;
  peers?: Record<string, unknown>;
}

export async function snapshotPeers(
  env: Env,
  ourTopo: number,
  ourTopHash: string,
  hourly = false,
): Promise<void> {
  try {
    const res = await rpc<{ peers?: PeerEntry[]; hidden_peers?: number }>("get_peers", undefined, env.XELIS_NODE);
    const peers = res.peers ?? [];
    const now = Date.now() / 1000;
    const lags = peers.map((p) => (ourTopo > 0 && Number.isFinite(p.topoheight) ? ourTopo - (p.topoheight ?? 0) : 0));
    const connAges = peers.map((p) => (p.connected_on ? now - p.connected_on : 0));
    const row = {
      ts: Date.now(),
      total: peers.length,
      hidden: res.hidden_peers ?? 0,
      pruned: peers.filter((p) => p.pruned_topoheight != null).length,
      lagging: lags.filter((l) => l > LAG_BLOCKS).length,
      stale: peers.filter((p) => p.last_ping && now - p.last_ping > STALE_S).length,
      divergent: peers.filter((p) => p.top_block_hash && ourTopHash && p.top_block_hash !== ourTopHash).length,
      avg_lag: lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0,
      avg_peer_view: peers.length ? peers.reduce((a, p) => a + Object.keys(p.peers ?? {}).length, 0) / peers.length : 0,
      avg_conn_age: connAges.length ? Math.round(connAges.reduce((a, b) => a + b, 0) / connAges.length) : 0,
      new_conns: peers.filter((p) => p.connected_on && now - p.connected_on < 3600).length,
      bytes_recv: peers.reduce((a, p) => a + (p.bytes_recv ?? 0), 0),
      bytes_sent: peers.reduce((a, p) => a + (p.bytes_sent ?? 0), 0),
    };
    await env.DB.prepare(
      "INSERT OR REPLACE INTO peer_snapshots (ts, total, hidden, pruned, lagging, stale, divergent, avg_lag, avg_peer_view, avg_conn_age, new_conns, bytes_recv, bytes_sent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(row.ts, row.total, row.hidden, row.pruned, row.lagging, row.stale, row.divergent, row.avg_lag, row.avg_peer_view, row.avg_conn_age, row.new_conns, row.bytes_recv, row.bytes_sent).run();

    // keep ~30 days of 2-min snapshots
    await env.DB.prepare("DELETE FROM peer_snapshots WHERE ts < ?").bind(row.ts - 30 * 86400_000).run();

    if (hourly) {
      // per-version counts incl. pruned nodes
      const versions = new Map<string, { count: number; pruned: number }>();
      for (const p of peers) {
        const v = p.version ?? "unknown";
        const e = versions.get(v) ?? { count: 0, pruned: 0 };
        e.count += 1;
        if (p.pruned_topoheight != null) e.pruned += 1;
        versions.set(v, e);
      }
      const date = new Date().toISOString().slice(0, 10);
      const stmts = [...versions.entries()].map(([version, e]) =>
        env.DB.prepare("INSERT OR REPLACE INTO node_versions (date, version, peer_count, pruned_count) VALUES (?, ?, ?, ?)").bind(date, version, e.count, e.pruned)
      );
      if (stmts.length) await env.DB.batch(stmts);

      // tag + IP-prefix concentration (aggregates only, no raw addresses stored)
      const tags = new Map<string, number>();
      const prefixes = new Map<string, number>();
      for (const p of peers) {
        if (p.tag) tags.set(p.tag, (tags.get(p.tag) ?? 0) + 1);
        const host = hostOf(p.addr);
        if (!host) continue;
        const prefix = host.includes(".") ? host.split(".").slice(0, 2).join(".") : host.split(":").slice(0, 2).join(":");
        prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      }
      const tagStmts = [...tags.entries()].map(([tag, n]) =>
        env.DB.prepare("INSERT OR REPLACE INTO daily_peer_tags (date, tag, peers) VALUES (?, ?, ?)").bind(date, tag.slice(0, 64), n)
      );
      const prefixStmts = [...prefixes.entries()].filter(([, n]) => n >= 2).map(([prefix, n]) =>
        env.DB.prepare("INSERT OR REPLACE INTO daily_peer_prefixes (date, prefix, peers) VALUES (?, ?, ?)").bind(date, prefix.slice(0, 64), n)
      );

      // country + city concentration from GeoIP (aggregates only, no raw addresses)
      const hosts = [...new Set(peers.map((p) => hostOf(p.addr)).filter(Boolean))];
      const geo = await resolveGeo(hosts);
      const countries = new Map<string, { code: string; peers: number }>();
      const cities = new Map<string, { country: string; code: string; city: string; lat: number; lon: number; peers: number }>();
      for (const p of peers) {
        const g = geo.get(hostOf(p.addr));
        const name = g?.country ?? "Unknown";
        const e = countries.get(name) ?? { code: g?.code ?? "", peers: 0 };
        e.peers += 1;
        countries.set(name, e);
        // city rollup only for hits that actually resolved a named place
        if (!g || !g.city || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
        const key = `${g.code}\u0000${g.city}\u0000${g.lat}\u0000${g.lon}`;
        const c = cities.get(key) ?? { country: g.country, code: g.code, city: g.city, lat: g.lat, lon: g.lon, peers: 0 };
        c.peers += 1;
        cities.set(key, c);
      }
      const countryStmts = [...countries.entries()].map(([country, e]) =>
        env.DB.prepare("INSERT OR REPLACE INTO daily_peer_countries (date, country, country_code, peers) VALUES (?, ?, ?, ?)").bind(date, country.slice(0, 64), e.code.slice(0, 8), e.peers)
      );
      const cityStmts = [...cities.values()].map((c) =>
        env.DB.prepare("INSERT OR REPLACE INTO daily_peer_cities (date, country, country_code, city, latitude, longitude, peers) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(date, c.country.slice(0, 64), c.code.slice(0, 8), c.city.slice(0, 64), c.lat, c.lon, c.peers)
      );
      const rollups = [...tagStmts, ...prefixStmts, ...countryStmts, ...cityStmts];
      if (rollups.length) await env.DB.batch(rollups);
    }
  } catch (err) {
    console.error("peers cron:", (err as Error).message);
  }
}

// A cron invocation records one CronJobStatus per named task. Kept small:
// cron_runs history is trimmed to a week; cron_jobs keeps only the latest row.
export interface CronJobStatus {
  job: string;
  ok: boolean;
  ms: number;
}

const CRON_RUN_RETENTION_MS = 7 * 86400_000;

/** Persist this invocation's per-job outcomes and one run-history row. */
async function recordCronRun(
  env: Env,
  schedule: string,
  startedAt: number,
  jobs: CronJobStatus[],
): Promise<void> {
  if (!jobs.length) return;
  const ts = Date.now();
  const failed = jobs.filter((j) => !j.ok);
  // Error text is deliberately not persisted here: /api/cron and /status are
  // public. Full messages are emitted to Workers Logs (observability) instead.
  const jobStmt = env.DB.prepare(
    `INSERT INTO cron_jobs (job, last_ts, last_ok, last_ms, fail_streak, ok_total, fail_total)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job) DO UPDATE SET
       last_ts = excluded.last_ts,
       last_ok = excluded.last_ok,
       last_ms = excluded.last_ms,
       fail_streak = CASE WHEN excluded.last_ok = 1 THEN 0 ELSE cron_jobs.fail_streak + 1 END,
       ok_total = cron_jobs.ok_total + excluded.ok_total,
       fail_total = cron_jobs.fail_total + excluded.fail_total`
  );
  const stmts = jobs.map((j) =>
    jobStmt.bind(j.job, ts, j.ok ? 1 : 0, j.ms, j.ok ? 0 : 1, j.ok ? 1 : 0, j.ok ? 0 : 1)
  );
  stmts.push(env.DB.prepare(
    "INSERT INTO cron_runs (ts, schedule, duration_ms, jobs, failed) VALUES (?, ?, ?, ?, ?)"
  ).bind(
    ts,
    schedule,
    ts - startedAt,
    jobs.length,
    failed.length,
  ));
  await env.DB.batch(stmts);
  await env.DB.prepare("DELETE FROM cron_runs WHERE ts < ?").bind(ts - CRON_RUN_RETENTION_MS).run();
}

export async function handleCron(env: Env, schedule = "unknown"): Promise<void> {
  const startedAt = Date.now();
  const jobs: CronJobStatus[] = [];
  // The hourly trigger is "0 * * * *" and the every-2-min trigger is
  // "1-59/2 * * * *": the latter deliberately skips minute 0 so this hourly
  // flag is the sole owner of the top-of-hour work (otherwise both triggers
  // fire at :00 and rotateShards could race itself into a duplicate shard).
  const hourly = schedule === "0 * * * *";
  // Each task is timed and its failure captured instead of silently logged, so
  // /status and /api/cron can surface which scheduled work is unhealthy.
  const run = async <T>(job: string, fn: () => Promise<T>): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const value = await fn();
      jobs.push({ job, ok: true, ms: Date.now() - t0 });
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      jobs.push({ job, ok: false, ms: Date.now() - t0 });
      // structured so Workers Logs can filter by job/event; this is the only
      // place the full error text is kept (the DB and public API stay clean)
      console.error({ event: "cron_job_failed", job, ms: Date.now() - t0, error: message });
      return null;
    }
  };

  // wake the live collector so indexing continues in the background even with
  // no browser clients connected (the DO reconnects the node socket and runs
  // one incremental indexing pass; its alarm keeps it alive between ticks)
  await run("collector-tick", async () => {
    const stub = env.COLLECTOR.get(env.COLLECTOR.idFromName("global"));
    await stub.fetch("https://collector.internal/tick");
  });

  // market snapshot
  await run("market", async () => {
    const tickers = await fetchAllTickers();
    if (tickers.length) {
      const agg = aggregate(tickers);
      const stmt = env.DB.prepare(
        "INSERT OR REPLACE INTO market_snapshots (ts, exchange, market, last, bid, ask, high, low, change_pct, base_volume, quote_volume, source_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const stmts = agg.tickers.map((t) =>
        stmt.bind(Date.now(), t.exchange, t.market, t.last, t.bid, t.ask, t.high24h, t.low24h, t.changePct24h, t.baseVolume, t.quoteVolume, t.timestamp)
      );
      await env.DB.batch(stmts);
    }
  });

  // mempool snapshot; get_info also feeds the peer snapshot below
  const info = await run("mempool", async () => {
    const i = await rpc<{ mempool_size: number; topoheight: number; top_block_hash: string }>("get_info", undefined, env.XELIS_NODE);
    await env.DB.prepare("INSERT OR REPLACE INTO mempool_snapshots (ts, size) VALUES (?, ?)")
      .bind(Date.now(), i.mempool_size).run();
    return i;
  });

  // peer network snapshot (every run). Skipped when get_info failed — the
  // mempool job already records that failure, so peers is not double-counted.
  if (info) {
    await run("peers", () => snapshotPeers(env, info.topoheight, info.top_block_hash, hourly));
  }

  // on-disk chain size snapshot; the node may not expose get_size_on_disk
  await run("chain-size", async () => {
    const size = await getSizeOnDisk(env.XELIS_NODE);
    if (Number.isFinite(size?.size_bytes)) {
      await env.DB.prepare("INSERT OR REPLACE INTO chain_size_snapshots (ts, size_bytes) VALUES (?, ?)")
        .bind(Date.now(), size.size_bytes).run();
      // chain size grows slowly; keep a year of snapshots for long-term trend
      await env.DB.prepare("DELETE FROM chain_size_snapshots WHERE ts < ?").bind(Date.now() - 365 * 86400_000).run();
    }
  });

  // reconcile the full asset registry so /assets is complete even for assets
  // the tx-detail pass never saw in a transfer/burn (cheap when unchanged)
  await run("asset-registry", async () => {
    const written = await syncAssetRegistry(env);
    if (written) console.log(`asset registry: synced ${written} rows`);
  });

  // hourly tasks; the "0 * * * *" trigger owns these (see `hourly` above)
  if (hourly) {
    // asset supply history (the node only exposes the current minted supply)
    await run("asset-supply", async () => {
      const snapped = await snapshotAssetSupply(env);
      if (snapped) console.log(`asset supply: recorded ${snapped} snapshots`);
    });
    // daily rollup: recompute today's (and yesterday's) daily_stats row from D1
    await run("daily-rollup", async () => {
      await rollupDailyStats(env, new Date().toISOString().slice(0, 10));
      await rollupDailyStats(env, new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
    });
    // D1 10GB workaround: migrate old raw rows into shard databases
    await run("shard-rotation", async () => {
      const result = await rotateShards(env);
      if (result !== "disabled") console.log("shard rotation:", result);
    });
  }

  try {
    await recordCronRun(env, schedule, startedAt, jobs);
  } catch (err) {
    console.error({ event: "cron_monitor_failed", error: (err as Error).message });
  }
}

// Assets sampled for supply history each hour. Supply changes slowly, so we
// snapshot hourly and only write when the value changed. The cap keeps the RPC
// fan-out bounded; fixed/mintable tokens are prioritized, then oldest assets.
const ASSET_SUPPLY_MAX = 100;
const ASSET_SUPPLY_CONCURRENCY = 10;
const ASSET_SUPPLY_RETENTION_MS = 180 * 86400_000;

/**
 * Record current minted supply for tracked assets. `get_asset_supply` returns
 * only the latest value, so this is the only source of a supply history.
 * Returns the number of snapshots written.
 */
export async function snapshotAssetSupply(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT asset_id FROM assets
     ORDER BY (max_supply_kind IN ('fixed','mintable')) DESC, first_seen_topo ASC
     LIMIT ?`
  ).bind(ASSET_SUPPLY_MAX).all<{ asset_id: string }>();
  const ids = (rows.results ?? []).map((r) => r.asset_id).filter(Boolean);
  if (!ids.length) return 0;

  // last recorded value per asset, so unchanged supplies are not rewritten
  const latest = new Map<string, number>();
  const prev = await env.DB.prepare(
    `SELECT s.asset_id AS asset_id, s.supply AS supply
     FROM asset_supply_snapshots s
     JOIN (SELECT asset_id, MAX(ts) AS mt FROM asset_supply_snapshots GROUP BY asset_id) m
       ON m.asset_id = s.asset_id AND m.mt = s.ts`
  ).all<{ asset_id: string; supply: number }>();
  for (const r of prev.results ?? []) latest.set(r.asset_id, Number(r.supply));

  const ts = Date.now();
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ASSET_SUPPLY_CONCURRENCY) {
    const chunk = ids.slice(i, i + ASSET_SUPPLY_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (id) => {
      try {
        const s = await rpc<{ data?: number }>("get_asset_supply", { asset: id }, env.XELIS_NODE);
        const v = Number(s?.data);
        return Number.isFinite(v) ? { id, v } : null;
      } catch {
        return null; // asset gone / node hiccup: retried next hour
      }
    }));
    for (const r of results) {
      if (!r || latest.get(r.id) === r.v) continue;
      stmts.push(env.DB.prepare("INSERT OR REPLACE INTO asset_supply_snapshots (ts, asset_id, supply) VALUES (?, ?, ?)")
        .bind(ts, r.id, r.v));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  await env.DB.prepare("DELETE FROM asset_supply_snapshots WHERE ts < ?").bind(ts - ASSET_SUPPLY_RETENTION_MS).run();
  return stmts.length;
}

/** Recompute a single day's daily_stats row from blocks/tx_index in D1. */
export async function rollupDailyStats(env: Env, date: string): Promise<void> {
  try {
    // Half-open millisecond bounds for the UTC calendar day. `ts >= ? AND ts < ?`
    // can use the (ts, ...) indexes, unlike `date(ts/1000,'unixepoch') = ?`,
    // which is not sargable and forced a full scan per subquery.
    const startMs = Date.parse(`${date}T00:00:00Z`);
    const endMs = startMs + 86400_000;

    // One scan per table instead of 12 correlated scalar subqueries (SQLite
    // evaluates each as an independent full scan of blocks/tx_index).
    const [tx, accounts, blocks, versions] = await Promise.all([
      env.DB.prepare(`
        SELECT
          COUNT(*) AS tx_count,
          COUNT(DISTINCT sender) AS active_accounts,
          AVG(fee) AS avg_fee,
          SUM(transfer_count) AS transfer_count
        FROM tx_index WHERE ts >= ? AND ts < ?
      `).bind(startMs, endMs).first<Record<string, unknown>>(),
      env.DB.prepare(
        "SELECT COUNT(*) AS new_accounts FROM accounts WHERE first_seen >= ? AND first_seen < ?"
      ).bind(startMs, endMs).first<Record<string, unknown>>(),
      env.DB.prepare(`
        SELECT
          AVG(difficulty)/5.0 AS hashrate,
          COUNT(DISTINCT miner_address) AS unique_miners,
          SUM(CASE WHEN block_type='Side' THEN 1 ELSE 0 END) AS side_count,
          SUM(fee_total) AS fee_total_sum,
          SUM(miner_reward+dev_reward) AS miner_revenue,
          SUM(burned) AS burned_day
        FROM blocks WHERE ts >= ? AND ts < ?
      `).bind(startMs, endMs).first<Record<string, unknown>>(),
      env.DB.prepare(
        "SELECT SUM(peer_count) AS peer_count FROM node_versions WHERE date = ?"
      ).bind(date).first<Record<string, unknown>>(),
    ]);

    const row: Record<string, unknown> = {
      ...(tx ?? {}),
      ...(accounts ?? {}),
      ...(blocks ?? {}),
      ...(versions ?? {}),
    };

    if (row.tx_count === 0 && row.active_accounts === 0 && (row.miner_revenue ?? 0) === 0 && (row.peer_count ?? 0) === 0) return;

    // supply is cumulative: continue from the last stored day, adding today's
    // emitted (block rewards) and burned (block fees burned) amounts.
    const prev = await env.DB.prepare(
      "SELECT (SELECT COALESCE(SUM(miner_revenue),0) FROM daily_stats WHERE date < ?) AS emitted, (SELECT burned_supply FROM daily_stats WHERE date < ? ORDER BY date DESC LIMIT 1) AS burned"
    ).bind(date, date).first<{ emitted: number | null; burned: number | null }>();
    const emittedSupply = Number(prev?.emitted ?? 0) + Number(row.miner_revenue ?? 0);
    const burnedSupply = Number(prev?.burned ?? 0) + Number(row.burned_day ?? 0);
    const circulatingSupply = emittedSupply - burnedSupply;

    await env.DB.prepare(`INSERT OR REPLACE INTO daily_stats
      (date, active_accounts, new_accounts, tx_count, avg_fee, transfer_count, hashrate, unique_miners, side_count, fee_total_sum, miner_revenue, peer_count, emitted_supply, burned_supply, circulating_supply)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        active_accounts = excluded.active_accounts, new_accounts = excluded.new_accounts,
        tx_count = excluded.tx_count, avg_fee = excluded.avg_fee, transfer_count = excluded.transfer_count,
        hashrate = excluded.hashrate, unique_miners = excluded.unique_miners, side_count = excluded.side_count,
        fee_total_sum = excluded.fee_total_sum, miner_revenue = excluded.miner_revenue,
        emitted_supply = excluded.emitted_supply, burned_supply = excluded.burned_supply,
        circulating_supply = excluded.circulating_supply,
        peer_count = COALESCE(excluded.peer_count, peer_count)`)
      .bind(date, row.active_accounts, row.new_accounts, row.tx_count, row.avg_fee, row.transfer_count, row.hashrate, row.unique_miners, row.side_count, row.fee_total_sum, row.miner_revenue, row.peer_count, emittedSupply, burnedSupply, circulatingSupply).run();
  } catch (err) {
    console.error("rollupDailyStats:", (err as Error).message);
  }
}
