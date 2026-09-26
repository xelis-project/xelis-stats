// Live, unstable chain data served straight from the node. Nothing here is
// persisted: the results are cached in-memory for a few seconds per isolate so
// a burst of clients does not hammer the node RPC.

import type { Env } from "./app";
import { getInfo, rpc, type ChainInfo } from "./xelis";
import type { LiveBlock, LiveData, LiveFees, LiveMempoolTx, LivePeers } from "../client/live-render";

// get_blocks_range_by_topoheight accepts at most a 20-topoheight span.
const WINDOW = 20;         // newest tip blocks (unstable window)
const STABLE_WINDOW = 24;  // stable blocks shown before the stability boundary
const RPC_SPAN = 20;
const MEMPOOL_LIMIT = 25;
const TTL_MS = 3000;

let cached: { at: number; data: LiveData } | null = null;
let inflight: Promise<LiveData> | null = null;

export function getLive(env: Env): Promise<LiveData> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.data);
  if (inflight) return inflight;
  inflight = load(env)
    .then((data) => {
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// get_blocks_range_by_topoheight caps a single call at RPC_SPAN topoheights, so
// fetch wider windows in chunks and concatenate them in ascending order.
async function rangeBlocks(env: Env, start: number, end: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let s = start; s <= end; s += RPC_SPAN) {
    const e = Math.min(end, s + RPC_SPAN - 1);
    const chunk = await rpc<Array<Record<string, unknown>>>(
      "get_blocks_range_by_topoheight",
      { start_topoheight: s, end_topoheight: e },
      env.XELIS_NODE,
    ).catch(() => [] as Array<Record<string, unknown>>);
    if (Array.isArray(chunk)) out.push(...chunk);
  }
  return out;
}

function toBlock(b: Record<string, unknown>, stable: number): LiveBlock {
  const topo = num(b.topoheight);
  const hashes = Array.isArray(b.txs_hashes) ? b.txs_hashes : [];
  return {
    topoheight: topo,
    height: num(b.height),
    hash: String(b.hash ?? ""),
    ts: num(b.timestamp),
    block_type: String(b.block_type ?? "Normal"),
    miner: String(b.miner ?? ""),
    difficulty: num(b.difficulty),
    txs: hashes.length,
    miner_reward: num(b.miner_reward),
    dev_reward: num(b.dev_reward),
    size: num(b.total_size_in_bytes),
    feesBurned: num(b.total_fees_burned),
    tips: Array.isArray(b.tips) ? b.tips.map(String) : [],
    stable: topo <= stable,
  };
}

async function load(env: Env): Promise<LiveData> {
  const ts = Date.now();
  let info: ChainInfo;
  try {
    info = await getInfo(env.XELIS_NODE);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "node unreachable",
      ts,
      lag: 0,
      hashrate: null,
      unstable: [],
      boundary: [],
      window: { count: 0, miners: 0, side: 0, sync: 0, avgSize: 0, feesBurned: 0 },
      tips: [],
      mempool: { total: 0, transactions: [], valueFee: 0, bytes: 0 },
      peers: null,
      fees: null,
    };
  }

  const top = info.topoheight;
  const stable = info.stable_topoheight;
  const lag = Math.max(0, top - stable);
  // Newest tip window (may still contain stable blocks when the lag is small)
  // plus a run of stable blocks ending at the boundary, so the DAG shows more
  // than the single boundary block. Overlap between the two ranges is removed
  // when the client merges them by topoheight.
  const tipFrom = Math.max(1, top - (WINDOW - 1));
  const stableFrom = Math.max(1, stable - STABLE_WINDOW + 1);

  const [rawBlocks, rawBoundary, rawMempool, rawRates, rawKb, rawTips, rawPeers] = await Promise.all([
    tipFrom <= top
      ? rangeBlocks(env, tipFrom, top)
      : Promise.resolve([] as Array<Record<string, unknown>>),
    stable >= 1 && stableFrom <= stable
      ? rangeBlocks(env, stableFrom, stable)
      : Promise.resolve([] as Array<Record<string, unknown>>),
    rpc<{ total: number; transactions: Array<Record<string, unknown>> }>("get_mempool_summary", { skip: 0, maximum: MEMPOOL_LIMIT }, env.XELIS_NODE).catch(() => null),
    rpc<Record<string, number>>("get_estimated_fee_rates", undefined, env.XELIS_NODE).catch(() => null),
    rpc<Record<string, number>>("get_estimated_fee_per_kb", undefined, env.XELIS_NODE).catch(() => null),
    rpc<string[]>("get_tips", undefined, env.XELIS_NODE).catch(() => [] as string[]),
    rpc<{ peers?: Array<{ pruned_topoheight?: number | null }>; hidden_peers?: number }>("get_peers", undefined, env.XELIS_NODE).catch(() => null),
  ]);

  const unstable: LiveBlock[] = (Array.isArray(rawBlocks) ? rawBlocks : []).map((b) => toBlock(b, stable));
  const boundary: LiveBlock[] = (Array.isArray(rawBoundary) ? rawBoundary : []).map((b) => toBlock(b, stable));

  // Stats cover every distinct block that will be drawn, stable boundary blocks
  // included, so the side/sync counters match the DAG.
  const seen = new Set<number>();
  const windowBlocks: LiveBlock[] = [];
  for (const b of [...unstable, ...boundary]) {
    if (seen.has(b.topoheight)) continue;
    seen.add(b.topoheight);
    windowBlocks.push(b);
  }

  const windowStats = {
    count: windowBlocks.length,
    miners: new Set(windowBlocks.map((b) => b.miner).filter(Boolean)).size,
    side: windowBlocks.filter((b) => b.block_type.toLowerCase() === "side").length,
    sync: windowBlocks.filter((b) => b.block_type.toLowerCase() === "sync").length,
    avgSize: windowBlocks.length ? windowBlocks.reduce((s, b) => s + b.size, 0) / windowBlocks.length : 0,
    feesBurned: windowBlocks.reduce((s, b) => s + b.feesBurned, 0),
  };

  const mempoolTxs: LiveMempoolTx[] = (rawMempool?.transactions ?? []).map((t) => ({
    hash: String(t.hash ?? ""),
    source: String(t.source ?? ""),
    fee: num(t.fee),
    first_seen: num(t.first_seen),
    size: num(t.size),
    fee_per_kb: num(t.fee_per_kb),
  }));

  const peerList = rawPeers?.peers ?? [];
  const peers: LivePeers | null = rawPeers
    ? {
        total: peerList.length,
        hidden: num(rawPeers.hidden_peers),
        pruned: peerList.filter((p) => p?.pruned_topoheight != null).length,
      }
    : null;

  const fees: LiveFees | null = rawRates
    ? {
        low: num(rawRates.low),
        medium: num(rawRates.medium),
        high: num(rawRates.high),
        base_fee_per_kb: rawKb ? num(rawKb.fee_per_kb) : null,
        predicated_fee_per_kb: rawKb ? num(rawKb.predicated_fee_per_kb) : null,
      }
    : null;

  const difficulty = num(info.difficulty);
  const blockTime = info.average_block_time > 0 ? info.average_block_time / 1000 : null;
  const hashrate = blockTime && difficulty ? difficulty / blockTime : null;

  return {
    ok: true,
    ts,
    info: {
      network: String(info.network ?? ""),
      version: String(info.version ?? ""),
      height: num(info.height),
      topoheight: num(info.topoheight),
      stable_topoheight: num(info.stable_topoheight),
      stableheight: num(info.stableheight),
      difficulty,
      average_block_time: num(info.average_block_time),
      block_time_target: num(info.block_time_target),
      miner_reward: num(info.miner_reward),
      dev_reward: num(info.dev_reward),
      block_reward: num(info.miner_reward) + num(info.dev_reward),
      mempool_size: num(info.mempool_size),
      circulating_supply: num(info.circulating_supply),
      emitted_supply: num(info.emitted_supply),
      burned_supply: num(info.burned_supply),
      maximum_supply: num(info.maximum_supply),
      top_block_hash: String(info.top_block_hash ?? ""),
      pruned_topoheight: info.pruned_topoheight ?? null,
    },
    lag,
    hashrate,
    unstable,
    boundary,
    window: windowStats,
    tips: Array.isArray(rawTips) ? rawTips.map(String) : [],
    mempool: {
      total: num(rawMempool?.total),
      transactions: mempoolTxs,
      valueFee: mempoolTxs.reduce((s, t) => s + t.fee, 0),
      bytes: mempoolTxs.reduce((s, t) => s + t.size, 0),
    },
    peers,
    fees,
  };
}
