import { Hono } from "hono";
import type { Env } from "./app";
import { layout } from "../client/layout";
import { XEL_LOGO } from "../client/format";
import appCss from "../client/style.css?inline";

export const misc2 = new Hono<{ Bindings: Env }>();

// ---------- embeddable mini-charts ----------

misc2.get("/embed/:metric", async (c) => {
  const metric = c.req.param("metric");
  const range = c.req.query("range") ?? "30d";
  const interval = c.req.query("interval") ?? "day";
  const content = `
    <div class="panel" style="margin:0;padding:1.2rem">
      <h2 style="font-size:1.3rem">${metric}</h2>
      <div id="u-embed" style="min-height:180px"></div>
      <p style="font-size:1rem;color:var(--text-dim);text-align:right;margin-top:0.4rem">
        <a href="/" target="_blank" style="color:var(--mint)">xelis stats</a>
      </p>
    </div>
    <script type="module" src="/src/client/main.ts"></script>`;
  // bare layout without site chrome
  const page = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${metric} · Xelis Stats</title>
    <link href="https://fonts.googleapis.com/css2?family=Jura:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet"/>
    <style>${appCss}</style>
    <script type="module" src="/src/client/main.ts"></script></head>
    <body><div id="app" style="max-width:64rem;margin:0 auto;padding:1rem">${content}</div>
    <script>window.EMBED_METRIC=${JSON.stringify(metric)};window.EMBED_RANGE=${JSON.stringify(c.req.query("range") ?? "30d")};window.EMBED_INTERVAL=${JSON.stringify(c.req.query("interval") ?? "day")};</script>
    </body></html>`;
  return c.html(page);
});

// ---------- SEO ----------

misc2.get("/favicon.ico", (c) => c.redirect("/favicon.svg", 301));

misc2.get("/robots.txt", (c) => c.body("User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: /sitemap.xml", 200, { "Content-Type": "text/plain" }));

misc2.get("/sitemap.xml", (c) => {
  const pages = ["", "/blocks", "/transactions", "/market", "/miners", "/charts", "/api/docs", "/status"];
  const today = new Date().toISOString().slice(0, 10);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url><loc>/${p}</loc><lastmod>${today}</lastmod></url>`).join("\n")}
</urlset>`;
  return c.body(xml, 200, { "Content-Type": "application/xml" });
});

export { layout, XEL_LOGO };