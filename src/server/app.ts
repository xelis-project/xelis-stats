import { Hono } from "hono";
import { layout } from "../client/layout";
import { pages } from "./pages";
import { history } from "./history";
import { docs } from "./docs";
import { handleCron } from "./cron";
import { top } from "./rankings";
import { seo } from "./seo";
import { api } from "./api";
import { getStatsCached } from "./cache";
import { getMarketCached } from "./market-cache";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  COLLECTOR: DurableObjectNamespace;
  XELIS_NODE: string;
  // D1 shard rotation (optional; unset secrets = single-DB mode)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  XELIS_STATS_DB_ID?: string;
  SHARD_MAX_BYTES?: string;
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

// ---------- dashboard (custom, default layout) ----------

app.get("/", (c) => {
  const content = `
<div class="dash-toolbar-sentinel"></div>
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
    <div id="dash-tabs" class="dash-tabs" role="tablist" aria-label="Dashboard tabs"></div>
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

// Blocks / transactions / accounts / peers API
app.route("/", api);

// Docs / status / favicon
app.route("/", docs);

// SSR pages (blocks, txs, accounts, market, miners, charts, custom, search)
app.route("/", pages);

// 404
app.notFound((c) => c.html(layout("Not found",
  `<div class="err404"><h1>404</h1><p style="margin-top:1rem;color:var(--text-dim)">Page not found</p><p style="margin-top:2rem"><a class="btn" href="/">← Dashboard</a></p></div>`, ""), 404));

// Rankings (period leaderboards)
app.route("/", top);

// Embeds / SEO
app.route("/", seo);

// Cron entry (market snapshots, mempool, hourly peers, daily rollup)
export default {
  fetch: app.fetch,
  scheduled: (_event: ScheduledEvent, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(handleCron(env));
  },
};
