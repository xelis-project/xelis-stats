import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { fmt, fmtInt, shortHash } from "../../client/format";
import { srvSort, TOP_COLS } from "../sort";
import { filterButton, filterPop, filterField } from "../filters";
import { entityTag, num, PAGE_SIZE, pager } from "./shared";

export const miners = new Hono<{ Bindings: Env }>();

miners.get("/miners", async (c) => {
  const period = c.req.query("period") ?? "day";
  const date = c.req.query("date") ?? "";
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const db = c.env.DB;
  const srt = srvSort((n) => c.req.query(n), TOP_COLS.miners, "blocks", "address", (s) => {
    const p = new URLSearchParams();
    p.set("period", period);
    if (date) p.set("date", date);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/miners?${q}` : "/miners";
  });

  // Day views anchor on the latest day that actually has data so the
  // leaderboard stays populated while live indexing lags behind "today".
  let resolvedDay = "";
  const latestDay = async (): Promise<string> => {
    if (resolvedDay) return resolvedDay;
    const row = await db.prepare(
      "SELECT COALESCE((SELECT MAX(date) FROM daily_miners), (SELECT date(MAX(ts)/1000,'unixepoch') FROM blocks), date('now')) AS d"
    ).first<{ d: string }>();
    resolvedDay = row?.d ?? new Date().toISOString().slice(0, 10);
    return resolvedDay;
  };

  let rows: Record<string, unknown>[] = [];
  let total = 0;
  try {
    if (period === "all") {
      total = await db.prepare(`SELECT COUNT(DISTINCT address) n FROM daily_miners`)
        .first<{ n: number }>().then((r) => num(r?.n)).catch(() => 0);
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners GROUP BY address ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
        .bind(PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    } else if (period === "month") {
      const month = date || new Date().toISOString().slice(0, 7);
      total = await db.prepare(`SELECT COUNT(DISTINCT address) n FROM daily_miners WHERE date LIKE ? || '%'`)
        .bind(month).first<{ n: number }>().then((r) => num(r?.n)).catch(() => 0);
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners WHERE date LIKE ? || '%' GROUP BY address ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
        .bind(month, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    } else if (period === "week") {
      total = await db.prepare(`SELECT COUNT(DISTINCT address) n FROM daily_miners WHERE date > date(?, '-7 days')`)
        .bind(date || new Date().toISOString().slice(0, 10))
        .first<{ n: number }>().then((r) => num(r?.n)).catch(() => 0);
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners WHERE date > date(?, '-7 days') GROUP BY address ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
        .bind(date || new Date().toISOString().slice(0, 10), PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    } else {
      const day = date || await latestDay();
      total = await db.prepare(`SELECT COUNT(DISTINCT address) n FROM daily_miners WHERE date = ?`)
        .bind(day).first<{ n: number }>().then((r) => num(r?.n)).catch(() => 0);
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners WHERE date = ? GROUP BY address ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
        .bind(day, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    }
  } catch { /* db not ready */ }

  const dateHint = period === "month" ? "YYYY-MM" : period === "day" || period === "week" ? "YYYY-MM-DD" : "";

  const periodOpts = ["day", "week", "month", "all"].map((p) =>
    `<option value="${p}" ${period === p ? "selected" : ""}>${p}</option>`).join("");

  const body = rows.length
    ? rows.map((r, i) => `<tr>
        <td class="num">${(page - 1) * PAGE_SIZE + i + 1}</td>
        <td><a class="mono" href="/miner/${r.address}">${shortHash(r.address as string, 10)}</a>${entityTag(r.address as string)}</td>
        <td class="num">${fmtInt(r.blocks as number)}</td>
        <td class="num">${fmt((r.rewards as number) / 1e8)}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" style="color:var(--text-dim)">No indexed miners yet — backfill pending.</td></tr>`;

  const fActive = period !== "day" || !!date;
  const fFields = `
    ${filterField("Period", `<select name="period">${periodOpts}</select>`)}
    ${dateHint ? filterField(`Anchor date <span class="f-hint">(${dateHint})</span>`, `<input type="text" name="date" data-datepicker placeholder="${dateHint}" value="${date || (period === "day" ? resolvedDay : "")}" />`) : ""}
  `;
  const fPop = filterPop("f-miners", "/miners", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/miners${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const pParams = new URLSearchParams();
  pParams.set("period", period);
  if (date) pParams.set("date", date);
  if (srt.qs) for (const [k, v] of new URLSearchParams(srt.qs)) pParams.set(k, v);
  const pQs = pParams.toString();
  const pageBase = `/miners${pQs ? `?${pQs}` : ""}`;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

const content = `<div class="panel">
    <div class="panel-head">
      <h2>Miner leaderboard</h2>
      ${filterButton("f-miners", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th class="num">#</th>${srt.th("address", "Miner")}${srt.th("blocks", "Blocks", true)}${srt.th("rewards", "Rewards (XEL)", true)}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(pageBase, page, totalPages)}
  </div>`;
  return c.html(layout("Miners", content, "/miners"));
});
