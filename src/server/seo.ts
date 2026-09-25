import { Hono } from "hono";
import type { Env } from "./app";
import { layout, escHtml } from "../client/layout";
import { XEL_LOGO } from "../client/format";
import { mainScriptUrl } from "../client/entry-url";
import appCss from "../client/style.css?inline";
import uplotCss from "uplot/dist/uPlot.min.css?inline";

export const seo = new Hono<{ Bindings: Env }>();

// JSON for an inline <script>: escape "<" so a value containing "</script>"
// cannot terminate the script element.
const jsonScript = (v: unknown): string => JSON.stringify(v ?? null).replace(/</g, "\\u003c");

// ---------- embeddable mini-charts ----------

seo.get("/embed/:metric", async (c) => {
  const metric = c.req.param("metric");
  const range = c.req.query("range") ?? "30d";
  const interval = c.req.query("interval") ?? "day";
  const content = `
    <div class="panel" style="margin:0;padding:1.2rem">
      <h2 style="font-size:1.3rem">${escHtml(metric)}</h2>
      <div id="u-embed" style="min-height:180px"></div>
      <p style="font-size:1rem;color:var(--text-dim);text-align:right;margin-top:0.4rem">
        <a href="/" target="_blank" style="color:var(--mint)">xelis stats</a>
      </p>
    </div>`;
  // bare layout without site chrome
  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${escHtml(metric)} · Xelis Stats</title>
    <link href="https://fonts.googleapis.com/css2?family=Jura:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet"/>
    <style>${uplotCss}${appCss}</style>
    <script type="module" src="${mainScriptUrl}"></script></head>
    <body><div id="app" style="max-width:64rem;margin:0 auto;padding:1rem">${content}</div>
    <script>window.EMBED_METRIC=${jsonScript(metric)};window.EMBED_RANGE=${jsonScript(range)};window.EMBED_INTERVAL=${jsonScript(interval)};</script>
    </body></html>`;
  return c.html(page);
});

// ---------- SEO ----------

seo.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

seo.get("/robots.txt", (c) => c.body("User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: /sitemap.xml", 200, { "Content-Type": "text/plain" }));

seo.get("/sitemap.xml", (c) => {
  const pages = ["", "/blocks", "/transactions", "/market", "/miners", "/charts", "/api/docs", "/status"];
  const today = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>/${p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>`;
  return c.body(xml, 200, { "Content-Type": "application/xml" });
});

// re-exports kept for backwards compatibility with existing importers
export { layout, XEL_LOGO };
