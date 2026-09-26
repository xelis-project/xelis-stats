// Interactive block-DAG viewer for /dag.
//
// Renders the DAG as height columns (multiple blocks sharing a height stack
// vertically) with tip edges drawn between a block and its parents, using a 2D
// canvas with drag-pan and scroll-zoom. History windows come from the indexed
// blocks table via /api/dag; live mode mirrors the node's unstable/stable window
// from /api/live and re-polls when the shared header WebSocket reports a tip.

import { fmt, fmtInt, fmtBytes, atomic, fmtTime, ago, shortHash } from "./format";
import type { LiveData } from "./live-render";

interface DagBlock {
  topo: number;
  height: number;
  hash: string;
  ts: number;
  type: string;
  tips: string[];
  txs: number;
  difficulty: number;
  size: number;
  miner: string;
  reward: number;
  stable: boolean;
}

interface DagData {
  center: number;
  lo: number;
  hi: number;
  tip: number | null;
  stable: number | null;
  blocks: DagBlock[];
}

interface Placement { block: DagBlock; x: number; y: number; }
interface Column { height: number; x: number; bottom: number; minTopo: number; maxTopo: number; count: number; }

const BOX = 42;
const HALF = BOX / 2;
const COL = 92;
const ROW = 82;
const SPAN = 100;
const EDGE = "rgba(36, 64, 61, 0.95)";
const EDGE_HL = "#f5f7fb";
const GRID = "rgba(245, 247, 251, 0.05)";

// Same palette as the live-strip nodes in style.css.
const TYPE_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  normal: { fill: "rgba(2, 255, 207, 0.20)", stroke: "rgba(2, 255, 207, 0.85)", text: "#02ffcf" },
  side: { fill: "rgba(245, 217, 95, 0.22)", stroke: "rgba(245, 217, 95, 0.9)", text: "#f5d95f" },
  sync: { fill: "rgba(127, 167, 255, 0.22)", stroke: "rgba(127, 167, 255, 0.9)", text: "#7fa7ff" },
};

