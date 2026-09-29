// Live, unstable chain data served straight from the node. Nothing here is
// persisted: the results are cached in-memory for a few seconds per isolate so
// a burst of clients does not hammer the node RPC.

import type { Env } from "./app";
import { getInfo, rpc, type ChainInfo } from "./xelis";
import { knownEntity } from "./entities";
import type { LiveBlock, LiveData, LiveFees, LiveMempoolTx, LivePeers, LiveRecentTx } from "../client/live-render";

// get_blocks_range_by_topoheight accepts at most a 20-topoheight span.
const WINDOW = 100;        // blocks drawn: unstable tip blocks + stable boundary blocks
const RPC_SPAN = 20;
const MEMPOOL_LIMIT = 25;
const RECENT_TX_LIMIT = 25; // txs pulled from the newest blocks for the live panel
const TX_RPC_CHUNK = 20;    // get_transactions caps a single call at 20 hashes
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

// get_blocks_range_by_topoheight caps a single call at RPC_SPAN topoheights and
// rejects any range that reaches past the node's live tip. Fetch the window in
// chunks keyed by topoheight and, for any topoheight a chunk leaves out, fall
// back to a direct get_block_at_topoheight lookup. A single dropped chunk used
// to silently punch a hole in the window (missing unstable and even stable
// blocks), so a failed chunk is clamped/retried and every gap is repaired
// before the result is returned.
const REPAIR_BUDGET = 200; // direct lookups allowed for one window build

async function rangeBlocks(env: Env, start: number, end: number): Promise<Array<Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  // The tip can roll back on a reorg after get_info() captured it, which makes
  // the node reject the tail of the range; clamp to the fresh tip and retry.
  let limit = end;
  let s = start;
  let guard = 0;
  let repairs = 0;

  const fill = async (from: number, to: number): Promise<void> => {
    for (let t = from; t <= to; t++) {
      if (out.has(t) || repairs >= REPAIR_BUDGET) continue;
      repairs++;
      const b = await rpc<Record<string, unknown>>(
        "get_block_at_topoheight",
        { topoheight: t },
        env.XELIS_NODE,
      ).catch(() => null);
      if (b && typeof b === "object") out.set(t, b);
    }
  };

  while (s <= limit && guard++ < 10_000) {
    const e = Math.min(limit, s + RPC_SPAN - 1);
    let chunk: Array<Record<string, unknown>> | null = null;
    try {
      const res = await rpc<Array<Record<string, unknown>>>(
        "get_blocks_range_by_topoheight",
        { start_topoheight: s, end_topoheight: e },
        env.XELIS_NODE,
      );
      if (Array.isArray(res)) chunk = res;
    } catch {
      const fresh = await getInfo(env.XELIS_NODE).catch(() => null);
      // If the tip rolled back below this chunk's end, shrink the window and
      // retry the same start. If the node is reachable but only the range call
      // failed, repair the span one block at a time. If the node is fully down,
      // skip repairs so one outage cannot trigger a storm of lookups.
      if (fresh && fresh.topoheight < e) {
        limit = fresh.topoheight;
        continue;
      }
      if (fresh) await fill(s, e);
      s = e + 1;
      continue;
    }
    for (const b of chunk ?? []) {
      const t = num(b.topoheight);
      if (t >= s && t <= e) out.set(t, b);
    }
    // Repair any topoheight the range call left out (the node can return a
    // short slice under load) with a direct lookup so the window stays whole.
    await fill(s, e);
    s = e + 1;
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}

