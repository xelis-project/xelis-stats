import type { Env } from "./app";
import { fetchAllTickers, aggregate } from "./market/sources";
import { rpc } from "./xelis";
import { rotateShards } from "./shards";
import { syncAssetRegistry } from "./asset-registry";

/**
 * Cron: every 2 min — market snapshot, mempool snapshot, peer network snapshot.
 * Cron: hourly — node version/pruned counts, tag + prefix concentration, daily rollup.
 */

// A peer is "lagging" when its topoheight falls this far behind ours.
const LAG_BLOCKS = 50;
// A peer is "stale" when we haven't heard a ping in over an hour.
const STALE_S = 3600;

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

    if (new Date().getUTCMinutes() === 0) {
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
        const host = (p.addr ?? "").split(":")[0];
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
      if (tagStmts.length || prefixStmts.length) await env.DB.batch([...tagStmts, ...prefixStmts]);
    }
  } catch (err) {
    console.error("peers cron:", (err as Error).message);
  }
}
export async function handleCron(env: Env): Promise<void> {
  // market snapshot
  try {
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
  } catch (err) {
    console.error("market cron:", (err as Error).message);
  }

  // mempool snapshot
  let info: { mempool_size: number; topoheight: number; top_block_hash: string } | null = null;
  try {
    info = await rpc<{ mempool_size: number; topoheight: number; top_block_hash: string }>("get_info", undefined, env.XELIS_NODE);
    await env.DB.prepare("INSERT OR REPLACE INTO mempool_snapshots (ts, size) VALUES (?, ?)")
      .bind(Date.now(), info.mempool_size).run();
    // rollupDailyStats binds 11 date params below
  } catch (err) {
    console.error("mempool cron:", (err as Error).message);
  }

  // peer network snapshot (every run)
  if (info) await snapshotPeers(env, info.topoheight, info.top_block_hash);

  // reconcile the full asset registry so /assets is complete even for assets
  // the tx-detail pass never saw in a transfer/burn (cheap when unchanged)
  try {
    const written = await syncAssetRegistry(env);
    if (written) console.log(`asset registry: synced ${written} rows`);
  } catch (err) {
    console.error("asset registry cron:", (err as Error).message);
  }

  // hourly tasks (single cron schedule; use minute to distinguish — run when minute === 0)
  const minute = new Date().getUTCMinutes();
  if (minute === 0) {
    // daily rollup: recompute today's (and yesterday's) daily_stats row from D1
    await rollupDailyStats(env, new Date().toISOString().slice(0, 10));
    await rollupDailyStats(env, new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
    // D1 10GB workaround: migrate old raw rows into shard databases
    try {
      const result = await rotateShards(env);
      if (result !== "disabled") console.log("shard rotation:", result);
    } catch (err) {
      console.error("shard rotation:", (err as Error).message);
    }
  }
}

/** Recompute a single day's daily_stats row from blocks/tx_index in D1. */
export async function rollupDailyStats(env: Env, date: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await env.DB.prepare(`
      SELECT
        (SELECT COUNT(DISTINCT sender) FROM tx_index WHERE date(ts/1000,'unixepoch') = ?) AS active_accounts,
        (SELECT COUNT(*) FROM accounts WHERE date(first_seen/1000,'unixepoch') = ?) AS new_accounts,
        (SELECT COUNT(*) FROM tx_index WHERE date(ts/1000,'unixepoch') = ?) AS tx_count,
        (SELECT AVG(fee) FROM tx_index WHERE date(ts/1000,'unixepoch') = ?) AS avg_fee,
        (SELECT SUM(transfer_count) FROM tx_index WHERE date(ts/1000,'unixepoch') = ?) AS transfer_count,
        (SELECT AVG(difficulty)/5.0 FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS hashrate,
        (SELECT COUNT(DISTINCT miner_address) FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS unique_miners,
        (SELECT SUM(CASE WHEN block_type='Side' THEN 1 ELSE 0 END) FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS orphan_count,
        (SELECT SUM(fee_total) FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS fee_total_sum,
        (SELECT SUM(miner_reward+dev_reward) FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS miner_revenue,
        (SELECT SUM(burned) FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS burned_day,
        (SELECT SUM(peer_count) FROM node_versions WHERE date = ?) AS peer_count
    `).bind(date, date, date, date, date, date, date, date, date, date, date, date).first<Record<string, unknown>>();

    if (!row || (row.tx_count === 0 && row.active_accounts === 0 && (row.miner_revenue ?? 0) === 0 && (row.peer_count ?? 0) === 0)) return;

    // supply is cumulative: continue from the last stored day, adding today's
    // emitted (block rewards) and burned (block fees burned) amounts.
    const prev = await env.DB.prepare(
      "SELECT (SELECT COALESCE(SUM(miner_revenue),0) FROM daily_stats WHERE date < ?) AS emitted, (SELECT burned_supply FROM daily_stats WHERE date < ? ORDER BY date DESC LIMIT 1) AS burned"
    ).bind(date, date).first<{ emitted: number | null; burned: number | null }>();
    const emittedSupply = Number(prev?.emitted ?? 0) + Number(row.miner_revenue ?? 0);
    const burnedSupply = Number(prev?.burned ?? 0) + Number(row.burned_day ?? 0);
    const circulatingSupply = emittedSupply - burnedSupply;

    await env.DB.prepare(`INSERT OR REPLACE INTO daily_stats
      (date, active_accounts, new_accounts, tx_count, avg_fee, transfer_count, hashrate, unique_miners, orphan_count, fee_total_sum, miner_revenue, peer_count, emitted_supply, burned_supply, circulating_supply)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        active_accounts = excluded.active_accounts, new_accounts = excluded.new_accounts,
        tx_count = excluded.tx_count, avg_fee = excluded.avg_fee, transfer_count = excluded.transfer_count,
        hashrate = excluded.hashrate, unique_miners = excluded.unique_miners, orphan_count = excluded.orphan_count,
        fee_total_sum = excluded.fee_total_sum, miner_revenue = excluded.miner_revenue,
        emitted_supply = excluded.emitted_supply, burned_supply = excluded.burned_supply,
        circulating_supply = excluded.circulating_supply,
        peer_count = COALESCE(excluded.peer_count, peer_count)`)
      .bind(date, row.active_accounts, row.new_accounts, row.tx_count, row.avg_fee, row.transfer_count, row.hashrate, row.unique_miners, row.orphan_count, row.fee_total_sum, row.miner_revenue, row.peer_count, emittedSupply, burnedSupply, circulatingSupply).run();
  } catch (err) {
    console.error("rollupDailyStats:", (err as Error).message);
  }
}
