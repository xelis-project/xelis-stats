import { Hono } from "hono";
import type { Env } from "../app";
import { layout, notFound } from "../../client/layout";
import { fmtInt, shortHash } from "../../client/format";
import { srvSort } from "../sort";
import { filterButton, filterPop, filterField } from "../filters";
import { esc, flaggedText } from "./shared";
import { PAGE_SIZE, pager } from "./shared";
import { fetchBlock, fetchTx } from "../shards";

export const assets = new Hono<{ Bindings: Env }>();

assets.get("/assets", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 64);
  const srt = srvSort((n) => c.req.query(n), {
    asset: { sql: "asset_id", def: "asc" },
    name: { sql: "name", def: "asc" },
    symbol: { sql: "symbol", def: "asc" },
    decimals: { sql: "decimals", def: "asc" },
    first: { sql: "first_seen_topo", def: "desc" },
  }, "first", "asset_id", (s) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const qs = p.toString();
    return qs ? `/assets?${qs}` : "/assets";
  });
  let rows: Record<string, unknown>[] = [];
  let total = 0;
  const pageRaw = Number(c.req.query("page") ?? 1);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  try {
    const where = q ? "WHERE (name LIKE ? OR symbol LIKE ? OR asset_id LIKE ?)" : "";
    const binds = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    total = (await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM assets ${where}`)
      .bind(...binds).first<{ n: number }>())?.n ?? 0;
    rows = await c.env.DB.prepare(`SELECT * FROM assets ${where} ORDER BY ${srt.order} LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`)
      .bind(...binds).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* table empty or missing */ }
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (srt.qs) for (const [k, v] of new URLSearchParams(srt.qs)) p.set(k, v);
  const pq = p.toString();
  const pagerBase = pq ? `/assets?${pq}` : "/assets";
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fFields = `
    ${filterField("Search", `<input type="text" name="q" placeholder="name, symbol or asset id" value="${esc(q)}" maxlength="64" />`)}
  `;
  const fPop = filterPop("f-assets", "/assets", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/assets${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((a) => `<tr>
        <td><span class="mono">${shortHash(a.asset_id as string, 8)}</span></td>
        <td>${a.name ? flaggedText(a.name) : "—"}</td>
        <td>${a.symbol ? flaggedText(a.symbol) : "—"}</td>
        <td class="num">${fmtInt(a.decimals as number)}</td>
        <td class="num">${fmtInt(a.first_seen_topo as number)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:var(--text-dim)">No assets indexed yet (populated during tx detail pass).</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Assets <span style="color:var(--text-dim)">${fmtInt(total)} total</span></h2>
      ${filterButton("f-assets", !!q)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
    <thead><tr>${srt.th("asset", "Asset ID")}${srt.th("name", "Name")}${srt.th("symbol", "Symbol")}${srt.th("decimals", "Decimals", true)}${srt.th("first", "First seen (topo)", true)}</tr></thead>
    <tbody>${body}</tbody></table></div>
    ${pager(pagerBase, page, totalPages)}
  </div>`;
  return c.html(layout("Assets", content, "/assets"));
});

export const search = new Hono<{ Bindings: Env }>();

search.get("/search/:query", async (c) => {
  const q = decodeURIComponent(c.req.param("query"));
  const db = c.env.DB;
  // heuristic routing
  if (/^\d+$/.test(q)) return c.redirect(`/block/${q}`);
  if (q.startsWith("xel:")) {
    // miner addresses get the mining profile; everyone else the account page
    try {
      const inWindow = await db.prepare("SELECT 1 AS m FROM blocks WHERE miner_address = ? LIMIT 1").bind(q).first();
      const inRollups = inWindow ? null : await db.prepare("SELECT 1 AS m FROM daily_miners WHERE address = ? LIMIT 1").bind(q).first();
      if (inWindow || inRollups) return c.redirect(`/miner/${q}`);
    } catch { /* db not ready */ }
    return c.redirect(`/account/${q}`);
  }
  // try tx hash (routes across hot + shard databases)
  try {
    const foundTx = await fetchTx(c.env, q);
    if (foundTx) return c.redirect(`/tx/${q}`);
    const foundBlock = await fetchBlock(c.env, q);
    if (foundBlock) return c.redirect(`/block/${foundBlock.row.topoheight}`);
    const acct = await db.prepare("SELECT address FROM accounts WHERE address = ?").bind(q).first();
    if (acct) return c.redirect(`/account/${q}`);
    const ct = await db.prepare("SELECT contract_id FROM contracts WHERE contract_id = ?").bind(q).first();
    if (ct) return c.redirect(`/contracts/${q}`);
  } catch { /* db not ready */ }
  return c.html(layout("Search", notFound(`"${q.slice(0, 20)}"`), ""));
});
