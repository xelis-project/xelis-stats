import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { fmtInt, shortHash, fmtTime, atomic } from "../../client/format";
import { srvSort, TX_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { PAGE_SIZE, pager, cursorPager, entityTag, resultBadge } from "./shared";
import { pagedCompositeRaw, topNRaw, countRaw } from "../shards";

export const transactions = new Hono<{ Bindings: Env }>();

transactions.get("/transactions", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const TX_TYPES = ["transfer", "burn", "invoke_contract", "deploy_contract", "multisig"];
  const rawType = c.req.query("type") ?? "";
  const type = TX_TYPES.includes(rawType) ? rawType : "";
  const executed = c.req.query("executed") === "1" || c.req.query("executed") === "0" ? c.req.query("executed")! : "";
  const srt = srvSort((n) => c.req.query(n), TX_COLS, "block", "hash", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (executed) p.set("executed", executed);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/transactions?${q}` : "/transactions";
  });

  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (type) { conds.push("tx_type = ?"); binds.push(type); }
  if (executed === "1") { conds.push("executed = 1"); }
  if (executed === "0") { conds.push("executed = 0"); }
  const extra = conds.length ? { sql: conds.join(" AND "), binds } : undefined;

  // Default view (newest block first) uses a two-column keyset cursor
  // (block_topo, hash): any depth is an index seek, no offset scan.
  const keyset = srt.key === "block" && srt.dir === "desc";
  const curRaw = c.req.query("cur") ?? "";
  const [curBt, curHash] = curRaw.includes(":") ? curRaw.split(":") : ["", ""];
  const cursor: [number, string] | null = curBt && curHash ? [Number(curBt), curHash] : null;
  const newer = c.req.query("newer") === "1";

  let rows: Record<string, unknown>[] = [];
  let total = 0;
  let hasPrev = false;
  let hasNext = false;
  try {
    total = await countRaw(c.env, { table: "tx_index", extra, floorCol: "block_topo" });
    if (keyset) {
      if (newer && cursor) {
        const asc = await pagedCompositeRaw(c.env, {
          table: "tx_index", select: "*",
          cols: [{ col: "block_topo", dir: "DESC" }, { col: "hash", dir: "DESC" }],
          cursor, limit: PAGE_SIZE + 1, direction: "newer", extra,
        });
        rows = asc.slice(0, PAGE_SIZE).reverse();
        hasPrev = asc.length > PAGE_SIZE;
        hasNext = asc.length > 0;
      } else {
        const desc = await pagedCompositeRaw(c.env, {
          table: "tx_index", select: "*",
          cols: [{ col: "block_topo", dir: "DESC" }, { col: "hash", dir: "DESC" }],
          cursor, limit: PAGE_SIZE + 1, direction: "older", extra,
        });
        rows = desc.slice(0, PAGE_SIZE);
        hasNext = desc.length > PAGE_SIZE;
        hasPrev = !!cursor;
      }
    } else {
      rows = await topNRaw(c.env, {
        table: "tx_index",
        select: "*",
        order: srt.order,
        limit: PAGE_SIZE + 1,
        skip: (page - 1) * PAGE_SIZE,
        extra,
        floorCol: "block_topo",
      });
      hasNext = rows.length > PAGE_SIZE;
      rows = rows.slice(0, PAGE_SIZE);
    }
  } catch { /* db not ready */ }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const qlink = (params: Record<string, string>): string => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (executed) p.set("executed", executed);
    for (const [k, v] of Object.entries(params)) p.set(k, v);
    const q = p.toString();
    return q ? `/transactions?${q}` : "/transactions";
  };
  const curOf = (r: Record<string, unknown>) => `${r.block_topo}:${r.hash}`;
  const pagerHtml = keyset
    ? cursorPager({
        first: hasPrev ? qlink({}) : null,
        prev: hasPrev && rows.length ? qlink({ cur: curOf(rows[0]), newer: "1" }) : null,
        next: hasNext && rows.length ? qlink({ cur: curOf(rows[rows.length - 1]) }) : null,
        info: rows.length ? `Block ${rows[rows.length - 1].block_topo}–${rows[0].block_topo}` : "No transactions",
      })
    : pager(srt.link(srt.key, srt.dir), page, totalPages);

  const fActive = !!type || !!executed;
  const fFields = `
    ${filterField("Transaction type", `<select name="type">${selectOpts(TX_TYPES, type, "all types")}</select>`)}
    ${filterField("Execution", `<select name="executed"><option value=""${executed === "" ? " selected" : ""}>any status</option><option value="1"${executed === "1" ? " selected" : ""}>executed</option><option value="0"${executed === "0" ? " selected" : ""}>unexecuted</option></select>`)}
  `;
  const fPop = filterPop("f-txs", "/transactions", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/transactions${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((t) => `<tr>
        <td><a class="mono" href="/tx/${t.hash}">${shortHash(t.hash as string)}</a></td>
        <td><a href="/block/${t.block_topo}"><span class="mint">${fmtInt(t.block_topo as number)}</span></a></td>
        <td>${fmtTime(t.ts as number)}</td>
        <td><span class="badge ${t.tx_type}">${t.tx_type as string}</span></td>
        <td><a class="mono" href="/account/${t.sender}">${shortHash(t.sender as string, 8)}</a>${entityTag(t.sender as string)}</td>
        <td class="num">${atomic(t.fee as number, 6)}</td>
        <td>${resultBadge(t.executed)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No indexed transactions yet — backfill pending.</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Transactions <span style="color:var(--text-dim)">${fmtInt(total)} total</span></h2>
      ${filterButton("f-txs", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th>Hash</th>${srt.th("block", "Block")}${srt.th("time", "Time")}${srt.th("type", "Type")}${srt.th("sender", "Sender")}${srt.th("fee", "Fee (XEL)", true)}${srt.th("executed", "Execution")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pagerHtml}
  </div>`;
  return c.html(layout("Transactions", content, "/transactions"));
});
