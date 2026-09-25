import { Hono } from "hono";
import type { Env } from "./app";
import { mergeGroups } from "./shards";

export const history = new Hono<{ Bindings: Env }>();

// Metric -> (column, table, aggregation across buckets). Metrics whose
// daily_stats column is never populated (the export only writes a subset) are
// computed from base tables instead: block-time (blocks), nakamoto/gini
// (daily_miners), miner-rev-usd and market-cap (daily_stats x
// market_snapshots), transfers, fee percentiles and encrypted (tx_index).
// supply/burned-supply read the pipeline-populated cumulative daily_stats
// columns (emitted/burned), reported in whole XEL.
const METRICS: Record<string, { table: string; col: string; agg?: "sum" | "avg" | "max"; div?: number }> = {
  txs: { table: "daily_stats", col: "tx_count", agg: "sum" },
  transfers: { table: "tx_transfers", col: "", agg: "sum" },
  accounts: { table: "daily_stats", col: "new_accounts", agg: "sum" },
  "active-accounts": { table: "daily_stats", col: "active_accounts", agg: "avg" },
  miners: { table: "daily_stats", col: "unique_miners", agg: "avg" },
  hashrate: { table: "daily_stats", col: "hashrate", agg: "avg" },
  difficulty: { table: "difficulty", col: "", agg: "avg" },
  "cum-difficulty": { table: "cum-difficulty", col: "", agg: "max" },
  // daily revenue (USD) per unit of estimated hashrate, scaled to USD per TH/day
  hashprice: { table: "hashprice", col: "", agg: "avg" },
  // fee columns hold atomic XEL; report whole XEL
  fees: { table: "daily_stats", col: "avg_fee", agg: "avg", div: 1e8 },
  "fees-median": { table: "fee-percentile", col: "median", agg: "avg", div: 1e8 },
  "fee-p90": { table: "fee-percentile", col: "p90", agg: "avg", div: 1e8 },
  "fees-p99": { table: "fee-percentile", col: "p99", agg: "avg", div: 1e8 },
  supply: { table: "supply-stored", col: "circulating_supply", agg: "avg" },
  "burned-supply": { table: "supply-stored", col: "burned_supply", agg: "avg" },
  "market-cap": { table: "market-cap", col: "", agg: "avg" },
  "miner-rev-usd": { table: "miner-rev-usd", col: "", agg: "sum" },
  // daily_stats.miner_revenue holds atomic XEL; report whole XEL
  "miner-revenue": { table: "daily_stats", col: "miner_revenue", agg: "sum", div: 1e8 },
  "side-blocks": { table: "daily_stats", col: "side_count", agg: "sum" },
  "block-time": { table: "blocks", col: "", agg: "avg" },
  "nakamoto": { table: "daily_miners", col: "nakamoto", agg: "avg" },
  gini: { table: "daily_miners", col: "gini", agg: "avg" },
  "encrypted": { table: "tx_encrypted", col: "", agg: "avg" },
  "block-types": { table: "daily_block_types", col: "count", agg: "sum" },
  // transaction-type breakdown, computed from tx_index (col = tx_type value)
  "txs-transfer": { table: "tx-type", col: "transfer", agg: "sum" },
  "txs-burn": { table: "tx-type", col: "burn", agg: "sum" },
  "txs-invoke": { table: "tx-type", col: "invoke_contract", agg: "sum" },
  "txs-deploy": { table: "tx-type", col: "deploy_contract", agg: "sum" },
  "txs-multisig": { table: "tx-type", col: "multisig", agg: "sum" },
  // every transaction type at once, keyed "<bucket>-<type>" like block-types
  "tx-types": { table: "tx-type", col: "all", agg: "sum" },
  // contract activity (daily_contracts aggregate; active count is distinct)
  "contract-invokes": { table: "daily_contracts", col: "invoke_count", agg: "sum" },
  "contract-gas": { table: "daily_contracts", col: "gas_burned", agg: "sum" },
  "contract-deploys": { table: "daily_contracts", col: "deploys", agg: "sum" },
  "active-contracts": { table: "contract-activity", col: "", agg: "avg" },
  "price": { table: "market_snapshots", col: "last", agg: "avg" },
  // market snapshots hold a rolling 24h quote volume, so this metric averages
  // per exchange across the bucket before summing exchanges (see below); the
  // raw per-snapshot sum would multiply the window by the snapshot count.
  "quote-volume": { table: "market_snapshots", col: "quote_volume", agg: "avg" },
  "mempool": { table: "mempool_snapshots", col: "size", agg: "avg" },
  "chain-size": { table: "chain_size_snapshots", col: "size_bytes", agg: "avg" },
  "peers": { table: "peer_snapshots", col: "total", agg: "avg" },
  "peers-hidden": { table: "peer_snapshots", col: "hidden", agg: "avg" },
  "peers-pruned": { table: "peer_snapshots", col: "pruned", agg: "avg" },
  "peers-lagging": { table: "peer_snapshots", col: "lagging", agg: "avg" },
  "peers-stale": { table: "peer_snapshots", col: "stale", agg: "avg" },
  "peers-divergent": { table: "peer_snapshots", col: "divergent", agg: "avg" },
  "peers-new": { table: "peer_snapshots", col: "new_conns", agg: "avg" },
  "peer-lag": { table: "peer_snapshots", col: "avg_lag", agg: "avg" },
  "peer-view": { table: "peer_snapshots", col: "avg_peer_view", agg: "avg" },
  "peer-age": { table: "peer_snapshots", col: "avg_conn_age", agg: "avg" },
  "peer-traffic-in": { table: "peer_snapshots", col: "bytes_recv", agg: "avg" },
  "peer-traffic-out": { table: "peer_snapshots", col: "bytes_sent", agg: "avg" },
};

