import { Hono } from "hono";
import type { Env } from "../app";
import { layout, escHtml } from "../../client/layout";
import { CHART_METRICS } from "./charts";

export const embeds = new Hono<{ Bindings: Env }>();

const RANGES: Array<[string, string]> = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["1y", "1 year"],
  ["all", "all time"],
];
const INTERVALS = ["day", "week", "month", "year"];
const DEFAULT_METRIC = "txs";
const DEFAULT_RANGE = "30d";
const DEFAULT_INTERVAL = "day";
const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 220;

// query params only prefill the builder; anything unknown falls back to defaults
const oneOf = (v: string | undefined, allowed: readonly string[], fallback: string): string =>
  v && allowed.includes(v) ? v : fallback;

const embedSrc = (origin: string, metric: string, range: string, interval: string): string =>
  `${origin}/embed/${encodeURIComponent(metric)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

const embedSnippet = (src: string, label: string, width: number, height: number): string =>
  `<iframe src="${src}" width="${width}" height="${height}" style="border:0;border-radius:12px" title="Xelis Stats — ${label}" loading="lazy"></iframe>`;

// `/embed` on its own has no chart to show; send visitors to the setup page.
embeds.get("/embed", (c) => c.redirect("/embeds", 301));

embeds.get("/embeds", (c) => {
  const origin = new URL(c.req.url).origin;
  const labelOf = (metric: string): string => CHART_METRICS.find(([m]) => m === metric)?.[1] ?? metric;
  const metricParam = c.req.query("metric");
  const metric = CHART_METRICS.some(([m]) => m === metricParam) ? metricParam! : DEFAULT_METRIC;
  const range = oneOf(c.req.query("range"), RANGES.map(([r]) => r), DEFAULT_RANGE);
  const interval = oneOf(c.req.query("interval"), INTERVALS, DEFAULT_INTERVAL);

  const metricOpts = CHART_METRICS.map(([m, name]) =>
    `<option value="${escHtml(m)}" ${m === metric ? "selected" : ""}>${escHtml(name)}</option>`).join("");
  const rangeOpts = RANGES.map(([r, name]) =>
    `<option value="${escHtml(r)}" ${r === range ? "selected" : ""}>${escHtml(name)}</option>`).join("");
  const intervalOpts = INTERVALS.map((i) =>
    `<option value="${escHtml(i)}" ${i === interval ? "selected" : ""}>${escHtml(i)}</option>`).join("");

  const src = embedSrc(origin, metric, range, interval);
  const snippet = embedSnippet(src, labelOf(metric), DEFAULT_WIDTH, DEFAULT_HEIGHT);

  const metricRows = CHART_METRICS.map(([m, name]) => {
    const href = `/embed/${escHtml(m)}?range=${DEFAULT_RANGE}&interval=${DEFAULT_INTERVAL}`;
    return `<tr>
      <td>${escHtml(name)}</td>
      <td><span class="mono">${escHtml(m)}</span></td>
      <td><a class="btn ghost" href="${href}" target="_blank" rel="noopener">open</a>
        <button class="copybtn" type="button" data-emb-metric="${escHtml(m)}">customize</button></td>
    </tr>`;
  }).join("");

  const content = `
    <div class="panel">
      <h2>Embed charts</h2>
      <p style="font-size:1.4rem;line-height:1.6;margin-bottom:1rem">
        Any chart on Xelis Stats can live on your own site with a single <span class="mono">&lt;iframe&gt;</span>.
        Pick a metric, choose a range and size, then copy the snippet into your page, docs, README or CMS "HTML" block.
        No API key, no script, no build step.
      </p>
      <p style="font-size:1.3rem;color:var(--text-dim)">
        1. choose a metric &nbsp;→&nbsp; 2. adjust range, interval and size &nbsp;→&nbsp; 3. paste the snippet.
        The chart is always dark-themed, keeps its "xelis stats" attribution link, and shows the latest indexed data each time the page loads.
      </p>
    </div>

    <div class="panel" id="emb-builder">
      <h2>Builder</h2>
      <div class="emb-controls">
        <label for="emb-metric">Metric<select id="emb-metric">${metricOpts}</select></label>
        <label for="emb-range">Range<select id="emb-range">${rangeOpts}</select></label>
        <label for="emb-interval">Interval<select id="emb-interval">${intervalOpts}</select></label>
        <div class="emb-field"><span>Width</span><span class="emb-num"><input type="number" id="emb-width" min="200" max="1600" step="10" value="${DEFAULT_WIDTH}" aria-label="Width in pixels"/> px</span></div>
        <div class="emb-field"><span>Height</span><span class="emb-num"><input type="number" id="emb-height" min="140" max="900" step="10" value="${DEFAULT_HEIGHT}" aria-label="Height in pixels"/> px</span></div>
      </div>
      <div class="emb-preview">
        <iframe id="emb-preview" src="${escHtml(src)}" width="${DEFAULT_WIDTH}" height="${DEFAULT_HEIGHT}" style="border:0;border-radius:12px" title="Xelis Stats — ${escHtml(labelOf(metric))}" loading="lazy"></iframe>
      </div>
      <pre class="json-pre emb-pre" id="emb-snippet">${escHtml(snippet)}</pre>
      <div class="emb-actions">
        <button class="btn ghost" type="button" id="emb-copy">Copy iframe code</button>
        <a class="btn ghost" href="${escHtml(src)}" target="_blank" rel="noopener" id="emb-open">Open chart</a>
        <span class="emb-hint">Paste it anywhere HTML is allowed.</span>
      </div>
    </div>

    <div class="panel">
      <h2>Parameters</h2>
      <div class="tablewrap"><table class="kv emb-params">
        <tr><td>URL</td><td><span class="mono">/embed/&lt;metric&gt;?range=&lt;range&gt;&amp;interval=&lt;interval&gt;</span></td></tr>
        <tr><td>metric</td><td>Path segment, required. Any metric from the list below (or the full <a href="/api/docs">API metric list</a> — fee percentiles and peer stats included). An unknown metric renders an empty chart.</td></tr>
        <tr><td>range</td><td><span class="mono">7d | 30d | 90d | 1y | all</span> — default <span class="mono">30d</span>. Any <span class="mono">Nd</span>, <span class="mono">Nm</span> or <span class="mono">Ny</span> value works (for example <span class="mono">365d</span>), capped at 10 years.</td></tr>
        <tr><td>interval</td><td><span class="mono">day | week | month | year</span> — default <span class="mono">day</span>.</td></tr>
        <tr><td>Size</td><td>Set via the iframe's <span class="mono">width</span> and <span class="mono">height</span> attributes. The chart fills the width and needs about 180px of height to be readable.</td></tr>
        <tr><td>Theme</td><td>Dark theme with the Xelis Stats mint accent; there is no light variant.</td></tr>
        <tr><td>Freshness</td><td>Live data: the snippet reloads the chart whenever the host page loads (HTML cached ~15s, series cached ~30s).</td></tr>
        <tr><td>Framing</td><td><span class="mono">/embed/*</span> is the only part of the site that may be framed; any origin can embed it. No referrer or key checks.</td></tr>
        <tr><td>Raw data</td><td>Prefer numbers over charts? Use <a href="/api/docs">/api/history/:metric</a> (JSON or <span class="mono">format=csv</span>). Public API rate limits apply.</td></tr>
      </table></div>
    </div>

    <div class="panel" id="emb-metrics">
      <h2>Metrics</h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Chart</th><th>Metric</th><th>Embed</th></tr></thead>
        <tbody>${metricRows}</tbody>
      </table></div>
    </div>`;

  return c.html(layout("Embeds", content, ""));
});
