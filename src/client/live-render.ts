// Shared types + HTML renderers for the live (unstable) dashboard. The server
// page renders the first paint with these helpers and the client poller reuses
// them, so the node-sourced values never touch D1.

import { fmt, fmtInt, fmtBytes, atomic, atomicPrecise, shortHash, timeCell } from "./format";

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

export interface LiveBlock {
  topoheight: number;
  height: number;
  hash: string;
  ts: number;
  block_type: string;
  miner: string;
  difficulty: number;
  txs: number;
  miner_reward: number;
  dev_reward: number;
  size: number;
  feesBurned: number;
  tips: string[];
  stable: boolean;
}

export interface LiveMempoolTx {
  hash: string;
  source: string;
  fee: number;
  first_seen: number;
  size: number;
  fee_per_kb: number;
}

export interface LiveFees {
  low: number;
  medium: number;
  high: number;
  base_fee_per_kb: number | null;
  predicated_fee_per_kb: number | null;
}

export interface LiveInfo {
  network: string;
  version: string;
  height: number;
  topoheight: number;
  stable_topoheight: number;
  stableheight: number;
  difficulty: number;
  average_block_time: number;
  block_time_target: number;
  miner_reward: number;
  dev_reward: number;
  block_reward: number;
  mempool_size: number;
  circulating_supply: number;
  emitted_supply: number;
  burned_supply: number;
  maximum_supply: number;
  top_block_hash: string;
  pruned_topoheight: number | null;
}

export interface LiveWindow {
  count: number;
  miners: number;
  side: number;
  sync: number;
  avgSize: number;
  feesBurned: number;
}

export interface LivePeers {
  total: number;
  hidden: number;
  pruned: number;
}

export interface LiveData {
  ok: boolean;
  error?: string;
  ts: number;
  info?: LiveInfo;
  lag: number;
  hashrate: number | null;
  unstable: LiveBlock[];
  boundary: LiveBlock[];
  window: LiveWindow;
  tips: string[];
  mempool: { total: number; transactions: LiveMempoolTx[]; valueFee: number; bytes: number };
  peers: LivePeers | null;
  fees: LiveFees | null;
}

function card(label: string, value: string, sub: string): string {
  return `<div class="card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`;
}

function mini(label: string, value: string, sub: string): string {
  return `<div class="live-mini"><span class="label">${label}</span><span class="value">${value}</span><span class="sub">${sub}</span></div>`;
}

export function liveStatsHtml(d: LiveData): string {
  const i = d.info;
  if (!i) {
    return card("Node", `<span class="live-muted">unreachable</span>`, esc(d.error ?? "no data from the node"));
  }
  const blockTime = i.average_block_time > 0 ? i.average_block_time / 1000 : null;
  const target = i.block_time_target > 0 ? i.block_time_target / 1000 : null;
  const circ = i.circulating_supply / 1e8;
  const max = i.maximum_supply / 1e8;
  const pctMax = max > 0 ? `${((circ / max) * 100).toFixed(2)}% of max supply` : "max supply unknown";
  const unstableShown = dagBlocks(d).filter((b) => !b.stable).length;
  const w = d.window;
  const peers = d.peers;
  return [
    card("Topoheight", fmtInt(i.topoheight), `height ${fmtInt(i.height)} · ${unstableShown} unstable shown`),
    card("Stable boundary", fmtInt(i.stable_topoheight), `lag ${fmtInt(d.lag)} topoheights`),
    card("Difficulty", fmt(i.difficulty), d.hashrate ? `~${fmt(d.hashrate)} H/s estimated` : "hashrate unavailable"),
    card("Block time", blockTime ? `${blockTime.toFixed(1)}s` : "—", target ? `target ${target.toFixed(1)}s` : "target unknown"),
    card("Block reward", `${atomic(i.block_reward)} XEL`, `miner ${atomic(i.miner_reward)} + dev ${atomic(i.dev_reward)}`),
    card("Circulating", `${fmt(circ)} XEL`, pctMax),
    card("Active miners", w.count ? fmtInt(w.miners) : "—", `distinct in last ${fmtInt(w.count)} blocks`),
    card("Side / Sync", w.count ? `${fmtInt(w.side + w.sync)}` : "—", `${fmtInt(w.side)} side · ${fmtInt(w.sync)} sync in window`),
    card("Avg block size", w.count ? fmtBytes(w.avgSize) : "—", `mean across ${fmtInt(w.count)} blocks`),
    card("Fees burned", w.count ? `${atomic(w.feesBurned)} XEL` : "—", "across the recent window"),
    card("Peers", peers ? fmtInt(peers.total) : "—", peers ? `${fmtInt(peers.pruned)} pruned · ${fmtInt(peers.hidden)} hidden` : "peer lookup unavailable"),
    card("DAG tips", fmtInt(d.tips.length), `top ${esc(shortHash(i.top_block_hash, 8))}`),
    card("Node", esc(i.version), esc(i.network) + (i.pruned_topoheight != null ? ` · pruned from ${fmtInt(i.pruned_topoheight)}` : " · full node")),
  ].join("");
}

