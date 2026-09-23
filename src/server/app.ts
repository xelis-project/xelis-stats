import { Hono } from "hono";
import { layout } from "../client/layout";
import { getInfo, rpc, type ChainInfo } from "./xelis";
import { fetchAllTickers, aggregate, type MarketAggregate } from "./market/sources";
import { pages } from "./pages";
import { history } from "./history";
import { misc } from "./misc";
import { handleCron } from "./cron";
import { top } from "./rankings";
import { misc2 } from "./misc2";
import { knownEntity } from "./entities";
import { parseSort, BLOCK_COLS, TX_COLS, ACCT_COLS } from "./sort";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  COLLECTOR: DurableObjectNamespace;
  XELIS_NODE: string;
}

type Row = Record<string, unknown>;

function tagAddress(row: Row, key: string): Row {
  const addr = row[key];
  const e = typeof addr === "string" ? knownEntity(addr) : undefined;
  return e ? { ...row, label: e.label, kind: e.kind } : row;
}

const app = new Hono<{ Bindings: Env }>();

// ---------- rate limiting (per-IP, KV counters) ----------

app.use("/api/*", async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "anon";
  const key = `rl:${ip}:${Math.floor(Date.now() / 60_000)}`; // per-minute window
  const count = Number(await c.env.KV.get(key) ?? 0);
  if (count > 120) {
    return c.json({ error: "rate limit exceeded (120 req/min)" }, 429);
  }
  await c.env.KV.put(key, String(count + 1), { expirationTtl: 120 });
  await next();
});

// ---------- API: blocks (paginated, from D1) ----------

