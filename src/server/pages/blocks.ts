import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { fmt, fmtInt, shortHash, fmtTime, atomic } from "../../client/format";
import { srvSort, BLOCK_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { PAGE_SIZE, pager, esc } from "./shared";

export const blocks = new Hono<{ Bindings: Env }>();

blocks.get("/blocks", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  // table filters: block type (case-insensitive, like /api/blocks) + min txs
  const typeRaw = (c.req.query("type") ?? "").toLowerCase();
  const type = ["normal", "side", "sync"].includes(typeRaw) ? typeRaw[0].toUpperCase() + typeRaw.slice(1) : "";
  const minTxsRaw = Number(c.req.query("min_txs") ?? "");
  const minTxs = Number.isFinite(minTxsRaw) && minTxsRaw > 0 ? Math.floor(minTxsRaw) : 0;
  const db = c.env.DB;
  const srt = srvSort((n) => c.req.query(n), BLOCK_COLS, "topo", "topoheight DESC", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (minTxs) p.set("min_txs", String(minTxs));
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/blocks?${q}` : "/blocks";
  });
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (type) { conds.push("UPPER(block_type) = UPPER(?)"); binds.push(type); }
  if (minTxs) { conds.push("tx_count >= ?"); binds.push(minTxs); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  let rows: Record<string, unknown>[];
  let total = 0;
  try {
    total = await db.prepare(`SELECT COUNT(*) AS n FROM blocks ${where}`).bind(...binds).first<{ n: number }>().then((r) => r?.n ?? 0);
    rows = await db.prepare(`SELECT * FROM blocks ${where} ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch {
    rows = [];
  }
  const hasMore = rows.length > PAGE_SIZE;
  rows = rows.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const body = rows.length
    ? rows.map((b) => {
        const topo = b.topoheight as number;
        const ts = b.ts as number;
        const orphan = b.is_orphan ? ' <span class="badge fail">orphan</span>' : "";
        const type = esc(String(b.block_type ?? "normal"));
        return `<tr>
          <td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>
          <td><span class="hash">${shortHash(b.hash as string)}</span></td>
          <td>${fmtTime(ts)}</td>
          <td class="num">${fmtInt(b.tx_count as number)}</td>
          <td class="num">${fmt((b.difficulty as number) ?? 0)}</td>
          <td class="num">${atomic(b.miner_reward as number)}</td>
          <td><span class="badge ${type.toLowerCase()}">${type}</span>${orphan}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No indexed blocks yet — historical backfill pending. Live data unavailable until D1 import.</td></tr>`;

  const fActive = !!type || minTxs > 0;
  const fFields = `
    ${filterField("Block type", `<select name="type">${selectOpts(["Normal", "Side", "Sync"], type, "all types")}</select>`)}
    ${filterField("Min transactions", `<input type="number" name="min_txs" min="0" step="1" placeholder="e.g. 2" value="${minTxs || ""}" />`)}
  `;
  const fPop = filterPop("f-blocks", "/blocks", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/blocks${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Blocks <span style="color:var(--text-dim)">${fmtInt(total)} total</span></h2>
      ${filterButton("f-blocks", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr>${srt.th("topo", "Topo")}${srt.th("hash", "Hash")}${srt.th("time", "Time")}${srt.th("txs", "Txs", true)}${srt.th("difficulty", "Difficulty", true)}${srt.th("reward", "Reward (XEL)", true)}${srt.th("type", "Type")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;
  return c.html(layout("Blocks", content, "/blocks"));
});
