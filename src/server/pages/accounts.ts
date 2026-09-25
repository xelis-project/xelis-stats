import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { fmtInt, shortHash, fmtTime, timeCell, ago } from "../../client/format";
import { srvSort, ACCT_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { knownEntity, knownEntities } from "../entities";
import { PAGE_SIZE, pager, esc } from "./shared";

export const accounts = new Hono<{ Bindings: Env }>();

accounts.get("/accounts", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  // legacy ?sort=active|txs|first URLs map onto the same columns and defaults
  const minTxsRaw = Number(c.req.query("min_txs") ?? "");
  const minTxs = Number.isFinite(minTxsRaw) && minTxsRaw > 0 ? Math.floor(minTxsRaw) : 0;
  // known-addresses filter: "only" keeps tagged entities, "hide" excludes them
  const knownRaw = c.req.query("known") ?? "";
  const known = knownRaw === "only" || knownRaw === "hide" ? knownRaw : "";
  const srt = srvSort((n) => c.req.query(n), ACCT_COLS, "last", "address", (s) => {
    const p = new URLSearchParams();
    if (minTxs) p.set("min_txs", String(minTxs));
    if (known) p.set("known", known);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/accounts?${q}` : "/accounts";
  });
  const db = c.env.DB;
  let rows: Record<string, unknown>[];
  let total = 0;
  try {
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (minTxs) { conds.push("tx_count >= ?"); binds.push(minTxs); }
    if (known) {
      const knownAddrs = knownEntities.map((e) => e.address);
      conds.push(`address ${known === "only" ? "IN" : "NOT IN"} (${knownAddrs.map(() => "?").join(",")})`);
      binds.push(...knownAddrs);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    total = await db.prepare(`SELECT COUNT(*) AS n FROM accounts ${where}`).bind(...binds).first<{ n: number }>().then((r) => r?.n ?? 0);
    rows = await db.prepare(`SELECT address, first_seen, last_active, tx_count FROM accounts ${where} ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch {
    rows = [];
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fFields = `
    ${filterField("Min sent txs", `<input type="number" name="min_txs" min="0" step="1" placeholder="e.g. 10" value="${minTxs || ""}" />`)}
    ${filterField("Known addresses", `<select name="known">${selectOpts(["only", "hide"], known, "all addresses", (v) => v === "only" ? "known only" : "hide known")}</select>`)}
  `;
  const fPop = filterPop("f-accounts", "/accounts", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/accounts${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((a) => {
        const addr = a.address as string;
        const e = knownEntity(addr);
        return `<tr>
          <td><a href="/account/${addr}"><span class="hash">${shortHash(addr)}</span></a>${e ? ` <span class="badge entity ${esc(e.kind)}">${esc(e.label)}</span>` : ""}</td>
          <td>${timeCell(a.first_seen as number)}</td>
          <td>${timeCell((a.last_active as number) ?? null)}</td>
          <td class="num">${fmtInt(a.tx_count as number)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" style="color:var(--text-dim)">No observed accounts yet.</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Accounts <span style="color:var(--text-dim)">${fmtInt(total)} observed</span></h2>
      ${filterButton("f-accounts", minTxs > 0 || !!known)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr>${srt.th("address", "Address")}${srt.th("first", "First seen")}${srt.th("last", "Last active")}${srt.th("txs", "Txs", true)}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;
  return c.html(layout("Accounts", content, "/accounts"));
});
