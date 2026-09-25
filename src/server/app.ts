import { Hono } from "hono";
import { layout } from "../client/layout";
import { icons } from "../client/icons";
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
  // native rate-limit bindings (see wrangler.jsonc); optional so local/dev or
  // older configs fail open instead of crashing
  API_RATE?: RateLimit;
  EXPENSIVE_RATE?: RateLimit;
  // D1 shard rotation (optional; unset secrets = single-DB mode)
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  XELIS_STATS_DB_ID?: string;
  SHARD_MAX_BYTES?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ---------- security headers ----------

app.use("*", async (c, next) => {
  await next();
  // WebSocket upgrade responses proxied from the Durable Object have immutable
  // headers (and a 101 status), so they cannot be modified here.
  if (c.req.path === "/ws" || c.res.status === 101) return;
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // Embeds are meant to be framed by third parties; everything else is not.
  const embed = c.req.path.startsWith("/embed/");
  if (!embed) h.set("X-Frame-Options", "DENY");
  // Inline event handlers and inline <script> blocks are still used, so
  // script-src cannot be tightened without a nonce/handler refactor; the rest
  // of the policy still blocks plugin content, base-tag hijacks and framing.
  h.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${embed ? "*" : "'none'"}`,
  ].join("; "));
  // Short-lived caching for GETs; never cache the WebSocket upgrade or the
  // RPC-backed storage fragment.
  const noStore = c.req.path === "/ws" || /^\/contracts\/[^/]+\/storage$/.test(c.req.path);
  if (c.req.method === "GET" && !noStore) {
    if (c.req.path.startsWith("/api/")) {
      h.set("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    } else if (h.get("Content-Type")?.includes("text/html")) {
      h.set("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
    }
  }
});

// ---------- rate limiting (native, atomic per-IP limiters) ----------

// Expensive SSR routes that hit node RPC per request; everything else is
// either static, cached or cheap enough to serve without a per-IP cap.
const EXPENSIVE_SSR = /^\/contracts\/[^/]+\/storage$/;

app.use("*", async (c, next) => {
  if (c.req.method !== "GET") return next();
  const isApi = c.req.path.startsWith("/api/");
  const expensive = EXPENSIVE_SSR.test(c.req.path);
  if (!isApi && !expensive) return next();
  const limiter = isApi ? c.env.API_RATE : c.env.EXPENSIVE_RATE;
  if (limiter) {
    const key = `${c.req.header("CF-Connecting-IP") ?? "anon"}:${isApi ? "api" : "ssr"}`;
    const { success } = await limiter.limit({ key });
    if (!success) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate limit exceeded" }, 429);
    }
  }
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
      <button class="btn" id="btn-add-widget">${icons.plus} Add widget</button>
      <div class="dash-menu" id="dash-menu">
        <button class="btn ghost" id="dash-menu-toggle" title="Layout actions" aria-haspopup="menu" aria-expanded="false" aria-label="Layout actions">${icons.more}</button>
        <div class="dash-menu-items" id="dash-menu-items" role="menu" hidden>
          <button class="btn ghost" id="btn-auto-arrange" role="menuitem" title="Tidy the layout into rows">${icons.layout} Auto-arrange</button>
          <button class="btn ghost" id="btn-export" role="menuitem" title="Download the layout as JSON">${icons.download} Export</button>
          <button class="btn ghost" id="btn-import" role="menuitem" title="Load a layout JSON file">${icons.upload} Import</button>
          <button class="btn ghost" id="btn-reset" role="menuitem" title="Reset the dashboard to the default layout">${icons.reset} Reset</button>
        </div>
      </div>
    </div>
    <div id="dash-tabs" class="dash-tabs" role="tablist" aria-label="Dashboard tabs"></div>
    <div id="custom-grid" class="dash-canvas" aria-label="Dashboard canvas"></div>
    <div class="palette-overlay" id="palette" hidden>
      <div class="palette-sheet" role="dialog" aria-modal="true" aria-label="Add widget">
        <div class="palette-head">
          <h2>Add a widget</h2>
          <button class="w-btn" id="palette-close" aria-label="Close">${icons.close}</button>
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
  // Hashprice for the latest rolled-up day: daily miner revenue (whole XEL) at
  // the current price divided by that day's estimated hashrate, in USD/TH/day.
  let hashprice: number | null = null;
  try {
    const d = await c.env.DB.prepare(
      "SELECT miner_revenue, hashrate FROM daily_stats WHERE hashrate > 0 AND miner_revenue > 0 ORDER BY date DESC LIMIT 1"
    ).first<{ miner_revenue: number; hashrate: number }>();
    if (d && m?.price) hashprice = (d.miner_revenue / 1e8) * m.price / Number(d.hashrate) * 1e12;
  } catch { /* D1 not ready */ }
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
    chain_size_bytes: s.chainSize?.size_bytes ?? null,
    chain_size_formatted: s.chainSize?.size_formatted ?? null,
    peers: s.peers,
    hashprice,
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
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
  return c.html(layout("Not found",
    `<div class="err404"><h1>404</h1><p style="margin-top:1rem;color:var(--text-dim)">Page not found</p><p style="margin-top:2rem"><a class="btn" href="/">${icons.arrowLeft} Dashboard</a></p></div>`, ""), 404);
});

// Unhandled errors: log with request context and return a safe response
app.onError((err, c) => {
  console.error(`unhandled error on ${c.req.method} ${c.req.path}:`, err instanceof Error ? (err.stack ?? err.message) : String(err));
  if (c.req.path.startsWith("/api/")) return c.json({ error: "internal error" }, 500);
  return c.html(layout("Error",
    `<div class="err404"><h1>500</h1><p style="margin-top:1rem;color:var(--text-dim)">Something went wrong. Try again shortly.</p><p style="margin-top:2rem"><a class="btn" href="/">${icons.arrowLeft} Dashboard</a></p></div>`, ""), 500);
});

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
