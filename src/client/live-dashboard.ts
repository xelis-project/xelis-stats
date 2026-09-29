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
  liveTxTypesHtml,
  liveMinerPieHtml,
  liveNodeTipHtml,
  type LiveData,
} from "./live-render";

const POLL_MS = 5000;

// Fixed-position hover card for the tip-window nodes. It lives on <body> so the
// DAG re-renders never wipe it, and follows the cursor with edge flipping.
function initNodeTip(dag: HTMLElement, onHide: (fn: () => void) => void): void {
  const tip = document.createElement("div");
  tip.className = "live-node-tip";
  tip.hidden = true;
  document.body.appendChild(tip);

  const hide = (): void => { tip.hidden = true; };
  onHide(hide);

  const place = (x: number, y: number): void => {
    const pad = 14;
    const r = tip.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  };

  const nodeFrom = (ev: Event): HTMLElement | null => {
    const target = ev.target as Element | null;
    const node = target?.closest<HTMLElement>(".live-node[data-topo]") ?? null;
    return node && dag.contains(node) ? node : null;
  };

  const show = (node: HTMLElement, x: number, y: number): void => {
    tip.innerHTML = liveNodeTipHtml(node.dataset);
    tip.hidden = false;
    place(x, y);
  };

  dag.addEventListener("pointerover", (ev) => {
    if (ev.pointerType === "touch") return;
    const node = nodeFrom(ev);
    if (node) show(node, ev.clientX, ev.clientY);
  });
  dag.addEventListener("pointermove", (ev) => {
    if (tip.hidden || ev.pointerType === "touch") return;
    const node = nodeFrom(ev);
    if (node) place(ev.clientX, ev.clientY);
  });
  dag.addEventListener("pointerout", (ev) => {
    const node = nodeFrom(ev);
    if (!node) return;
    const to = ev.relatedTarget as Node | null;
    if (to && node.contains(to)) return;
    hide();
  });
  dag.addEventListener("focusin", (ev) => {
    const node = nodeFrom(ev);
    if (!node) return;
    const r = node.getBoundingClientRect();
    show(node, r.left + r.width / 2, r.bottom);
  });
  dag.addEventListener("focusout", hide);
}

export function initLiveDashboard(): void {
  const stats = document.getElementById("live-stats");
  if (!stats) return;

  let inFlight = false;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Whether the DAG has already been rendered once, so the initial paint stays
  // still and only later updates animate.
  let dagPainted = false;
  let hideTip: () => void = () => {};

  const dagEl = document.getElementById("live-dag");
  if (dagEl) initNodeTip(dagEl, (fn) => { hideTip = fn; });

  function set(id: string, html: string): void {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }

  // Animate the DAG in place: nodes that survived the refresh glide from their
  // old spot to the new one (FLIP), and freshly arrived nodes pop in.
  function renderDag(d: LiveData): void {
    const el = document.getElementById("live-dag");
    if (!el) return;
    hideTip();
    const before = new Map<number, DOMRect>();
    if (dagPainted && !reduceMotion) {
      el.querySelectorAll<HTMLElement>(".live-node[data-topo]").forEach((node) => {
        before.set(Number(node.dataset.topo), node.getBoundingClientRect());
      });
    }
    el.innerHTML = liveDagHtml(d);
    const animate = dagPainted && !reduceMotion;
    dagPainted = true;
    if (!animate) return;
    el.querySelectorAll<HTMLElement>(".live-node[data-topo]").forEach((node) => {
      const prev = before.get(Number(node.dataset.topo));
      if (!prev) {
        node.classList.add("live-node-enter");
        return;
      }
      const now = node.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (!dx && !dy) return;
      node.style.transition = "none";
      node.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        node.style.transition = "transform 320ms cubic-bezier(0.22, 1, 0.36, 1)";
        node.style.transform = "";
      });
      node.addEventListener("transitionend", () => {
        node.style.transition = "";
        node.style.transform = "";
      }, { once: true });
    });
  }

  function render(d: LiveData): void {
    set("live-stats", liveStatsHtml(d));
    renderDag(d);
    set("live-blocks", liveBlocksRowsHtml(d));
    set("live-tx-types", liveTxTypesHtml(d));
    set("live-miner-pie", liveMinerPieHtml(d));
    set("live-mempool-summary", liveMempoolSummaryHtml(d));
    set("live-mempool", liveMempoolRowsHtml(d));
    set("live-recent-txs", liveRecentTxRowsHtml(d));
    // Rewrite time/hash styles in the freshly inserted nodes.
    window.dispatchEvent(new CustomEvent("xelis:format-change"));
  }

  async function refresh(): Promise<void> {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
      const res = await fetch("/api/live", { headers: { Accept: "application/json" } });
      const d = (await res.json()) as LiveData;
      render(d);
    } catch {
      // Keep the last good paint; the next poll retries.
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
