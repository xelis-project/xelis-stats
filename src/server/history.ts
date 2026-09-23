import { Hono } from "hono";
import type { Env } from "./app";

export const history = new Hono<{ Bindings: Env }>();

// Metric -> (column, table, aggregation across buckets)
const METRICS: Record<string, { table: string; col: string; agg?: "sum" | "avg" }> = {
  txs: { table: "daily_stats", col: "tx_count", agg: "sum" },
  transfers: { table: "daily_stats", col: "transfer_count", agg: "sum" },
  "transfer-volume": { table: "daily_stats", col: "transfer_volume", agg: "sum" },
  accounts: { table: "daily_stats", col: "new_accounts", agg: "sum" },
  "active-accounts": { table: "daily_stats", col: "active_accounts", agg: "avg" },
  miners: { table: "daily_stats", col: "unique_miners", agg: "avg" },
  hashrate: { table: "daily_stats", col: "hashrate", agg: "avg" },
  fees: { table: "daily_stats", col: "avg_fee", agg: "avg" },
  "fees-median": { table: "daily_stats", col: "median_fee", agg: "avg" },
  "fee-p90": { table: "daily_stats", col: "fee_p90", agg: "avg" },
  "fees-p99": { table: "daily_stats", col: "fee_p99", agg: "avg" },
  supply: { table: "daily_stats", col: "circulating_supply", agg: "avg" },
  "burned-supply": { table: "daily_stats", col: "burned_supply", agg: "avg" },
  "market-cap": { table: "daily_stats", col: "market_cap_usd", agg: "avg" },
  "tx-volume-usd": { table: "daily_stats", col: "tx_volume_usd", agg: "sum" },
  "miner-rev-usd": { table: "daily_stats", col: "miner_rev_usd", agg: "sum" },
  "miner-revenue": { table: "daily_stats", col: "miner_revenue", agg: "sum" },
  orphans: { table: "daily_stats", col: "orphan_count", agg: "sum" },
  "block-time": { table: "daily_stats", col: "avg_block_time", agg: "avg" },
  "nakamoto": { table: "daily_stats", col: "nakamoto_coef", agg: "avg" },
  gini: { table: "daily_stats", col: "block_prod_gini", agg: "avg" },
  "encrypted": { table: "daily_stats", col: "encrypted_tx_pct", agg: "avg" },
  "block-types": { table: "daily_block_types", col: "count", agg: "sum" },
  "price": { table: "market_snapshots", col: "last", agg: "avg" },
  "quote-volume": { table: "market_snapshots", col: "quote_volume", agg: "sum" },
  "mempool": { table: "mempool_snapshots", col: "size", agg: "avg" },
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

  let rows: { bucket: string; value: number }[] = [];
  try {
    if (spec.table === "market_snapshots" || spec.table === "mempool_snapshots" || spec.table === "peer_snapshots") {
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
      const bucketTs = interval === "day" ? "date(ts/1000, 'unixepoch')" : interval === "week" ? "strftime('%Y-W%W', ts/1000, 'unixepoch')" : interval === "month" ? "strftime('%Y-%m', ts/1000, 'unixepoch')" : "strftime('%Y', ts/1000, 'unixepoch')";
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
        `SELECT date || '-' || block_type bucket, count value FROM daily_block_types ${where} ORDER BY date`
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
