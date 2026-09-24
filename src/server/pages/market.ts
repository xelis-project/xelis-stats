import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";

export const market = new Hono<{ Bindings: Env }>();

market.get("/market", async (c) => {
  let retired: { name: string; addedTs: number | null; retiredTs: number | null }[] = [];
  try {
    const rows = await c.env.DB.prepare(
      "SELECT name, added_ts, retired_ts FROM exchanges WHERE status = 'inactive' ORDER BY name",
    ).all<{ name: string; added_ts: number | null; retired_ts: number | null }>();
    retired = (rows.results ?? []).map((r) => ({ name: r.name, addedTs: r.added_ts, retiredTs: r.retired_ts }));
  } catch { /* db not ready */ }
  const fmtDay = (ts: number | null) => (ts ? new Date(ts).toISOString().slice(0, 10) : "");
  const retiredRows = retired.map((r) => {
    const span = r.addedTs
      ? `${fmtDay(r.addedTs)} → ${fmtDay(r.retiredTs) || "present"}`
      : "no historical data";
    return `<tr><td>${r.name}</td><td>${span}</td></tr>`;
  }).join("");
  const retiredPanel = retired.length
    ? `<div class="panel"><h2>Retired exchanges</h2>
       <div class="tablewrap"><table id="retired-table">
         <thead><tr><th>Exchange</th><th>Tracked period</th></tr></thead>
         <tbody>${retiredRows}</tbody>
       </table></div></div>`
    : "";
  const priceHistoryPanel = `<div class="panel"><h2>Price history</h2><div id="u-price-history" style="min-height:260px"><div class="w-skel sk-chart">${[42, 66, 38, 74, 55, 84, 61, 90, 70, 52, 78, 46].map((h) => `<span class="sk-bar sk-col" style="height:${h}%"></span>`).join("")}</div></div></div>`;
  const historyRow = retiredPanel
    ? `<div class="grid-2">${priceHistoryPanel}${retiredPanel}</div>`
    : priceHistoryPanel;
  const content = `
    <div class="panel"><h2>XEL Markets</h2>
      <div id="market-cards" class="cards">${Array.from({ length: 5 }, () =>
        '<div class="card sk-card"><span class="sk-bar sk-cl"></span><span class="sk-bar sk-cv"></span></div>').join("")}</div>
      <div class="tablewrap"><table id="market-table">
        <thead><tr><th>Exchange</th><th>Market</th><th class="num">Last</th><th class="num">24h %</th><th class="num">High</th><th class="num">Low</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Vol (XEL)</th><th class="num">Vol (USDT)</th><th>Updated</th></tr></thead>
        <tbody>${Array.from({ length: 6 }, (_, i) =>
          `<tr class="sk-tr"><td colspan="11"><div class="sk-row"><span class="sk-bar sk-c1"></span><span class="sk-bar sk-c2" style="width:${i % 2 ? 9 : 13}%"></span></div></td></tr>`).join("")}</tbody>
      </table></div>
      <h3 class="sub-h">Volume share</h3>
      <div id="market-volshare" class="volshare"></div>
      <div id="market-volshare-legend" class="volshare-legend"></div>
    </div>
    ${historyRow}`;
  return c.html(layout("Market", content, "/market"));
});
