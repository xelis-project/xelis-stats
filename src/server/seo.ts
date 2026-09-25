import { Hono } from "hono";
import type { Env } from "./app";
import { layout } from "../client/layout";
import { XEL_LOGO } from "../client/format";

export const seo = new Hono<{ Bindings: Env }>();

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