function dagNode(b: LiveBlock): string {
  const cls = `live-node ${esc(b.block_type.toLowerCase())}${b.stable ? "" : " unstable"}`;
  const detail = `topo ${b.topoheight} · height ${b.height} · ${b.block_type} · ${b.txs} tx · ${shortHash(b.hash, 8)}`;
  return `<a class="${cls}" href="/block/${b.topoheight}" title="${esc(detail)}" aria-label="${esc(detail)}"></a>`;
}

function dagBlocks(d: LiveData): LiveBlock[] {
  const seen = new Set<number>();
  const out: LiveBlock[] = [];
  for (const b of [...(d.boundary ?? []), ...(d.unstable ?? [])]) {
    if (seen.has(b.topoheight)) continue;
    seen.add(b.topoheight);
    out.push(b);
  }
  return out;
}

export function liveDagHtml(d: LiveData): string {
  const blocks = dagBlocks(d);
  if (!blocks.length) {
    return `<p class="live-empty">${d.ok ? "No blocks in the current window." : "Node data unavailable."}</p>`;
  }
  const stable = blocks.filter((b) => b.stable);
  const unstable = blocks.filter((b) => !b.stable);
  const stableTopos = stable.map((b) => b.topoheight);
  const unstableTopos = unstable.map((b) => b.topoheight);
  const stableRange = stableTopos.length ? (stableTopos.length > 1 ? `${fmtInt(Math.min(...stableTopos))}–${fmtInt(Math.max(...stableTopos))}` : fmtInt(stableTopos[0])) : "";
  const unstableRange = unstableTopos.length ? (unstableTopos.length > 1 ? `${fmtInt(Math.min(...unstableTopos))}–${fmtInt(Math.max(...unstableTopos))}` : fmtInt(unstableTopos[0])) : "";
  const boundary = stableTopos.length && unstableTopos.length
    ? { from: Math.max(...stableTopos), to: Math.min(...unstableTopos) }
    : null;

  const segs: string[] = [];
  if (stable.length) {
    segs.push(`<div class="live-dag-seg">
      <div class="live-dag-seg-head"><span class="live-dag-cap">stable</span><span class="live-dag-range">topo ${stableRange}</span></div>
      <div class="live-dag-nodes">${stable.map(dagNode).join("")}</div>
    </div>`);
  }
  if (boundary) {
    segs.push(`<div class="live-dag-sep" title="${esc(`stability boundary · topo ${boundary.from} → ${boundary.to}`)}" aria-hidden="true"></div>`);
  }
  if (unstable.length) {
    segs.push(`<div class="live-dag-seg">
      <div class="live-dag-seg-head"><span class="live-dag-cap unstable">unstable · may reorg</span><span class="live-dag-range">topo ${unstableRange}</span></div>
      <div class="live-dag-nodes">${unstable.map(dagNode).join("")}</div>
    </div>`);
  }

  const hidden = Math.max(0, d.lag - unstable.length);
  const parts: string[] = [];
  if (boundary) parts.push(`stability boundary at topo ${fmtInt(boundary.from)} → ${fmtInt(boundary.to)}`);
  if (hidden > 0) parts.push(`${fmtInt(hidden)} ${hidden === 1 ? "topoheight is" : "topoheights are"} hidden between the boundary and the tip window`);
  if (!unstable.length && stable.length) parts.push("no unstable blocks right now");
  const note = parts.length ? `<p class="live-dag-note">${parts.join(" · ")}</p>` : "";
  const legend = `<div class="live-dag-legend">
    <span class="live-key"><span class="live-key-dot normal"></span>Normal</span>
    <span class="live-key"><span class="live-key-dot side"></span>Side</span>
    <span class="live-key"><span class="live-key-dot sync"></span>Sync</span>
    <span class="live-key"><span class="live-key-dot unstable"></span>Unstable (may reorg)</span>
  </div>`;
  return `<div class="live-dag"><div class="live-dag-track">${segs.join("")}</div></div>${note}${legend}`;
}

