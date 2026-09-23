import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";

export const market = new Hono<{ Bindings: Env }>();

market.get("/market", async (c) => {
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
    <div class="panel"><h2>Price history</h2><div id="u-price-history" style="min-height:260px"><div class="w-skel sk-chart">${[42, 66, 38, 74, 55, 84, 61, 90, 70, 52, 78, 46].map((h) => `<span class="sk-bar sk-col" style="height:${h}%"></span>`).join("")}</div></div></div>`;
  return c.html(layout("Market", content, "/market"));
});