function rangeToDays(range: string): number {
  if (range === "all") return Number.POSITIVE_INFINITY;
  const m = /^(\d+)([dmy])$/.exec(range);
  if (!m) return 90;
  const n = Number(m[1]);
  return m[2] === "d" ? n : m[2] === "m" ? n * 30 : n * 365;
}

function dateFrom(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 10);
}

function parseDateParam(v: string | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// Conditions over an ms `ts` column: skip corrupt ts=0 rows, then bound by the
// requested period. `until` is inclusive of its whole day.
function tsConds(since: string | null, until: string | null): { conds: string[]; binds: (string | number)[] } {
  const conds = ["ts > 0"];
  const binds: (string | number)[] = [];
  if (since) { conds.push("ts >= ?"); binds.push(Date.parse(since)); }
  if (until) { conds.push("ts < ?"); binds.push(Date.parse(until) + 86400_000); }
  return { conds, binds };
}

// Monday-based week bucket matching SQLite strftime('%Y-W%W'): week 01 starts
// on the year's first Monday, and days before it are week 00. Computing the
// index from the week's Monday instead yields a negative week for the partial
// week around New Year ("2026-W-1"), a label the chart can't parse as a date;
// it then falls back to the array index, injecting a 1970 x-value that draws
// bogus straight lines across the chart. Clamping to the %W scheme keeps the
// label two-digit and monotonic across the year boundary.
function weekBucket(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const doy = Math.floor((Date.UTC(year, d.getUTCMonth(), d.getUTCDate()) - jan1) / 86400_000);
  const jan1MondayIdx = (new Date(jan1).getUTCDay() + 6) % 7;
  const firstMondayDoy = (7 - jan1MondayIdx) % 7;
  const week = doy < firstMondayDoy ? 0 : Math.floor((doy - firstMondayDoy) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// Gini coefficient of a set of non-negative values (0 = perfectly even,
// 1 = fully concentrated). Used for block-production concentration.
function gini(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const x = [...values].sort((a, b) => a - b);
  const sum = x.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  let cum = 0;
  for (let i = 0; i < n; i++) cum += (i + 1) * x[i];
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

history.get("/api/history/:metric", async (c) => {
  const metric = c.req.param("metric");
  const spec = METRICS[metric];
  if (!spec) return c.json({ error: `unknown metric '${metric}'`, available: Object.keys(METRICS) }, 404);

  const range = c.req.query("range") ?? "90d";
  const interval = c.req.query("interval") ?? "day";
  const format = c.req.query("format") ?? "json";
  const from = parseDateParam(c.req.query("from"));
  const to = parseDateParam(c.req.query("to"));
  const days = rangeToDays(range);
  // custom period (from/to) takes precedence over the relative range
  const since = from ?? (Number.isFinite(days) ? dateFrom(days) : null);
  const until = to;
  const exchange = (c.req.query("exchange") ?? "").slice(0, 64);
  const agg = spec.agg ?? "avg";

  // date bucket format by interval
  const bucket = interval === "day" ? "date" : interval === "week" ? "strftime('%Y-W%W', date)" : interval === "month" ? "substr(date,1,7)" : "substr(date,1,4)";
  const bucketTs = interval === "day" ? "date(ts/1000, 'unixepoch')" : interval === "week" ? "strftime('%Y-W%W', ts/1000, 'unixepoch')" : interval === "month" ? "strftime('%Y-%m', ts/1000, 'unixepoch')" : "strftime('%Y', ts/1000, 'unixepoch')";

  let rows: { bucket: string; value: number }[] = [];

  // Computed metrics (no stored column): derived from base tables.
  if (spec.table === "blocks") {
    try {
      const conds: string[] = [];
      const binds: (string | number)[] = [];
      if (since) { conds.push("ts >= ?"); binds.push(Date.parse(since)); }
      if (until) { conds.push("ts < ?"); binds.push(Date.parse(until!) + 86400_000); }
      const whereTs = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      rows = await c.env.DB.prepare(
        `SELECT ${bucketTs} bucket, (MAX(ts) - MIN(ts)) / 1000.0 / NULLIF(COUNT(*) - 1, 0) value FROM blocks ${whereTs} GROUP BY bucket ORDER BY bucket`
      ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
    } catch { rows = []; }
  } else if (spec.table === "difficulty" || spec.table === "cum-difficulty") {
    // Per-bucket average network difficulty, or the chain's cumulative
    // difficulty (monotonic, so merged across shards by max, not sum).
    try {
      const { conds, binds } = tsConds(since, until);
      const where = `WHERE ${conds.join(" AND ")}`;
      if (spec.table === "cum-difficulty") {
        const raw = await mergeGroups(
          c.env,
          `SELECT ${bucketTs} bucket, MAX(CAST(cum_difficulty AS REAL)) value FROM blocks ${where} GROUP BY bucket`,
          binds, "bucket", [], ["value"],
        );
        rows = raw.map((r) => ({ bucket: String(r.bucket), value: Number(r.value) }));
      } else {
        const raw = await mergeGroups(
          c.env,
          `SELECT ${bucketTs} bucket, SUM(difficulty) s, COUNT(*) n FROM blocks ${where} GROUP BY bucket`,
          binds, "bucket", ["s", "n"],
        );
        rows = raw.map((r) => ({ bucket: String(r.bucket), value: Number(r.s) / Math.max(1, Number(r.n)) }));
      }
    } catch { rows = []; }
  } else if (spec.table === "tx-type") {
    // Bucketed counts from tx_index: one type per point, or all types keyed
    // "<bucket>-<type>" for the combined tx-types series.
    try {
      const { conds, binds } = tsConds(since, until);
      if (spec.col === "all") {
        const raw = await mergeGroups(
          c.env,
          `SELECT ${bucketTs} || '-' || tx_type bucket, COUNT(*) n FROM tx_index WHERE ${conds.join(" AND ")} GROUP BY bucket, tx_type`,
          binds, "bucket", ["n"],
        );
        rows = raw.map((r) => ({ bucket: String(r.bucket), value: Number(r.n) }));
      } else {
        const raw = await mergeGroups(
          c.env,
          `SELECT ${bucketTs} bucket, COUNT(*) n FROM tx_index WHERE tx_type = ? AND ${conds.join(" AND ")} GROUP BY bucket`,
          [spec.col, ...binds], "bucket", ["n"],
        );
        rows = raw.map((r) => ({ bucket: String(r.bucket), value: Number(r.n) }));
      }
    } catch { rows = []; }
  } else if (spec.table === "daily_miners") {
    try {
      // nakamoto: minimum set of miners covering >50% of a day's blocks.
      // gini: block-production concentration (0 = even, 1 = concentrated).
      const conds: string[] = [];
      const binds: string[] = [];
      if (since) { conds.push("date >= ?"); binds.push(since); }
      if (until) { conds.push("date <= ?"); binds.push(until); }
      const whereDate = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const raw = await c.env.DB.prepare(
        `SELECT date, blocks_found FROM daily_miners ${whereDate}`
      ).bind(...binds).all<{ date: string; blocks_found: number }>().then((r) => r.results ?? []);
      const perDay = new Map<string, number[]>();
      for (const r of raw) {
        const list = perDay.get(r.date) ?? [];
        list.push(r.blocks_found);
        perDay.set(r.date, list);
      }
      const isGini = spec.col === "gini";
      const groupKey = interval === "day" ? (d: string) => d : interval === "week" ? (d: string) => weekBucket(d) : interval === "month" ? (d: string) => d.slice(0, 7) : (d: string) => d.slice(0, 4);
      const buckets = new Map<string, number[]>();
      for (const d of [...perDay.keys()].sort()) {
        const shares = perDay.get(d) ?? [];
        const total = shares.reduce((a, b) => a + b, 0);
        if (total <= 0) continue;
        let v: number;
        if (isGini) {
          v = gini(shares);
        } else {
          const sorted = [...shares].sort((a, b) => b - a);
          let acc = 0;
          let n = 0;
          for (const s of sorted) { acc += s; n += 1; if (acc > total / 2) break; }
          v = n;
        }
        const k = groupKey(d);
        const list = buckets.get(k) ?? [];
        list.push(v);
        buckets.set(k, list);
      }
      rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bk, vals]) => ({
        bucket: bk,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
      }));
    } catch { rows = []; }
  } else if (spec.table === "tx_transfers") {
    try {
      const conds = ["ts > 0"];
      const binds: (string | number)[] = [];
      if (since) { conds.push("ts >= ?"); binds.push(Date.parse(since)); }
      if (until) { conds.push("ts < ?"); binds.push(Date.parse(until) + 86400_000); }
      rows = await c.env.DB.prepare(
        `SELECT ${bucketTs} bucket, SUM(transfer_count) value FROM tx_index WHERE ${conds.join(" AND ")} GROUP BY bucket ORDER BY bucket`
      ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
    } catch { rows = []; }
  } else if (spec.table === "tx_encrypted") {
    try {
      const conds = ["ts > 0"];
      const binds: (string | number)[] = [];
      if (since) { conds.push("ts >= ?"); binds.push(Date.parse(since)); }
      if (until) { conds.push("ts < ?"); binds.push(Date.parse(until) + 86400_000); }
      rows = await c.env.DB.prepare(
        `SELECT ${bucketTs} bucket, SUM(encrypted) * 100.0 / COUNT(*) value FROM tx_index WHERE ${conds.join(" AND ")} GROUP BY bucket ORDER BY bucket`
      ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
    } catch { rows = []; }
  } else if (spec.table === "fee-percentile") {
    try {
      // nearest-rank percentile of tx fees per bucket
      const rank = spec.col === "p90"
        ? "CASE WHEN CAST(cnt * 0.9 AS INTEGER) < 1 THEN 1 ELSE CAST(cnt * 0.9 AS INTEGER) END"
        : spec.col === "p99"
          ? "CASE WHEN CAST(cnt * 0.99 AS INTEGER) < 1 THEN 1 ELSE CAST(cnt * 0.99 AS INTEGER) END"
          : "CASE WHEN cnt < 2 THEN 1 ELSE (cnt + 1) / 2 END";
      const conds = ["ts > 0"];
      const binds: (string | number)[] = [];
      if (since) { conds.push("ts >= ?"); binds.push(Date.parse(since)); }
      if (until) { conds.push("ts < ?"); binds.push(Date.parse(until) + 86400_000); }
      rows = await c.env.DB.prepare(
        `SELECT bucket, value FROM (
           SELECT ${bucketTs} bucket, fee value,
             ROW_NUMBER() OVER (PARTITION BY ${bucketTs} ORDER BY fee) rn,
             COUNT(*) OVER (PARTITION BY ${bucketTs}) cnt
           FROM tx_index WHERE ${conds.join(" AND ")}
         ) WHERE rn = ${rank} ORDER BY bucket`
      ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
    } catch { rows = []; }
  } else if (spec.table === "supply-stored") {
    // cumulative supply lives in daily_stats in atomic units; report whole XEL
    try {
      const conds: string[] = [];
      const binds: string[] = [];
      if (since) { conds.push("date >= ?"); binds.push(since); }
      if (until) { conds.push("date <= ?"); binds.push(until); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      rows = await c.env.DB.prepare(
        `SELECT ${bucket} bucket, ${agg}(${spec.col}) / 1e8 value FROM daily_stats ${where} GROUP BY bucket ORDER BY bucket`
      ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
    } catch { rows = []; }
  } else if (spec.table === "market-cap") {
    // circulating supply (daily_stats, cumulative) valued at that day's average
    // market price; days without price coverage are omitted.
    try {
      const conds: string[] = [];
      const binds: string[] = [];
      if (since) { conds.push("date >= ?"); binds.push(since); }
      if (until) { conds.push("date <= ?"); binds.push(until); }
      const whereDate = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const circ = await c.env.DB.prepare(
        `SELECT date, circulating_supply FROM daily_stats ${whereDate} ORDER BY date`
      ).bind(...binds).all<{ date: string; circulating_supply: number }>().then((r) => r.results ?? []);
      if (!circ.length) throw new Error("no supply rows");
      const snaps = await c.env.DB.prepare(
        `SELECT date(ts/1000, 'unixepoch') d, AVG(last) p FROM market_snapshots WHERE date(ts/1000, 'unixepoch') >= ? AND date(ts/1000, 'unixepoch') <= ? GROUP BY d`
      ).bind(circ[0].date, circ[circ.length - 1].date).all<{ d: string; p: number }>().then((r) => r.results ?? []);
      const prices = new Map<string, number>();
      for (const s of snaps) if (s.p) prices.set(s.d, Number(s.p));
      const groupKey = interval === "day" ? (d: string) => d : interval === "week" ? (d: string) => weekBucket(d) : interval === "month" ? (d: string) => d.slice(0, 7) : (d: string) => d.slice(0, 4);
      const buckets = new Map<string, number[]>();
      for (const r of circ) {
        const p = prices.get(r.date);
        if (!p || !r.circulating_supply) continue;
        const k = groupKey(r.date);
        const list = buckets.get(k) ?? [];
        list.push((Number(r.circulating_supply) / 1e8) * p);
        buckets.set(k, list);
      }
      rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bk, vals]) => ({
        bucket: bk,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
      }));
    } catch { rows = []; }
  } else if (spec.table === "miner-rev-usd") {
    // daily miner revenue (atomic XEL) valued at that day's average market price
    try {
      const conds: string[] = [];
      const binds: string[] = [];
      if (since) { conds.push("date >= ?"); binds.push(since); }
      if (until) { conds.push("date <= ?"); binds.push(until); }
      const whereDate = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const rev = await c.env.DB.prepare(
        `SELECT date, miner_revenue FROM daily_stats ${whereDate}`
      ).bind(...binds).all<{ date: string; miner_revenue: number }>().then((r) => r.results ?? []);
      const prices = new Map<string, number>();
      if (rev.length) {
        const snaps = await c.env.DB.prepare(
          `SELECT date(ts/1000, 'unixepoch') d, AVG(last) p FROM market_snapshots WHERE date(ts/1000, 'unixepoch') >= ? AND date(ts/1000, 'unixepoch') <= ? GROUP BY d`
        ).bind(rev[0].date, rev[rev.length - 1].date).all<{ d: string; p: number }>().then((r) => r.results ?? []);
        for (const s of snaps) if (s.p) prices.set(s.d, s.p);
      }
      rows = rev.flatMap((r) => {
        const p = prices.get(r.date);
        if (!p || !r.miner_revenue) return [];
        return [{ bucket: r.date, value: (r.miner_revenue / 1e8) * p }];
      });
    } catch { rows = []; }
  } else if (spec.table === "hashprice") {
    // Daily miner revenue (USD) divided by the estimated hashrate, scaled to
    // USD per TH/s per day. Uses the same hashrate estimate as the hashrate
    // chart, so the two stay consistent.
    try {
      const conds: string[] = [];
      const binds: (string | number)[] = [];
      if (since) { conds.push("date >= ?"); binds.push(since); }
      if (until) { conds.push("date <= ?"); binds.push(until); }
      const whereDate = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      const daily = await c.env.DB.prepare(
        `SELECT date, miner_revenue, hashrate FROM daily_stats ${whereDate} ORDER BY date`
      ).bind(...binds).all<{ date: string; miner_revenue: number; hashrate: number }>().then((r) => r.results ?? []);
      if (!daily.length) throw new Error("no daily rows");
      const snaps = await c.env.DB.prepare(
        `SELECT date(ts/1000, 'unixepoch') d, AVG(last) p FROM market_snapshots WHERE date(ts/1000, 'unixepoch') >= ? AND date(ts/1000, 'unixepoch') <= ? GROUP BY d`
      ).bind(daily[0].date, daily[daily.length - 1].date).all<{ d: string; p: number }>().then((r) => r.results ?? []);
      const prices = new Map<string, number>();
      for (const s of snaps) if (s.p) prices.set(s.d, Number(s.p));
      const groupKey = interval === "day" ? (d: string) => d : interval === "week" ? (d: string) => weekBucket(d) : interval === "month" ? (d: string) => d.slice(0, 7) : (d: string) => d.slice(0, 4);
      const buckets = new Map<string, number[]>();
      for (const r of daily) {
        const p = prices.get(r.date);
        const hr = Number(r.hashrate);
        const rev = Number(r.miner_revenue);
        if (!p || !hr || !rev) continue;
        const k = groupKey(r.date);
        const list = buckets.get(k) ?? [];
        list.push((rev / 1e8) * p / hr * 1e12);
        buckets.set(k, list);
      }
      rows = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bk, vals]) => ({
        bucket: bk,
        value: vals.reduce((a, b) => a + b, 0) / vals.length,
      }));
    } catch { rows = []; }
  } else if (spec.table === "contract-activity") {
    // Distinct contracts active per bucket, from the daily_contracts rollup.
    try {
      const conds: string[] = [];
      const binds: (string | number)[] = [];
      if (since) { conds.push("date >= ?"); binds.push(since); }
      if (until) { conds.push("date <= ?"); binds.push(until); }
      const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
      rows = await c.env.DB.prepare(
        `SELECT ${bucket} bucket, COUNT(DISTINCT contract_id) value FROM daily_contracts ${where} GROUP BY bucket ORDER BY bucket`
      ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
    } catch { rows = []; }
  } else {
    try {
      if (spec.table === "market_snapshots" && metric === "quote-volume") {
        // Every snapshot stores a *rolling 24h* quote volume, and the cron runs
        // every 2 min (~720 rows/day/exchange). Summing raw snapshots would
        // multiply the window by the snapshot count, so instead average each
        // exchange's volume over the bucket, then sum across exchanges to get
        // the bucket's mean cross-exchange 24h volume.
        const conds: string[] = [];
        const binds: (string | number)[] = [];
        if (from) {
          conds.push("ts >= ?");
          binds.push(Date.parse(from));
        } else if (Number.isFinite(days)) {
          conds.push("ts > ?");
          binds.push(Date.now() - days * 86400_000);
        }
        if (until) {
          conds.push("ts < ?");
          binds.push(Date.parse(to!) + 86400_000);
        }
        if (exchange) {
          conds.push("exchange = ?");
          binds.push(exchange);
        }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        if (exchange) {
          rows = await c.env.DB.prepare(
            `SELECT ${bucketTs} bucket, AVG(${spec.col}) value FROM market_snapshots ${where} GROUP BY bucket ORDER BY bucket`
          ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
        } else {
          rows = await c.env.DB.prepare(
            `SELECT bucket, SUM(value) value FROM (
               SELECT ${bucketTs} bucket, AVG(${spec.col}) value FROM market_snapshots ${where} GROUP BY bucket, exchange
             ) GROUP BY bucket ORDER BY bucket`
          ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
        }
      } else if (spec.table === "market_snapshots" || spec.table === "mempool_snapshots" || spec.table === "peer_snapshots" || spec.table === "chain_size_snapshots") {
        const conds: string[] = [];
        const binds: (string | number)[] = [];
        if (from) {
          conds.push("ts >= ?");
          binds.push(Date.parse(from));
        } else if (Number.isFinite(days)) {
          conds.push("ts > ?");
          binds.push(Date.now() - days * 86400_000);
        }
        if (until) {
          conds.push("ts < ?");
          binds.push(Date.parse(to!) + 86400_000);
        }
        if (exchange && spec.table === "market_snapshots") {
          conds.push("exchange = ?");
          binds.push(exchange);
        }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        rows = await c.env.DB.prepare(
          `SELECT ${bucketTs} bucket, ${agg}(${spec.col}) value FROM ${spec.table} ${where} GROUP BY bucket ORDER BY bucket`
        ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
      } else if (spec.table === "daily_block_types") {
        const conds: string[] = [];
        const binds: string[] = [];
        if (since) { conds.push("date >= ?"); binds.push(since); }
        if (until) { conds.push("date <= ?"); binds.push(until); }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        rows = await c.env.DB.prepare(
          `SELECT date || '-' || block_type bucket, count value FROM daily_block_types ${where} ORDER BY date, block_type`
        ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
      } else {
        const conds: string[] = [];
        const binds: string[] = [];
        if (since) { conds.push("date >= ?"); binds.push(since); }
        if (until) { conds.push("date <= ?"); binds.push(until); }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        rows = await c.env.DB.prepare(
          `SELECT ${bucket} bucket, ${agg}(${spec.col}) value FROM ${spec.table} ${where} GROUP BY bucket ORDER BY bucket`
        ).bind(...binds).all<{ bucket: string; value: number }>().then((r) => r.results ?? []);
      }
    } catch {
      // D1 not imported yet — empty series
      rows = [];
    }
  }

  // metrics stored in atomic units are reported in whole XEL
  if (spec.div && spec.div !== 1) {
    rows = rows.map((r) => ({ bucket: r.bucket, value: Number(r.value) / spec.div! }));
  }

  if (format === "csv") {
    const periodLabel = from || to ? `${from ?? "start"}_${to ?? "latest"}` : range;
    const exLabel = exchange ? `-${exchange}` : "";
    const csv = ["bucket,value", ...rows.map((r) => `${r.bucket},${r.value}`)].join("\n");
    return c.body(csv, 200, { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="${metric}${exLabel}-${periodLabel}.csv"` });
  }

  return c.json({
    metric,
    interval,
    range,
    ...(exchange ? { exchange } : {}),
    points: rows.map((r) => ({ date: r.bucket, value: Number(r.value) })),
  });
});
