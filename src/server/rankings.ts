import { Hono } from "hono";
import type { Env } from "./app";
import { knownEntity } from "./entities";

export const top = new Hono<{ Bindings: Env }>();

type Period = "day" | "week" | "month" | "all";

const DAY_TABLE: Record<string, string> = {
  miners: "daily_miners",
  senders: "daily_address_stats",
  burners: "daily_address_stats",
  assets: "daily_assets",
  contracts: "daily_contracts",
};

// Latest day that actually has rollup data, so rankings stay populated
// while live indexing lags behind "today".
async function latestDataDay(env: Env, kind: string): Promise<string> {
  try {
    const row = await env.DB.prepare(`SELECT MAX(date) AS d FROM ${DAY_TABLE[kind] ?? "daily_stats"}`).first<{ d: string | null }>();
    if (row?.d) return row.d;
  } catch { /* db not ready */ }
  return new Date().toISOString().slice(0, 10);
}

function whereFor(period: Period, date: string | null): { dim: string; binds: unknown[] } {
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  if (period === "all") return { dim: "", binds: [] };
  if (period === "day") return { dim: "WHERE date = ?", binds: [date || today] };
  if (period === "week") return { dim: "WHERE date > date(?, '-7 days')", binds: [date || today] };
  return { dim: "WHERE date LIKE ? || '%'", binds: [date || thisMonth] };
}

const QUERIES: Record<string, (dim: string) => string> = {
  miners: (dim) => `SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards FROM daily_miners ${dim} GROUP BY address ORDER BY blocks DESC`,
  senders: (dim) => `SELECT address, SUM(tx_count) tx_count, SUM(transfer_outputs) transfer_outputs FROM daily_address_stats ${dim} GROUP BY address ORDER BY tx_count DESC`,
  burners: (dim) => `SELECT address, SUM(burned) burned FROM daily_address_stats ${dim} GROUP BY address ORDER BY burned DESC`,
  assets: (dim) => `SELECT da.asset_id, a.symbol, SUM(da.tx_count) tx_count, SUM(da.transfer_count) transfers FROM daily_assets da LEFT JOIN assets a ON a.asset_id = da.asset_id ${dim ? dim.replace("WHERE", "WHERE da.") : ""} GROUP BY da.asset_id ORDER BY tx_count DESC`,
  contracts: (dim) => `SELECT contract_id, SUM(invoke_count) invokes, SUM(gas_burned) gas FROM daily_contracts ${dim} GROUP BY contract_id ORDER BY invokes DESC`,
};

top.get("/api/top/:kind", async (c) => {
  const kind = c.req.param("kind");
  const builder = QUERIES[kind];
  if (!builder) {
    return c.json({ error: `unknown kind '${kind}'`, available: Object.keys(QUERIES) }, 404);
  }
  const periodParam = c.req.query("period") ?? "day";
  const period: Period = (["day", "week", "month", "all"].includes(periodParam) ? periodParam : "day") as Period;
  const requested = c.req.query("date") ?? null;
  const date = requested ?? (period === "all" ? null : await latestDataDay(c.env, kind));
  const { dim, binds } = whereFor(period, date);
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = await c.env.DB.prepare(`${builder(dim)} LIMIT ?`).bind(...binds, limit).all().then((r) => r.results);
    const tagged = rows.map((row) => {
      const addr = (row as Record<string, unknown>).address;
      const e = typeof addr === "string" ? knownEntity(addr) : undefined;
      return e ? { ...row, label: e.label, kind: e.kind } : row;
    });
    return c.json({ kind, period, date, rows: tagged });
  } catch (err) {
    return c.json({ error: "rollup data not available", detail: (err as Error).message }, 503);
  }
});