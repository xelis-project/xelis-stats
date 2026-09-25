import { Hono } from "hono";
import type { Env } from "./app";
import { parseSort, BLOCK_COLS, TX_COLS, ACCT_COLS } from "./sort";
import { knownEntity } from "./entities";
import { fetchBlock, fetchTx, pagedRaw } from "./shards";
import { clampInt } from "./pages/shared";

export { clampInt };

type Row = Record<string, unknown>;

function logErr(scope: string, err: unknown): void {
  console.error(`${scope}:`, err instanceof Error ? err.message : String(err));
}

export function tagAddress(row: Row, key: string): Row {
  const addr = row[key];
  const e = typeof addr === "string" ? knownEntity(addr) : undefined;
  return e ? { ...row, label: e.label, kind: e.kind } : row;
}

export const api = new Hono<{ Bindings: Env }>();

api.get("/api/blocks", async (c) => {
  const before = Number(c.req.query("before") ?? 0);
  const limit = clampInt(c.req.query("limit"), 25, 100);
  // optional block type filter, case-insensitive ("Normal"|"Side"|"Sync")
  const type = (c.req.query("type") ?? "").slice(0, 16);
  try {
    const sorted = c.req.query("sort") !== undefined && Object.hasOwn(BLOCK_COLS, c.req.query("sort")!);
    let sql: string;
    let binds: (number | string)[];
    if (sorted) {
      const { order } = parseSort((n) => c.req.query(n), BLOCK_COLS, "topo", "topoheight");
      sql = `SELECT * FROM blocks ${type ? "WHERE UPPER(block_type) = UPPER(?)" : ""} ORDER BY ${order} LIMIT ?`;
      binds = [...(type ? [type] : []), limit];
      const rows = await c.env.DB.prepare(sql).bind(...binds).all().then((r) => r.results);
      return c.json({ blocks: (rows as Row[]).map((r) => tagAddress(r, "miner_address")) });
    }
    // default topo-desc path walks the hot window and sealed shards
    const rows = await pagedRaw(c.env, {
      table: "blocks",
      cursorCol: "topoheight",
      select: "*",
      before,
      limit,
      extra: type ? { sql: "UPPER(block_type) = UPPER(?)", binds: [type] } : undefined,
    });
    return c.json({ blocks: rows.map((r) => tagAddress(r, "miner_address")) });
  } catch (err) {
    logErr("api/blocks", err);
    return c.json({ blocks: [] }, 503);
  }
});

api.get("/api/block/:id", async (c) => {
  try {
    const found = await fetchBlock(c.env, c.req.param("id"));
    if (!found) return c.json({ error: "not found" }, 404);
    return c.json(tagAddress(found.row, "miner_address"));
  } catch (err) {
    logErr("api/block", err);
    return c.json({ error: "not found" }, 404);
  }
});

api.get("/api/tx/:hash", async (c) => {
  try {
    const found = await fetchTx(c.env, c.req.param("hash"));
    if (!found) return c.json({ error: "not found" }, 404);
    return c.json(tagAddress(found.row, "sender"));
  } catch (err) {
    logErr("api/tx", err);
    return c.json({ error: "not found" }, 404);
  }
});