function toBlock(b: Record<string, unknown>, stable: number): LiveBlock {
  const topo = num(b.topoheight);
  const hashes = Array.isArray(b.txs_hashes) ? b.txs_hashes : [];
  const miner = String(b.miner ?? "");
  const entity = knownEntity(miner);
  return {
    topoheight: topo,
    height: num(b.height),
    hash: String(b.hash ?? ""),
    ts: num(b.timestamp),
    block_type: String(b.block_type ?? "Normal"),
    miner,
    miner_label: entity?.label,
    miner_kind: entity?.kind,
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

function txTypeOf(t: Record<string, unknown>): string {
  const data = (t.data ?? {}) as Record<string, unknown>;
  if (data.burn) return "burn";
  if (data.invoke_contract) return "invoke_contract";
  if (data.deploy_contract) return "deploy_contract";
  if (t.multisig) return "multisig";
  if (data.transfers) return "transfer";
  return "other";
}

// Detail rows for the newest transactions included in the recent tip blocks,
// newest first. Hashes come straight from the block summaries already fetched;
// the node returns full txs in batches of 20.
async function recentTxs(env: Env, blocks: Array<Record<string, unknown>>): Promise<LiveRecentTx[]> {
  const want: Array<{ hash: string; topoheight: number }> = [];
  for (let i = blocks.length - 1; i >= 0 && want.length < RECENT_TX_LIMIT; i--) {
    const b = blocks[i];
    const topo = num(b.topoheight);
    const hashes = Array.isArray(b.txs_hashes) ? b.txs_hashes : [];
    for (const h of hashes) {
      want.push({ hash: String(h), topoheight: topo });
      if (want.length >= RECENT_TX_LIMIT) break;
    }
  }
  if (!want.length) return [];

  const chunks: Array<Promise<Array<Record<string, unknown>>>> = [];
  for (let i = 0; i < want.length; i += TX_RPC_CHUNK) {
    const hashes = want.slice(i, i + TX_RPC_CHUNK).map((c) => c.hash);
    chunks.push(
      rpc<Array<Record<string, unknown>>>("get_transactions", { tx_hashes: hashes }, env.XELIS_NODE)
        .catch(() => [] as Array<Record<string, unknown>>),
    );
  }
  const results = await Promise.all(chunks);
  const byHash = new Map<string, Record<string, unknown>>();
  for (const list of results) {
    for (const t of Array.isArray(list) ? list : []) {
      if (t?.hash) byHash.set(String(t.hash), t);
    }
  }
  return want.flatMap((c) => {
    const t = byHash.get(c.hash);
    if (!t) return [];
    return [{
      hash: c.hash,
      source: String(t.source ?? ""),
      fee: num(t.fee_paid ?? t.fee),
      size: num(t.size),
      tx_type: txTypeOf(t),
      topoheight: c.topoheight,
    }];
  });
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
      recentTxs: [],
      peers: null,
      fees: null,
    };
  }

  const top = info.topoheight;
  const stable = info.stable_topoheight;
  const lag = Math.max(0, top - stable);
  // Fetch a fixed WINDOW of contiguous topoheights ending at the tip so no
  // topoheight is skipped between the stability boundary and the newest block.
  // Blocks at or below the boundary form the stable run; every block above it is
  // the unstable window. A pruned node cannot serve blocks below its prune
  // point, so clamp there (the window shrinks to whatever remains).
  const from = Math.max(1, num(info.pruned_topoheight), top - WINDOW + 1);

  const [rawBlocks, rawMempool, rawRates, rawKb, rawTips, rawPeers] = await Promise.all([
    from <= top
      ? rangeBlocks(env, from, top)
      : Promise.resolve([] as Array<Record<string, unknown>>),
    rpc<{ total: number; transactions: Array<Record<string, unknown>> }>("get_mempool_summary", { skip: 0, maximum: MEMPOOL_LIMIT }, env.XELIS_NODE).catch(() => null),
    rpc<Record<string, number>>("get_estimated_fee_rates", undefined, env.XELIS_NODE).catch(() => null),
    rpc<Record<string, number>>("get_estimated_fee_per_kb", undefined, env.XELIS_NODE).catch(() => null),
    rpc<string[]>("get_tips", undefined, env.XELIS_NODE).catch(() => [] as string[]),
    rpc<{ peers?: Array<{ pruned_topoheight?: number | null }>; hidden_peers?: number }>("get_peers", undefined, env.XELIS_NODE).catch(() => null),
  ]);

  const allBlocks: LiveBlock[] = (Array.isArray(rawBlocks) ? rawBlocks : []).map((b) => toBlock(b, stable));
  const unstable: LiveBlock[] = allBlocks.filter((b) => !b.stable);
  const boundary: LiveBlock[] = allBlocks.filter((b) => b.stable);

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

  const recentTxList = await recentTxs(env, Array.isArray(rawBlocks) ? rawBlocks : []);

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
    recentTxs: recentTxList,
    peers,
    fees,
  };
}
