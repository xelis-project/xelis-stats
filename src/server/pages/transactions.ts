import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { fmtInt, shortHash, fmtTime, atomic } from "../../client/format";
import { srvSort, TX_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { PAGE_SIZE, pager, entityTag, resultBadge } from "./shared";

export const transactions = new Hono<{ Bindings: Env }>();

transactions.get("/transactions", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const TX_TYPES = ["transfer", "burn", "invoke_contract", "deploy_contract", "multisig"];
  const rawType = c.req.query("type") ?? "";
  const type = TX_TYPES.includes(rawType) ? rawType : "";
  const result = c.req.query("result") === "ok" || c.req.query("result") === "fail" ? c.req.query("result")! : "";
  const db = c.env.DB;
  const srt = srvSort((n) => c.req.query(n), TX_COLS, "block", "hash", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (result) p.set("result", result);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/transactions?${q}` : "/transactions";
  });

  let rows: Record<string, unknown>[] = [];
  let total = 0;
  try {
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (type) { conds.push("tx_type = ?"); binds.push(type); }
    if (result === "ok") { conds.push("result = ?"); binds.push("ok"); }
    if (result === "fail") { conds.push("result IS NOT NULL AND result <> ?"); binds.push("ok"); }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    total = await db.prepare(`SELECT COUNT(*) AS n FROM tx_index ${where}`).bind(...binds).first<{ n: number }>().then((r) => r?.n ?? 0);
    rows = await db.prepare(`SELECT * FROM tx_index ${where} ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* db not ready */ }
  const hasMore = rows.length > PAGE_SIZE;
  rows = rows.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fActive = !!type || !!result;
  const fFields = `
    ${filterField("Transaction type", `<select name="type">${selectOpts(TX_TYPES, type, "all types")}</select>`)}
    ${filterField("Result", `<select name="result"><option value=""${result === "" ? " selected" : ""}>any result</option><option value="ok"${result === "ok" ? " selected" : ""}>executed ok</option><option value="fail"${result === "fail" ? " selected" : ""}>failed</option></select>`)}
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
        <td>${resultBadge(t.result)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No indexed transactions yet — backfill pending.</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Transactions <span style="color:var(--text-dim)">${fmtInt(total)} total</span></h2>
      ${filterButton("f-txs", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th>Hash</th>${srt.th("block", "Block")}${srt.th("time", "Time")}${srt.th("type", "Type")}${srt.th("sender", "Sender")}${srt.th("fee", "Fee (XEL)", true)}${srt.th("result", "Result")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;
  return c.html(layout("Transactions", content, "/transactions"));
});
