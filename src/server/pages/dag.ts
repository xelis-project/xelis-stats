import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { icons } from "../../client/icons";
import { clampInt, esc, logErr } from "./shared";
import { getStatsCached } from "../cache";

export const dag = new Hono<{ Bindings: Env }>();

// Interactive block-DAG page. Laid out full-viewport like a dedicated viewer:
// the canvas fills the content area and every control floats over it. The shell
// is server-rendered with the topoheight from ?topo= (or the current tip) so a
// shared link opens at the right window; the canvas itself is lazy-loaded
// client-side (src/client/dag.ts).
dag.get("/dag", async (c) => {
  const requested = clampInt(c.req.query("topo"), 0, 10_000_000);
  const live = c.req.query("live") === "1";

  // Best-effort tip/height for a useful subtitle and the initial window; the
  // viewer refetches from /api/dag anyway, so a node outage just omits context.
  let tip: number | null = null;
  let stable: number | null = null;
  let network = "";
  try {
    const stats = await getStatsCached(c.env);
    tip = Number.isFinite(stats.info?.topoheight) ? stats.info.topoheight : null;
    stable = Number.isFinite(stats.info?.stable_topoheight) ? stats.info.stable_topoheight : null;
    network = stats.info?.network ?? "";
  } catch (err) {
    logErr("page/dag", err);
  }

  const topo = requested > 0 ? requested : (tip ?? 0);
  const context = [
    network ? esc(network) : "",
    tip != null ? `tip ${tip.toLocaleString("en-US")}` : "",
    stable != null ? `stable ${stable.toLocaleString("en-US")}` : "",
  ].filter(Boolean).join(" · ");

  const content = `<div class="panel dag-panel" id="dag-app" data-topo="${topo}" data-live="${live ? "1" : "0"}">
    <div class="dag-viewport" id="dag-viewport">
      <canvas id="dag-canvas" aria-label="Block DAG graph" role="img"></canvas>

      <div class="dag-bar">
        <h1 class="dag-title">DAG Viewer${context ? `<span class="dag-sub">${context}</span>` : ""}</h1>
        <div class="dag-field">
          <label for="dag-input">Topoheight</label>
          <input type="number" id="dag-input" min="0" step="1" inputmode="numeric" placeholder="latest" value="${topo > 0 ? topo : ""}" />
        </div>
        <button class="btn ghost" id="dag-go" type="button">Go</button>
        <button class="btn ghost icon-btn" id="dag-prev" type="button" title="Older window" aria-label="Older window">${icons.chevronLeft}</button>
        <button class="btn ghost icon-btn" id="dag-next" type="button" title="Newer window" aria-label="Newer window">${icons.chevronRight}</button>
        <span class="dag-sep" aria-hidden="true"></span>
        <button class="btn ghost icon-btn dag-live-btn" id="dag-live" type="button" aria-pressed="${live ? "true" : "false"}" aria-label="Live" title="Stream the node's unstable tip">
          <span class="dag-live-dot" aria-hidden="true"></span>
        </button>
        <span class="dag-sep" aria-hidden="true"></span>
        <button class="btn ghost icon-btn" id="dag-fit" type="button" title="Fit all blocks" aria-label="Fit all blocks">${icons.reset}</button>
        <button class="btn ghost icon-btn" id="dag-zin" type="button" title="Zoom in" aria-label="Zoom in">${icons.plus}</button>
        <button class="btn ghost icon-btn" id="dag-zout" type="button" title="Zoom out" aria-label="Zoom out">${icons.minus}</button>
        <button class="btn ghost icon-btn" id="dag-fs" type="button" title="Fullscreen" aria-label="Toggle fullscreen"><span class="dag-fs-enter">${icons.maximize}</span><span class="dag-fs-exit">${icons.minimize}</span></button>
        <span class="dag-status" id="dag-status"></span>
      </div>

      <div class="dag-legend" id="dag-legend">
        <span class="live-key"><span class="live-key-dot normal"></span>Normal</span>
        <span class="live-key"><span class="live-key-dot side"></span>Side</span>
        <span class="live-key"><span class="live-key-dot sync"></span>Sync</span>
        <span class="live-key"><span class="dag-key-line" aria-hidden="true"></span>Tip (parent)</span>
        <span class="live-key"><span class="dag-key-dash" aria-hidden="true"></span>Unstable</span>
      </div>

      <div class="dag-detail" id="dag-detail" hidden></div>
      <div class="dag-hover" id="dag-hover" hidden></div>
      <div class="dag-loading" id="dag-loading"><span class="dag-spinner" aria-hidden="true"></span>Loading blocks…</div>
      <p class="dag-hint">Drag to pan · scroll to zoom · click a block for details</p>
    </div>
  </div>
  <noscript><div class="panel"><h1>DAG Viewer</h1><p style="color:var(--text-dim)">The interactive DAG needs JavaScript. Browse the <a href="/blocks">block list</a> instead.</p></div></noscript>`;

  return c.html(layout("DAG", content, "/dag", "layout-dag"));
});
