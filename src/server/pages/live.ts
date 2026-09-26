import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { getLive } from "../live";
import {
  liveStatsHtml,
  liveDagHtml,
  liveBlocksRowsHtml,
  liveMempoolSummaryHtml,
  liveMempoolRowsHtml,
  liveRecentTxRowsHtml,
  liveTxTypesHtml,
} from "../../client/live-render";

export const livePage = new Hono<{ Bindings: Env }>();

livePage.get("/", async (c) => {
  // Initial paint straight from the node; the client poller keeps it moving.
  const live = await getLive(c.env);

  const content = `<div class="live-cards" id="live-stats">${liveStatsHtml(live)}</div>
  <div class="panel">
    <div class="panel-head"><h2>Unstable window</h2><span class="live-hint">newest blocks at the tip · click a node to inspect</span></div>
    <div id="live-dag">${liveDagHtml(live)}</div>
  </div>
  <div class="grid-2 live-split">
    <div class="panel">
      <div class="panel-head"><h2>Recent blocks</h2></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Topo</th><th class="num">Height</th><th>Age</th><th class="num">Txs</th><th>Type</th><th>Status</th><th class="num">Reward</th><th>Miner</th></tr></thead>
        <tbody id="live-blocks">${liveBlocksRowsHtml(live)}</tbody>
      </table></div>
    </div>
    <div class="live-col">
      <div class="panel">
        <div class="panel-head"><h2>Mempool</h2></div>
        <div id="live-mempool-summary">${liveMempoolSummaryHtml(live)}</div>
        <div class="live-divider"></div>
        <div class="tablewrap scroll-y"><table>
          <thead><tr><th>Tx</th><th>Sender</th><th class="num">Fee</th><th class="num">Size</th><th class="num">Fee/KB</th><th>First seen</th></tr></thead>
          <tbody id="live-mempool">${liveMempoolRowsHtml(live)}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Transactions by type</h2></div>
        <div id="live-tx-types">${liveTxTypesHtml(live)}</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Recent txs</h2></div>
        <div class="tablewrap scroll-y"><table>
          <thead><tr><th>Tx</th><th>Block</th><th>Type</th><th>Sender</th><th class="num">Fee</th><th class="num">Size</th></tr></thead>
          <tbody id="live-recent-txs">${liveRecentTxRowsHtml(live)}</tbody>
        </table></div>
      </div>
    </div>
  </div>`;

  return c.html(layout("Live", content, "/"));
});