export function liveBlocksRowsHtml(d: LiveData): string {
  const blocks = (d.unstable ?? []).slice().reverse();
  if (!blocks.length) {
    return `<tr><td colspan="8" style="color:var(--text-dim)">${d.ok ? "No blocks above the stability boundary right now." : "Node data unavailable — retrying."}</td></tr>`;
  }
  return blocks.map((b) => {
    const type = esc(b.block_type.toLowerCase());
    const status = b.stable ? '<span class="badge ok">stable</span>' : '<span class="badge unstable">unstable</span>';
    return `<tr>
      <td><a href="/block/${b.topoheight}"><span class="mint">${fmtInt(b.topoheight)}</span></a></td>
      <td class="num">${fmtInt(b.height)}</td>
      <td>${timeCell(b.ts)}</td>
      <td class="num">${fmtInt(b.txs)}</td>
      <td><span class="badge ${type}">${type}</span></td>
      <td>${status}</td>
      <td class="num">${atomic(b.miner_reward + b.dev_reward)}</td>
      <td><a href="/miner/${esc(b.miner)}">${esc(shortHash(b.miner, 6))}</a></td>
    </tr>`;
  }).join("");
}

function feeChip(label: string, value: number, accent = false): string {
  const cls = `live-fee${accent ? " accent" : ""}`;
  return `<div class="${cls}"><span class="live-fee-label">${esc(label)}</span><span class="live-fee-value">${atomicPrecise(value)} XEL/KB</span></div>`;
}

export function liveMempoolSummaryHtml(d: LiveData): string {
  if (!d.ok) return `<p class="live-empty">Node data unavailable.</p>`;
  const { total, transactions, valueFee, bytes } = d.mempool;
  const cards = `<div class="live-mini-cards">
    ${mini("Pending", fmtInt(total), total === 1 ? "transaction" : "transactions")}
    ${mini("Value", `${atomic(valueFee)} XEL`, "sum of fees")}
    ${mini("Size", fmtBytes(bytes), "payload bytes")}
  </div>`;
  const fees = d.fees;
  const rates = fees
    ? `<div class="live-feerates">
        ${feeChip("Low", fees.low)}
        ${feeChip("Medium", fees.medium)}
        ${feeChip("High", fees.high)}
        ${fees.base_fee_per_kb != null ? `<div class="live-fee"><span class="live-fee-label">Base</span><span class="live-fee-value">${atomicPrecise(fees.base_fee_per_kb)} XEL/KB</span></div>` : ""}
      </div>`
    : "";
  const note = total > 0
    ? `<div class="live-mempool-head">Showing newest ${fmtInt(transactions.length)}${total > transactions.length ? ` of ${fmtInt(total)}` : ""}</div>`
    : "";
  return `${cards}${rates}${note}`;
}

export function liveMempoolRowsHtml(d: LiveData): string {
  const txs = d.mempool.transactions;
  if (!txs.length) {
    return `<tr><td colspan="6" style="color:var(--text-dim)">${d.ok ? "Nothing waiting in the mempool." : "Node data unavailable — retrying."}</td></tr>`;
  }
  return txs.map((t) => `<tr>
    <td title="${esc(t.hash)}"><a href="/tx/${esc(t.hash)}">${esc(shortHash(t.hash))}</a></td>
    <td title="${esc(t.source)}"><a href="/account/${esc(t.source)}">${esc(shortHash(t.source, 6))}</a></td>
    <td class="num">${atomicPrecise(t.fee)}</td>
    <td class="num">${fmtInt(t.size)}</td>
    <td class="num">${atomicPrecise(t.fee_per_kb)}</td>
    <td>${timeCell(t.first_seen)}</td>
  </tr>`).join("");
}

export function liveMetaHtml(d: LiveData): string {
  if (!d.ok || !d.info) {
    return `<span class="live-dot off"></span> node unreachable${d.error ? ` · ${esc(d.error)}` : ""}`;
  }
  const unstable = d.unstable.filter((b) => !b.stable).length;
  return `<span class="live-dot on"></span> updated ${timeCell(d.ts)} · stability lag ${fmtInt(d.lag)} · ${fmtInt(unstable)} unstable block${unstable === 1 ? "" : "s"} in window`;
}
