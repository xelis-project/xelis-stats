import type { Env } from "./app";
import { fetchAllTickers, aggregate } from "./market/sources";
import { rpc } from "./xelis";

/**
 * Cron: every 2 min — market snapshot + mempool snapshot.
 * Cron: hourly — node versions + peer count snapshot.
 */
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
  try {
    const info = await rpc<{ mempool_size: number }>("get_info", undefined, env.XELIS_NODE);
    await env.DB.prepare("INSERT OR REPLACE INTO mempool_snapshots (ts, size) VALUES (?, ?)")
      .bind(Date.now(), info.mempool_size).run();
    // rollupDailyStats binds 10 date params below
  } catch (err) {
    console.error("mempool cron:", (err as Error).message);
  }

  // hourly tasks (single cron schedule; use minute to distinguish — run when minute === 0)
  const minute = new Date().getUTCMinutes();
  if (minute === 0) {
    try {
      const peers = await rpc<Array<{ version?: string }>>("get_peers", undefined, env.XELIS_NODE).catch(() => [] as Array<{ version?: string }>);
      const versions = new Map<string, number>();
      for (const p of peers) {
        const v = p.version ?? "unknown";
        versions.set(v, (versions.get(v) ?? 0) + 1);
      }
      const date = new Date().toISOString().slice(0, 10);
      const stmts = [...versions.entries()].map(([version, count]) =>
        env.DB.prepare("INSERT OR REPLACE INTO node_versions (date, version, peer_count) VALUES (?, ?, ?)").bind(date, version, count)
      );
      if (stmts.length) await env.DB.batch(stmts);
    } catch (err) {
      console.error("peers cron:", (err as Error).message);
    }

    // daily rollup: recompute today's (and yesterday's) daily_stats row from D1
    await rollupDailyStats(env, new Date().toISOString().slice(0, 10));
    await rollupDailyStats(env, new Date(Date.now() - 86400_000).toISOString().slice(0, 10));
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
        (SELECT SUM(miner_reward+dev_reward) FROM blocks WHERE date(ts/1000,'unixepoch') = ?) AS miner_revenue
    `).bind(date, date, date, date, date, date, date, date, date, date).first<Record<string, unknown>>();

    if (!row || (row.tx_count === 0 && row.active_accounts === 0 && (row.miner_revenue ?? 0) === 0)) return;

    await env.DB.prepare(`INSERT OR REPLACE INTO daily_stats
      (date, active_accounts, new_accounts, tx_count, avg_fee, transfer_count, hashrate, unique_miners, orphan_count, fee_total_sum, miner_revenue)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        active_accounts = excluded.active_accounts, new_accounts = excluded.new_accounts,
        tx_count = excluded.tx_count, avg_fee = excluded.avg_fee, transfer_count = excluded.transfer_count,
        hashrate = excluded.hashrate, unique_miners = excluded.unique_miners, orphan_count = excluded.orphan_count,
        fee_total_sum = excluded.fee_total_sum, miner_revenue = excluded.miner_revenue`)
      .bind(date, row.active_accounts, row.new_accounts, row.tx_count, row.avg_fee, row.transfer_count, row.hashrate, row.unique_miners, row.orphan_count, row.fee_total_sum, row.miner_revenue).run();
  } catch (err) {
    console.error("rollupDailyStats:", (err as Error).message);
  }
}
