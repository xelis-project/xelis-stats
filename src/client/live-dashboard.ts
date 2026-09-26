// Keeps the / page moving. The page is server-rendered from the node on
// first paint; this poller refreshes it every few seconds (and immediately when
// the header WebSocket reports a new block), re-rendering with the same
// helpers the server used.

import {
  liveStatsHtml,
  liveDagHtml,
  liveBlocksRowsHtml,
  liveMempoolSummaryHtml,
  liveMempoolRowsHtml,
  liveRecentTxRowsHtml,
  liveMetaHtml,
  type LiveData,
} from "./live-render";

const POLL_MS = 5000;

export function initLiveDashboard(): void {
  const stats = document.getElementById("live-stats");
  if (!stats) return;

  const meta = document.getElementById("live-meta");
  const status = document.getElementById("live-page-status");
  if (!meta || !status) return;
  const metaEl = meta;
  const statusEl = status;
  let inFlight = false;
  let failures = 0;

  function set(id: string, html: string): void {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  function render(d: LiveData): void {
    set("live-stats", liveStatsHtml(d));
    set("live-dag", liveDagHtml(d));
    set("live-blocks", liveBlocksRowsHtml(d));
    set("live-mempool-summary", liveMempoolSummaryHtml(d));
    set("live-mempool", liveMempoolRowsHtml(d));
    set("live-recent-txs", liveRecentTxRowsHtml(d));
    metaEl.innerHTML = liveMetaHtml(d);
    statusEl.innerHTML = d.ok ? '<span class="live-dot on"></span>live' : '<span class="live-dot off"></span>offline';
    // Rewrite time/hash styles in the freshly inserted nodes.
    window.dispatchEvent(new CustomEvent("xelis:format-change"));
  }

  async function refresh(): Promise<void> {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
      const res = await fetch("/api/live", { headers: { Accept: "application/json" } });
      const d = (await res.json()) as LiveData;
      failures = 0;
      render(d);
    } catch {
      failures += 1;
      if (failures >= 2) statusEl.innerHTML = '<span class="live-dot off"></span>offline';
    } finally {
      inFlight = false;
    }
  }

  refresh();
  window.setInterval(() => { void refresh(); }, POLL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  // The shared header WebSocket dispatches this whenever a block/tick arrives.
  window.addEventListener("xelis:chain-tip", () => { void refresh(); });
}