app.get("/api/blocks", async (c) => {
  const before = Number(c.req.query("before") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  // optional block type filter, case-insensitive ("Normal"|"Side"|"Sync")
  const type = (c.req.query("type") ?? "").slice(0, 16);
  const where = type ? `WHERE UPPER(block_type) = UPPER(?)` : "";
  const binds = type ? [type] : [];
  // explicit ?sort= runs over the full dataset (cursor pagination is topo-only)
  const sorted = c.req.query("sort") !== undefined && BLOCK_COLS[c.req.query("sort")!];
  try {
    if (sorted) {
      const { order } = parseSort((n) => c.req.query(n), BLOCK_COLS, "topo", "topoheight DESC");
      const rows = await c.env.DB.prepare(`SELECT * FROM blocks ${where} ORDER BY ${order} LIMIT ?`)
        .bind(...binds, limit).all().then((r) => r.results);
      return c.json({ blocks: (rows as Row[]).map((r) => tagAddress(r, "miner_address")) });
    }
    const conds: string[] = [];
    const cb: (number | string)[] = [];
    if (before > 0) conds.push("topoheight < ?");
    if (before > 0) cb.push(before);
    if (type) { conds.push("UPPER(block_type) = UPPER(?)"); cb.push(type); }
    const cond = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const q = `SELECT * FROM blocks ${cond} ORDER BY topoheight DESC LIMIT ?`;
    const rows = await c.env.DB.prepare(q).bind(...cb, limit).all().then((r) => r.results);
    return c.json({ blocks: (rows as Row[]).map((r) => tagAddress(r, "miner_address")) });
  } catch {
    return c.json({ blocks: [] });
  }
});

app.get("/api/block/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const block = /^\d+$/.test(id)
      ? await c.env.DB.prepare("SELECT * FROM blocks WHERE topoheight = ? OR height = ?").bind(Number(id), Number(id)).first()
      : await c.env.DB.prepare("SELECT * FROM blocks WHERE hash = ?").bind(id).first();
    return c.json(block ? tagAddress(block as Row, "miner_address") : { error: "not found" });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

app.get("/api/tx/:hash", async (c) => {
  try {
    const tx = await c.env.DB.prepare("SELECT * FROM tx_index WHERE hash = ?").bind(c.req.param("hash")).first();
    return c.json(tx ? tagAddress(tx as Row, "sender") : { error: "not found" });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

app.get("/api/transactions", async (c) => {
  const before = Number(c.req.query("before") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  const type = (c.req.query("type") ?? "").slice(0, 32);
  // explicit ?sort= runs over the full dataset (cursor pagination is topo-only)
  const sorted = c.req.query("sort") !== undefined && TX_COLS[c.req.query("sort")!];
  try {
    if (sorted) {
      const { order } = parseSort((n) => c.req.query(n), TX_COLS, "block", "hash");
      const rows = await c.env.DB.prepare(
        `SELECT hash, block_topo, ts, fee, size, tx_type, sender, transfer_count, result FROM tx_index${type ? " WHERE tx_type = ?" : ""} ORDER BY ${order} LIMIT ?`
      ).bind(...(type ? [type] : []), limit).all().then((r) => r.results);
      return c.json({ transactions: (rows as Row[]).map((r) => tagAddress(r, "sender")) });
    }
    const conds: string[] = [];
    const binds: (number | string)[] = [];
    if (before > 0) conds.push("block_topo < ?");
    if (before > 0) binds.push(before);
    if (type) { conds.push("tx_type = ?"); binds.push(type); }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = await c.env.DB.prepare(
      `SELECT hash, block_topo, ts, fee, size, tx_type, sender, transfer_count, result FROM tx_index ${where} ORDER BY block_topo DESC LIMIT ?`
    ).bind(...binds, limit).all().then((r) => r.results);
    return c.json({ transactions: (rows as Row[]).map((r) => tagAddress(r, "sender")) });
  } catch {
    return c.json({ transactions: [] });
  }
});

app.get("/api/accounts", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  try {
    const order = ACCT_COLS[c.req.query("sort") ?? ""]
      ? parseSort((n) => c.req.query(n), ACCT_COLS, "last", "address").order
      : c.req.query("sort") === "txs" ? "tx_count DESC" : "last_active DESC"; // legacy active|txs
    const rows = await c.env.DB.prepare(
      "SELECT address, first_seen, last_active, tx_count FROM accounts ORDER BY " + order + " LIMIT ?"
    ).bind(limit).all().then((r) => r.results);
    return c.json({ accounts: (rows as Row[]).map((r) => tagAddress(r, "address")) });
  } catch {
    return c.json({ accounts: [] });
  }
});

app.get("/api/node-versions", async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      "SELECT version, peer_count, pruned_count FROM node_versions WHERE date = (SELECT MAX(date) FROM node_versions) ORDER BY peer_count DESC LIMIT 20"
    ).all().then((r) => r.results);
    return c.json({ versions: rows, total_peers: (rows as Array<{ peer_count: number }>).reduce((sum, r) => sum + (r.peer_count ?? 0), 0) });
  } catch {
    return c.json({ versions: [] });
  }
});

app.get("/api/peers", async (c) => {
  try {
    const [latest, versions, tags, prefixes] = await Promise.all([
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
    ]);
    return c.json({
      snapshot: latest ? { ...latest, ts: Number(latest.ts) } : null,
      versions,
      tags,
      prefixes,
    });
  } catch {
    return c.json({ snapshot: null, versions: [], tags: [], prefixes: [] });
  }
});

// ---------- helpers ----------

async function getStatsCached(env: Env): Promise<{ info: ChainInfo; txCount: number; accounts: number; assets: number; peers: number }> {
  const cacheKey = "stats:v1";
  const cached = await env.KV.get<{ info: ChainInfo; txCount: number; accounts: number; assets: number; peers: number }>(cacheKey, "json");
  if (cached) return cached;
  const [info, txCount, accounts, assets, peerRow] = await Promise.all([
    getInfo(env.XELIS_NODE),
    rpc<number>("count_transactions", undefined, env.XELIS_NODE).catch(() => -1),
    rpc<number>("count_accounts", undefined, env.XELIS_NODE).catch(() => -1),
    rpc<number>("count_assets", undefined, env.XELIS_NODE).catch(() => -1),
    env.DB.prepare("SELECT total FROM peer_snapshots ORDER BY ts DESC LIMIT 1").first<{ total: number }>().catch(() => null),
  ]);
  const value = { info, txCount, accounts, assets, peers: peerRow?.total ?? 0 };
  await env.KV.put(cacheKey, JSON.stringify(value), { expirationTtl: 60 });
  return value;
}

async function getMarketCached(env: Env): Promise<MarketAggregate | null> {
  const cacheKey = "market:v1";
  const cached = await env.KV.get<MarketAggregate>(cacheKey, "json");
  if (cached) return cached;
  try {
    const tickers = await fetchAllTickers();
    if (!tickers.length) return null;
    const agg = aggregate(tickers);
    await env.KV.put(cacheKey, JSON.stringify(agg), { expirationTtl: 60 });
    return agg;
  } catch {
    return null;
  }
}

// ---------- dashboard (custom, default layout) ----------

app.get("/", (c) => {
  const content = `
<div class="dash-toolbar">
      <h2>Dashboard</h2>
      <span class="dash-hint">Drag a header to dock a widget · drag the corner to resize · Alt + arrows to nudge · rearrange on a wide window</span>
      <span class="dash-spacer"></span>
      <button class="btn" id="btn-add-widget">+ Add widget</button>
      <div class="dash-menu" id="dash-menu">
        <button class="btn ghost" id="dash-menu-toggle" title="Layout actions" aria-haspopup="menu" aria-expanded="false" aria-label="Layout actions">⋯</button>
        <div class="dash-menu-items" id="dash-menu-items" role="menu" hidden>
          <button class="btn ghost" id="btn-auto-arrange" role="menuitem" title="Tidy the layout into rows">▦ Auto-arrange</button>
          <button class="btn ghost" id="btn-export" role="menuitem" title="Download the layout as JSON">↧ Export</button>
          <button class="btn ghost" id="btn-import" role="menuitem" title="Load a layout JSON file">↥ Import</button>
          <button class="btn ghost" id="btn-reset" role="menuitem" title="Reset the dashboard to the default layout">↺ Reset</button>
        </div>
      </div>
    </div>
    <div id="custom-grid" class="dash-canvas" aria-label="Dashboard canvas"></div>
    <div class="palette-overlay" id="palette" hidden>
      <div class="palette-sheet" role="dialog" aria-modal="true" aria-label="Add widget">
        <div class="palette-head">
          <h2>Add a widget</h2>
          <button class="w-btn" id="palette-close" aria-label="Close">×</button>
        </div>
        <input type="search" id="palette-search" class="palette-search" placeholder="Search widgets…" aria-label="Search widgets" autocomplete="off" />
        <div class="palette-grid" id="palette-list"></div>
      </div>
    </div>`;

  return c.html(layout("Dashboard", content, "/", "layout-wide"));
});

// ---------- API ----------

app.get("/api/stats", async (c) => {
  const s = await getStatsCached(c.env);
  return c.json(s);
});

app.get("/api/market", async (c) => {
  const m = await getMarketCached(c.env);
  return c.json(m ?? { error: "unavailable" });
});

app.get("/api/summary", async (c) => {
  const [s, m] = await Promise.all([getStatsCached(c.env), getMarketCached(c.env)]);
  return c.json({
    network: s.info.network,
    node_version: s.info.version,
    height: s.info.height,
    topoheight: s.info.topoheight,
    stable_topoheight: s.info.stable_topoheight,
    difficulty: +s.info.difficulty,
    block_time_s: s.info.average_block_time / 1000,
    block_time_target_s: s.info.block_time_target / 1000,
    block_reward: s.info.miner_reward + s.info.dev_reward,
    mempool: s.info.mempool_size,
    peers: s.peers,
    counts: { transactions: s.txCount, accounts: s.accounts, assets: s.assets },
    supply: {
      circulating: s.info.circulating_supply,
      emitted: s.info.emitted_supply,
      burned: s.info.burned_supply,
      max: s.info.maximum_supply,
    },
    market: m ? { price: m.price, change_pct_24h: m.changePct24h, quote_volume_24h: m.totalQuoteVolume, exchanges: m.tickers.length } : null,
    timestamp: Date.now(),
  });
});

app.get("/ws", (c) => {
  const id = c.env.COLLECTOR.idFromName("global");
  const stub = c.env.COLLECTOR.get(id);
  return stub.fetch(c.req.raw);
});

// History time-series API
app.route("/", history);

// Docs / status / favicon
app.route("/", misc);

// SSR pages (blocks, txs, accounts, market, miners, charts, custom, search)
app.route("/", pages);

// 404
app.notFound((c) => c.html(layout("Not found",
  `<div class="err404"><h1>404</h1><p style="margin-top:1rem;color:var(--text-dim)">Page not found</p><p style="margin-top:2rem"><a class="btn" href="/">← Dashboard</a></p></div>`, ""), 404));

// Rankings (period leaderboards)
app.route("/", top);

// Docs / status / favicon / embeds / SEO
app.route("/", misc2);

// Cron entry (market snapshots, mempool, hourly peers, daily rollup)
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleCron(env));
  },
};