const typeStyle = (type: string) => TYPE_STYLE[type.toLowerCase()] ?? TYPE_STYLE.normal;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function initDag(): void {
  const app = document.getElementById("dag-app");
  const viewport = document.getElementById("dag-viewport");
  const canvas = document.getElementById("dag-canvas") as HTMLCanvasElement | null;
  if (!app || !viewport || !canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const $ = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;
  const input = $<HTMLInputElement>("dag-input");
  const goBtn = $<HTMLButtonElement>("dag-go");
  const prevBtn = $<HTMLButtonElement>("dag-prev");
  const nextBtn = $<HTMLButtonElement>("dag-next");
  const liveBtn = $<HTMLButtonElement>("dag-live");
  const fitBtn = $<HTMLButtonElement>("dag-fit");
  const zinBtn = $<HTMLButtonElement>("dag-zin");
  const zoutBtn = $<HTMLButtonElement>("dag-zout");
  const fsBtn = $<HTMLButtonElement>("dag-fs");
  const statusEl = $("dag-status");
  const loadingEl = $("dag-loading");
  const hoverEl = $("dag-hover");
  const detailEl = $("dag-detail");
  if (!input || !goBtn || !prevBtn || !nextBtn || !liveBtn || !fitBtn || !zinBtn || !zoutBtn || !fsBtn || !statusEl || !loadingEl || !hoverEl || !detailEl) return;
  const hover = hoverEl;
  const detail = detailEl;
  const status = statusEl;
  const loading = loadingEl;
  const liveButton = liveBtn;
  // Aliases keep the non-null element types inside hoisted functions (TS does
  // not carry the guard narrowing into function declarations).
  const vpEl = viewport;
  const cvEl = canvas;
  const inpEl = input;

  let W = 1;
  let H = 1;
  let dpr = 1;
  const cam = { x: 0, y: 0, k: 1 };

  let data: DagData = { center: 0, lo: 0, hi: 0, tip: null, stable: null, blocks: [] };
  let placements: Placement[] = [];
  let columns: Column[] = [];
  let byHash = new Map<string, DagBlock>();
  let placementByHash = new Map<string, Placement>();
  let hovered: DagBlock | null = null;
  let selected: DagBlock | null = null;
  let live = false;
  let livePainted = false;
  let inFlight = false;
  let liveTimer: number | undefined;
  let tipTimer: number | undefined;

  // ---------- camera / transforms ----------

  const sx = (wx: number): number => (wx - cam.x) * cam.k + W / 2;
  const sy = (wy: number): number => (wy - cam.y) * cam.k + H / 2;

  // Fill the visible area below the floating site header (or the whole screen in
  // fullscreen). Recomputed on window resize so the canvas always spans the
  // viewport like a dedicated DAG viewer, rather than a fixed-height panel.
  function fitViewportHeight(): void {
    const top = vpEl.getBoundingClientRect().top;
    const h = Math.round(window.innerHeight - top - 12);
    vpEl.style.height = `${Math.max(300, h)}px`;
  }

  function resize(): void {
    const rect = vpEl.getBoundingClientRect();
    W = Math.max(1, Math.floor(rect.width));
    H = Math.max(1, Math.floor(rect.height));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cvEl.width = Math.floor(W * dpr);
    cvEl.height = Math.floor(H * dpr);
    cvEl.style.width = `${W}px`;
    cvEl.style.height = `${H}px`;
    draw();
  }

  function fitView(): void {
    if (!placements.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of placements) {
      minX = Math.min(minX, p.x - HALF); maxX = Math.max(maxX, p.x + HALF);
      minY = Math.min(minY, p.y - HALF); maxY = Math.max(maxY, p.y + HALF);
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    cam.k = clamp(Math.min((W - 80) / bw, (H - 90) / bh), 0.08, 3);
    cam.x = (minX + maxX) / 2;
    cam.y = (minY + maxY) / 2;
    draw();
  }

  const defaultZoom = (): number => clamp((W - 48) / (16 * COL), 0.3, 1.5);

  function centerOn(block: DagBlock, zoom?: number): void {
    const p = placementByHash.get(block.hash);
    if (!p) return;
    if (zoom) cam.k = clamp(zoom, 0.08, 3);
    cam.x = p.x;
    cam.y = 0;
    draw();
  }

  function zoomAt(px: number, py: number, factor: number): void {
    const wx = (px - W / 2) / cam.k + cam.x;
    const wy = (py - H / 2) / cam.k + cam.y;
    cam.k = clamp(cam.k * factor, 0.08, 4);
    cam.x = wx - (px - W / 2) / cam.k;
    cam.y = wy - (py - H / 2) / cam.k;
    draw();
  }

  // ---------- layout ----------

  function computeLayout(): void {
    placements = [];
    columns = [];
    placementByHash = new Map();
    byHash = new Map();
    for (const b of data.blocks) byHash.set(b.hash, b);

    const groups = new Map<number, DagBlock[]>();
    for (const b of data.blocks) {
      const arr = groups.get(b.height);
      if (arr) arr.push(b);
      else groups.set(b.height, [b]);
    }
    const heights = [...groups.keys()].sort((a, b) => a - b);
    heights.forEach((height, colIndex) => {
      const arr = groups.get(height)!;
      arr.sort((a, b) => a.topo - b.topo);
      const x = colIndex * COL;
      const bottom = ((arr.length - 1) / 2) * ROW + HALF;
      columns.push({
        height,
        x,
        bottom,
        minTopo: arr[0].topo,
        maxTopo: arr[arr.length - 1].topo,
        count: arr.length,
      });
      arr.forEach((b, i) => {
        const y = (i - (arr.length - 1) / 2) * ROW;
        const p: Placement = { block: b, x, y };
        placements.push(p);
        placementByHash.set(b.hash, p);
      });
    });
  }

  // ---------- drawing ----------

  function draw(): void {
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx!.clearRect(0, 0, W, H);
    if (!placements.length) return;
    drawGrid();
    drawEdges();
    drawBoxes();
    drawColumns();
    drawStabilityLine();
  }

  function drawGrid(): void {
    ctx!.strokeStyle = GRID;
    ctx!.lineWidth = 1;
    for (const c of columns) {
      const px = Math.round(sx(c.x)) + 0.5;
      if (px < -2 || px > W + 2) continue;
      ctx!.beginPath();
      ctx!.moveTo(px, 0);
      ctx!.lineTo(px, H);
      ctx!.stroke();
    }
    const py = Math.round(sy(0)) + 0.5;
    ctx!.beginPath();
    ctx!.moveTo(0, py);
    ctx!.lineTo(W, py);
    ctx!.stroke();
  }

  // Point where a ray leaving a box center toward another point crosses the
  // box border, so edges can stop at the block instead of running under it.
  function boxExit(x1: number, y1: number, x2: number, y2: number): { x: number; y: number } {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    if (m === 0) return { x: x1, y: y1 };
    const t = HALF / m;
    return { x: x1 + dx * t, y: y1 + dy * t };
  }

  function drawEdges(): void {
    for (const p of placements) {
      for (const tip of p.block.tips) {
        const q = placementByHash.get(tip);
        if (!q) continue;
        const hl = (hovered && (hovered === p.block || hovered === q.block))
          || (selected && (selected === p.block || selected === q.block));
        // Highlighted edges are drawn from border to border so the line stays
        // behind the block faces instead of showing through the translucent fill.
        const a = hl ? boxExit(p.x, p.y, q.x, q.y) : p;
        const b = hl ? boxExit(q.x, q.y, p.x, p.y) : q;
        ctx!.strokeStyle = hl ? EDGE_HL : EDGE;
        ctx!.lineWidth = hl ? Math.max(1.6, cam.k * 1.6) : Math.max(1, cam.k);
        ctx!.beginPath();
        ctx!.moveTo(sx(a.x), sy(a.y));
        ctx!.lineTo(sx(b.x), sy(b.y));
        ctx!.stroke();
      }
    }
  }

  function drawBoxes(): void {
    const size = BOX * cam.k;
    const showLetter = cam.k >= 0.34;
    const showTopo = cam.k >= 0.5;
    const showHash = cam.k >= 0.85;
    for (const p of placements) {
      const b = p.block;
      const st = typeStyle(b.type);
      const x = sx(p.x - HALF);
      const y = sy(p.y - HALF);
      if (x > W + size || y > H + size || x + size < -size || y + size < -size) continue;
      const isHover = hovered === b;
      const isSel = selected === b;

      ctx!.save();
      roundRect(ctx!, x, y, size, size, Math.max(2, size * 0.18));
      ctx!.fillStyle = st.fill;
      ctx!.fill();
      if (!b.stable) ctx!.setLineDash([Math.max(3, size * 0.16), Math.max(2, size * 0.12)]);
      ctx!.lineWidth = isSel || isHover ? Math.max(2, size * 0.07) : 1.4;
      ctx!.strokeStyle = isSel || isHover ? "#f5f7fb" : st.stroke;
      ctx!.stroke();
      ctx!.restore();

      const cx = x + size / 2;
      const cy = y + size / 2;
      ctx!.textAlign = "center";
      ctx!.textBaseline = "middle";

      if (showLetter) {
        ctx!.fillStyle = st.text;
        ctx!.font = `700 ${clamp(size * 0.42, 9, 20)}px "JetBrains Mono", monospace`;
        ctx!.fillText(b.type.charAt(0).toUpperCase(), cx, cy + size * 0.02);
      }
      if (showTopo) {
        ctx!.fillStyle = "rgba(245, 247, 251, 0.7)";
        ctx!.font = `${clamp(size * 0.24, 8, 12)}px "JetBrains Mono", monospace`;
        ctx!.fillText(String(b.topo), cx, y + size + clamp(size * 0.3, 7, 12));
      }
      if (showHash) {
        ctx!.fillStyle = "rgba(245, 247, 251, 0.5)";
        ctx!.font = `${clamp(size * 0.22, 8, 11)}px "JetBrains Mono", monospace`;
        ctx!.fillText(b.hash.slice(-4), cx, y - clamp(size * 0.26, 7, 11));
      }
    }
  }

  function drawColumns(): void {
    if (cam.k < 0.2) return;
    const fs = clamp(cam.k * 12, 8, 14);
    ctx!.textAlign = "center";
    ctx!.textBaseline = "top";
    ctx!.font = `700 ${fs}px "JetBrains Mono", monospace`;
    for (const c of columns) {
      const px = sx(c.x);
      if (px < -40 || px > W + 40) continue;
      const py = sy(c.bottom) + clamp(cam.k * 20, 10, 22);
      ctx!.fillStyle = "rgba(245, 247, 251, 0.55)";
      ctx!.fillText(String(c.height), px, py);
      if (cam.k >= 0.45 && c.minTopo !== c.maxTopo) {
        ctx!.fillStyle = "rgba(155, 179, 178, 0.6)";
        ctx!.font = `${clamp(fs * 0.82, 7, 11)}px "JetBrains Mono", monospace`;
        ctx!.fillText(`${c.minTopo}–${c.maxTopo}`, px, py + fs * 1.3);
      }
    }
    ctx!.textBaseline = "middle";
  }

  function drawStabilityLine(): void {
    let stableMax = -Infinity;
    let hasUnstable = false;
    for (const p of placements) {
      if (p.block.stable) stableMax = Math.max(stableMax, p.block.height);
      else hasUnstable = true;
    }
    if (!hasUnstable || stableMax === -Infinity) return;
    const col = columns.find((c) => c.height === stableMax);
    if (!col) return;
    const px = Math.round(sx(col.x + COL / 2)) + 0.5;
    ctx!.save();
    ctx!.setLineDash([6, 5]);
    ctx!.strokeStyle = "rgba(245, 217, 95, 0.55)";
    ctx!.lineWidth = 1.5;
    ctx!.beginPath();
    ctx!.moveTo(px, 0);
    ctx!.lineTo(px, H);
    ctx!.stroke();
    ctx!.restore();
    ctx!.fillStyle = "rgba(245, 217, 95, 0.8)";
    ctx!.font = `700 ${clamp(cam.k * 11, 8, 12)}px "Jura", sans-serif`;
    ctx!.textAlign = "left";
    ctx!.textBaseline = "top";
    ctx!.fillText("stability boundary", px + 6, 8);
    ctx!.textBaseline = "middle";
  }

  // ---------- hit testing / hover ----------

  function hitTest(clientX: number, clientY: number): DagBlock | null {
    const rect = canvas!.getBoundingClientRect();
    const wx = (clientX - rect.left - W / 2) / cam.k + cam.x;
    const wy = (clientY - rect.top - H / 2) / cam.k + cam.y;
    let best: DagBlock | null = null;
    let bestD = Infinity;
    for (const p of placements) {
      const dx = Math.abs(wx - p.x);
      const dy = Math.abs(wy - p.y);
      if (dx <= HALF && dy <= HALF) {
        const d = dx + dy;
        if (d < bestD) { bestD = d; best = p.block; }
      }
    }
    return best;
  }

  function positionHover(clientX: number, clientY: number): void {
    const rect = vpEl.getBoundingClientRect();
    const x = clientX - rect.left + 16;
    const y = clientY - rect.top + 16;
    hover.style.left = `${Math.min(x, rect.width - 210)}px`;
    hover.style.top = `${Math.min(y, rect.height - 80)}px`;
  }

  function updateHover(clientX: number, clientY: number): void {
    if (!hovered) {
      hover.hidden = true;
      hover.innerHTML = "";
      return;
    }
    const b = hovered;
    const st = typeStyle(b.type);
    hover.hidden = false;
    hover.innerHTML = `<div class="dag-hover-topo">Block ${fmtInt(b.topo)}</div>
      <div class="dag-hover-row"><span class="dag-hover-dot" style="background:${st.text}"></span>${esc(b.type)} · ${fmtInt(b.txs)} tx</div>
      <div class="dag-hover-row">${esc(shortHash(b.hash, 10))} · ${esc(ago(b.ts))}</div>
      <div class="dag-hover-row dag-hover-dim">click for details</div>`;
    positionHover(clientX, clientY);
  }

  function select(b: DagBlock | null): void {
    selected = b;
    renderDetail(b);
    draw();
  }

  function renderDetail(b: DagBlock | null): void {
    if (!b) {
      detail.hidden = true;
      detail.innerHTML = "";
      return;
    }
    const st = typeStyle(b.type);
    const stableBadge = b.stable
      ? '<span class="badge normal">stable</span>'
      : '<span class="badge unstable">unstable</span>';
    detail.hidden = false;
    detail.innerHTML = `<div class="dag-detail-head">
        <span class="dag-detail-title">Block <a href="/block/${b.topo}"><span class="mint">#${fmtInt(b.topo)}</span></a></span>
        <span class="badge ${esc(b.type.toLowerCase())}">${esc(b.type)}</span>${stableBadge}
      </div>
      <div class="dag-detail-grid">
        <div class="dag-detail-item"><span class="k">Hash</span><span class="v mono"><a href="/block/${esc(b.hash)}">${esc(shortHash(b.hash, 16))}</a></span></div>
        <div class="dag-detail-item"><span class="k">Height</span><span class="v">${fmtInt(b.height)}</span></div>
        <div class="dag-detail-item"><span class="k">Time</span><span class="v">${esc(fmtTime(b.ts))} · ${esc(ago(b.ts))}</span></div>
        <div class="dag-detail-item"><span class="k">Transactions</span><span class="v">${fmtInt(b.txs)}</span></div>
        <div class="dag-detail-item"><span class="k">Difficulty</span><span class="v">${fmt(b.difficulty)}</span></div>
        <div class="dag-detail-item"><span class="k">Size</span><span class="v">${fmtBytes(b.size)}</span></div>
        <div class="dag-detail-item"><span class="k">Reward</span><span class="v">${atomic(b.reward)} XEL</span></div>
        <div class="dag-detail-item"><span class="k">Miner</span><span class="v mono">${b.miner ? `<a href="/miner/${esc(b.miner)}">${esc(shortHash(b.miner, 12))}</a>` : "—"}</span></div>
        <div class="dag-detail-item"><span class="k">DAG tips</span><span class="v">${fmtInt(b.tips.length)}</span></div>
      </div>`;
  }

  // ---------- data loading ----------

  function applyData(next: DagData, recenter: boolean): void {
    data = next;
    computeLayout();
    if (selected) {
      const again = byHash.get(selected.hash) ?? null;
      selected = again;
      renderDetail(again);
    }
    if (hovered) hovered = byHash.get(hovered.hash) ?? null;
    if (recenter) {
      inpEl.value = String(next.center);
      const near = nearestTo(next.center);
      cam.k = defaultZoom();
      if (near) {
        const p = placementByHash.get(near.hash);
        cam.x = p ? p.x : 0;
      } else {
        cam.x = 0;
      }
      cam.y = 0;
      if (!placements.length) cam.x = 0;
    }
    updateStatus();
    draw();
  }

  function nearestTo(topo: number): DagBlock | null {
    let best: DagBlock | null = null;
    let bestD = Infinity;
    for (const b of data.blocks) {
      const d = Math.abs(b.topo - topo);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  function updateStatus(): void {
    const parts: string[] = [];
    if (data.blocks.length) {
      parts.push(`${data.blocks.length} block${data.blocks.length === 1 ? "" : "s"}`);
      parts.push(`topo ${fmtInt(data.lo)}–${fmtInt(data.hi)}`);
    } else {
      parts.push("no indexed blocks in this window");
    }
    if (data.tip != null) parts.push(`tip ${fmtInt(data.tip)}`);
    if (live) parts.push("live");
    status.textContent = parts.join(" · ");
  }

  function updateUrl(): void {
    try {
      const topo = live && data.tip != null ? data.tip : data.center;
      const qs = topo > 0 ? `?topo=${topo}` : "";
      history.replaceState(null, "", `/dag${qs}`);
    } catch { /* history unavailable */ }
  }

  async function loadHistory(center?: number): Promise<void> {
    setLive(false);
    const q = new URLSearchParams({ span: String(SPAN) });
    if (center && center > 0) q.set("center", String(Math.floor(center)));
    status.textContent = "loading…";
    loading.hidden = false;
    try {
      const res = await fetch(`/api/dag?${q.toString()}`, { headers: { Accept: "application/json" } });
      const d = (await res.json()) as DagData;
      applyData(d, true);
      updateUrl();
    } catch {
      status.textContent = "failed to load DAG window";
    } finally {
      loading.hidden = true;
    }
  }

  function fromLive(d: LiveData): DagData {
    const seen = new Set<number>();
    const blocks: DagBlock[] = [];
    for (const b of [...(d.boundary ?? []), ...(d.unstable ?? [])]) {
      if (seen.has(b.topoheight) || !b.hash) continue;
      seen.add(b.topoheight);
      blocks.push({
        topo: b.topoheight,
        height: b.height,
        hash: b.hash,
        ts: b.ts,
        type: b.block_type,
        tips: b.tips ?? [],
        txs: b.txs,
        difficulty: b.difficulty,
        size: b.size,
        miner: b.miner,
        reward: b.miner_reward + b.dev_reward,
        stable: b.stable,
      });
    }
    blocks.sort((a, b) => a.topo - b.topo);
    const tip = d.info?.topoheight ?? (blocks.length ? blocks[blocks.length - 1].topo : 0);
    return {
      center: tip,
      lo: blocks.length ? blocks[0].topo : 0,
      hi: blocks.length ? blocks[blocks.length - 1].topo : 0,
      tip,
      stable: d.info?.stable_topoheight ?? null,
      blocks,
    };
  }

  async function refreshLive(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    if (!livePainted) loading.hidden = false;
    try {
      const res = await fetch("/api/live", { headers: { Accept: "application/json" } });
      const d = (await res.json()) as LiveData;
      applyData(fromLive(d), !livePainted);
      livePainted = true;
      updateUrl();
    } catch {
      status.textContent = "live node unavailable — retrying";
    } finally {
      inFlight = false;
      loading.hidden = true;
    }
  }

  function startLivePoll(): void {
    stopLivePoll();
    liveTimer = window.setInterval(() => { void refreshLive(); }, 5000);
  }

  function stopLivePoll(): void {
    if (liveTimer !== undefined) {
      clearInterval(liveTimer);
      liveTimer = undefined;
    }
  }

  function setLive(on: boolean): void {
    live = on;
    liveButton.classList.toggle("on", on);
    liveButton.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) {
      livePainted = false;
      startLivePoll();
      void refreshLive();
    } else {
      stopLivePoll();
    }
  }

  // ---------- interaction ----------

  let pointerId = -1;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let panned = false;

  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pointerId = e.pointerId;
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    panned = false;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("grabbing");
    canvas.classList.remove("hovering");
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) {
      const b = hitTest(e.clientX, e.clientY);
      if (b !== hovered) {
        hovered = b;
        updateHover(e.clientX, e.clientY);
        draw();
      } else if (b) {
        positionHover(e.clientX, e.clientY);
      }
      canvas.classList.toggle("hovering", !!b);
      return;
    }
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (!panned && Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 4) panned = true;
    if (!panned) return;
    cam.x -= dx / cam.k;
    cam.y -= dy / cam.k;
    draw();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pointerId) return;
    pointerId = -1;
    canvas.classList.remove("grabbing");
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const b = hitTest(e.clientX, e.clientY);
    canvas.classList.toggle("hovering", !!b);
    if (!panned) select(b);
  });

  canvas.addEventListener("pointercancel", () => {
    pointerId = -1;
    canvas.classList.remove("grabbing");
    canvas.classList.remove("hovering");
  });

  canvas.addEventListener("pointerleave", () => {
    canvas.classList.remove("hovering");
    if (hovered) {
      hovered = null;
      updateHover(0, 0);
      draw();
    }
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 0.87);
  }, { passive: false });

  goBtn.addEventListener("click", () => {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v < 0) return;
    void loadHistory(v || undefined);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goBtn.click();
  });
  prevBtn.addEventListener("click", () => {
    const base = data.center || data.hi || 1;
    void loadHistory(Math.max(1, base - SPAN));
  });
  nextBtn.addEventListener("click", () => {
    const base = data.center || data.hi || 1;
    void loadHistory(base + SPAN);
  });
  liveButton.addEventListener("click", () => {
    if (live) {
      void loadHistory(data.center || undefined);
    } else {
      setLive(true);
    }
  });
  fitBtn.addEventListener("click", fitView);
  zinBtn.addEventListener("click", () => zoomAt(W / 2, H / 2, 1.25));
  zoutBtn.addEventListener("click", () => zoomAt(W / 2, H / 2, 0.8));
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => { /* ignore */ });
    } else {
      try {
        const p = vpEl.requestFullscreen();
        if (p) void p.catch(() => { /* unsupported */ });
      } catch { /* unsupported */ }
    }
  });
  document.addEventListener("fullscreenchange", () => {
    app.classList.toggle("is-fs", document.fullscreenElement !== null);
    fitViewportHeight();
    resize();
  });
  window.addEventListener("resize", () => {
    fitViewportHeight();
  });

  window.addEventListener("xelis:chain-tip", () => {
    if (!live) return;
    if (tipTimer !== undefined) clearTimeout(tipTimer);
    tipTimer = window.setTimeout(() => { void refreshLive(); }, 500);
  });

  new ResizeObserver(() => resize()).observe(vpEl);

  // ---------- boot ----------

  fitViewportHeight();
  resize();
  const startTopo = Number(app.dataset.topo ?? 0);
  if (app.dataset.live === "1") setLive(true);
  else void loadHistory(startTopo > 0 ? startTopo : undefined);
}
