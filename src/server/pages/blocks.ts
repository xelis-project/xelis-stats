import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { fmt, fmtInt, shortHash, timeCell, atomic } from "../../client/format";
import { srvSort, BLOCK_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { PAGE_SIZE, pager, cursorPager, esc } from "./shared";
import { pagedRaw, pagedRawAsc, topNRaw, countRaw, mergeAgg } from "../shards";

export const blocks = new Hono<{ Bindings: Env }>();

blocks.get("/blocks", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  // table filters: block type (case-insensitive, like /api/blocks) + min txs
  const typeRaw = (c.req.query("type") ?? "").toLowerCase();
  const type = ["normal", "side", "sync"].includes(typeRaw) ? typeRaw[0].toUpperCase() + typeRaw.slice(1) : "";
  const minTxsRaw = Number(c.req.query("min_txs") ?? "");
  const minTxs = Number.isFinite(minTxsRaw) && minTxsRaw > 0 ? Math.floor(minTxsRaw) : 0;
  const srt = srvSort((n) => c.req.query(n), BLOCK_COLS, "topo", "topoheight", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (minTxs) p.set("min_txs", String(minTxs));
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/blocks?${q}` : "/blocks";
  });
  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (type) { conds.push("UPPER(block_type) = UPPER(?)"); binds.push(type); }
  if (minTxs) { conds.push("tx_count >= ?"); binds.push(minTxs); }
  const extra = conds.length ? { sql: conds.join(" AND "), binds } : undefined;
  const fActive = !!type || minTxs > 0;

  // Default view (newest first) uses keyset pagination: a cursor is an index
  // seek, so any depth is O(limit) instead of scanning every preceding row.
  // Any other sort falls back to offset pagination over the merged shards.
  const keyset = srt.key === "topo" && srt.dir === "desc";
  const before = Math.max(0, Number(c.req.query("before") ?? 0) || 0);
  const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);

  let rows: Record<string, unknown>[] = [];
  let total = 0;
  let hasPrev = false;
  let hasNext = false;
  let minTopo: number | null = null;
  try {
    total = await countRaw(c.env, { table: "blocks", extra, floorCol: "topoheight" });
    if (keyset) {
      if (after > 0) {
        // stateless "newer" page: take the rows immediately above the cursor
        const asc = await pagedRawAsc(c.env, {
          table: "blocks", cursorCol: "topoheight", select: "*", after, limit: PAGE_SIZE + 1, extra,
        });
        rows = asc.slice(0, PAGE_SIZE).reverse();
        hasPrev = asc.length > PAGE_SIZE;
        hasNext = asc.length > 0;
      } else {
        const desc = await pagedRaw(c.env, {
          table: "blocks", cursorCol: "topoheight", select: "*", before, limit: PAGE_SIZE + 1, extra,
        });
        rows = desc.slice(0, PAGE_SIZE);
        hasNext = desc.length > PAGE_SIZE;
        hasPrev = before > 0;
      }
      if (!fActive) {
        const mv = (await mergeAgg(c.env, "SELECT MIN(topoheight) AS m FROM blocks", [], { sum: [], min: "m" })).m;
        minTopo = Number.isFinite(mv) ? mv : null;
      }
    } else {
      rows = await topNRaw(c.env, {
        table: "blocks",
        select: "*",
        order: srt.order,
        limit: PAGE_SIZE + 1,
        skip: (page - 1) * PAGE_SIZE,
        extra,
        floorCol: "topoheight",
      });
      hasNext = rows.length > PAGE_SIZE;
      rows = rows.slice(0, PAGE_SIZE);
    }
  } catch {
    rows = [];
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qlink = (params: Record<string, string>): string => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (minTxs) p.set("min_txs", String(minTxs));
    for (const [k, v] of Object.entries(params)) p.set(k, v);
    const q = p.toString();
    return q ? `/blocks?${q}` : "/blocks";
  };
  const firstTopo = rows.length ? Number(rows[0].topoheight) : 0;
  const lastTopo = rows.length ? Number(rows[rows.length - 1].topoheight) : 0;
  // oldest page starts at the cursor that yields the final, possibly partial page
  const tail = total % PAGE_SIZE || PAGE_SIZE;
  const lastBefore = minTopo != null ? minTopo + tail : null;
  const lastPage = !fActive && lastBefore != null && hasNext ? qlink({ before: String(lastBefore) }) : null;
  const pagerHtml = keyset
    ? cursorPager({
        first: hasPrev ? qlink({}) : null,
        prev: hasPrev && firstTopo > 0 ? qlink({ after: String(firstTopo) }) : null,
        next: hasNext && lastTopo > 0 ? qlink({ before: String(lastTopo) }) : null,
        last: lastPage,
        info: rows.length ? `Topo ${esc(String(lastTopo))}–${esc(String(firstTopo))}` : "No blocks",
      })
    : pager(srt.link(srt.key, srt.dir), page, totalPages);

  const body = rows.length
    ? rows.map((b) => {
        const topo = b.topoheight as number;
        const ts = b.ts as number;
        const type = esc(String(b.block_type ?? "normal"));
        return `<tr>
          <td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>
          <td><span class="hash">${shortHash(b.hash as string)}</span></td>
          <td>${timeCell(ts)}</td>
          <td class="num">${fmtInt(b.tx_count as number)}</td>
          <td class="num">${fmt((b.difficulty as number) ?? 0)}</td>
          <td class="num">${atomic(b.miner_reward as number)}</td>
          <td><span class="badge ${type.toLowerCase()}">${type}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No indexed blocks yet — historical backfill pending. Live data unavailable until D1 import.</td></tr>`;

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
      <thead><tr>${srt.th("topo", "Topo")}${srt.th("hash", "Hash")}${srt.th("time", "Age")}${srt.th("txs", "Txs", true)}${srt.th("difficulty", "Difficulty", true)}${srt.th("reward", "Reward (XEL)", true)}${srt.th("type", "Type")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pagerHtml}
  </div>`;
  return c.html(layout("Blocks", content, "/blocks"));
});