api.get("/api/transactions", async (c) => {
  const before = Number(c.req.query("before") ?? 0);
  const limit = clampInt(c.req.query("limit"), 25, 100);
  const type = (c.req.query("type") ?? "").slice(0, 32);
  // explicit ?sort= runs over the full dataset (cursor pagination is topo-only)
  const sorted = c.req.query("sort") !== undefined && Object.hasOwn(TX_COLS, c.req.query("sort")!);
  try {
    let sql: string;
    let binds: (number | string)[];
    if (sorted) {
      const { order } = parseSort((n) => c.req.query(n), TX_COLS, "block", "hash");
      sql = `SELECT hash, block_topo, ts, fee, size, tx_type, sender, transfer_count, executed FROM tx_index${type ? " WHERE tx_type = ?" : ""} ORDER BY ${order} LIMIT ?`;
      binds = [...(type ? [type] : []), limit];
      const rows = await c.env.DB.prepare(sql).bind(...binds).all().then((r) => r.results);
      return c.json({ transactions: (rows as Row[]).map((r) => tagAddress(r, "sender")) });
    }
    const rows = await pagedRaw(c.env, {
      table: "tx_index",
      cursorCol: "block_topo",
      select: "hash, block_topo, ts, fee, size, tx_type, sender, transfer_count, executed",
      before,
      limit,
      extra: type ? { sql: "tx_type = ?", binds: [type] } : undefined,
    });
    return c.json({ transactions: rows.map((r) => tagAddress(r, "sender")) });
  } catch (err) {
    logErr("api/transactions", err);
    return c.json({ transactions: [] }, 503);
  }
});

api.get("/api/accounts", async (c) => {
  const limit = clampInt(c.req.query("limit"), 25, 100);
  try {
    const order = Object.hasOwn(ACCT_COLS, c.req.query("sort") ?? "")
      ? parseSort((n) => c.req.query(n), ACCT_COLS, "last", "address").order
      : c.req.query("sort") === "txs" ? "tx_count DESC" : "last_active DESC"; // legacy active|txs
    const rows = await c.env.DB.prepare(
      "SELECT address, first_seen, last_active, tx_count FROM accounts ORDER BY " + order + " LIMIT ?"
    ).bind(limit).all().then((r) => r.results);
    return c.json({ accounts: (rows as Row[]).map((r) => tagAddress(r, "address")) });
  } catch (err) {
    logErr("api/accounts", err);
    return c.json({ accounts: [] }, 503);
  }
});

api.get("/api/node-versions", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      "SELECT version, peer_count, pruned_count FROM node_versions WHERE date = (SELECT MAX(date) FROM node_versions) ORDER BY peer_count DESC LIMIT 20"
    ).all().then((r) => r.results);
    return c.json({ versions: rows, total_peers: (rows as Array<{ peer_count: number }>).reduce((sum, r) => sum + (r.peer_count ?? 0), 0) });
  } catch (err) {
    logErr("api/node-versions", err);
    return c.json({ versions: [] }, 503);
  }
});

api.get("/api/peers", async (c) => {
  try {
    const [latest, versions, tags, prefixes, countries] = await Promise.all([
      c.env.DB.prepare("SELECT * FROM peer_snapshots ORDER BY ts DESC LIMIT 1").first<Row>(),
      c.env.DB.prepare(
        "SELECT version, peer_count, pruned_count FROM node_versions WHERE date = (SELECT MAX(date) FROM node_versions) ORDER BY peer_count DESC LIMIT 20"
      ).all().then((r) => r.results),
      c.env.DB.prepare(
        "SELECT tag, peers FROM daily_peer_tags WHERE date = (SELECT MAX(date) FROM daily_peer_tags) ORDER BY peers DESC LIMIT 10"
      ).all().then((r) => r.results),
      c.env.DB.prepare(
        "SELECT prefix, peers FROM daily_peer_prefixes WHERE date = (SELECT MAX(date) FROM daily_peer_prefixes) ORDER BY peers DESC LIMIT 10"
      ).all().then((r) => r.results),
      c.env.DB.prepare(
        "SELECT country, country_code, peers FROM daily_peer_countries WHERE date = (SELECT MAX(date) FROM daily_peer_countries) ORDER BY peers DESC LIMIT 10"
      ).all().then((r) => r.results),
    ]);
    return c.json({
      snapshot: latest ? { ...latest, ts: Number(latest.ts) } : null,
      versions,
      tags,
      prefixes,
      countries,
    });
  } catch (err) {
    logErr("api/peers", err);
    return c.json({ snapshot: null, versions: [], tags: [], prefixes: [], countries: [] }, 503);
  }
});
