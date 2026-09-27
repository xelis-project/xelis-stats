import type { Env } from "./app";
import { rpc, getInfo, getSizeOnDisk, type ChainInfo, type ChainSize } from "./xelis";


export interface StatsValue {
  info: ChainInfo;
  chainSize: ChainSize | null;
  txCount: number;
  accounts: number;
  assets: number;
  peers: number;
}

export async function getStatsCached(env: Env): Promise<StatsValue> {
  const cacheKey = "stats:v2";
  const cached = await env.KV.get<StatsValue>(cacheKey, "json");
  if (cached) return cached;
  const [info, txCount, accounts, assets, peerRow, chainSize] = await Promise.all([
    getInfo(env.XELIS_NODE),
    rpc<number>("count_transactions", undefined, env.XELIS_NODE).catch(() => -1),
    rpc<number>("count_accounts", undefined, env.XELIS_NODE).catch(() => -1),
    rpc<number>("count_assets", undefined, env.XELIS_NODE).catch(() => -1),
    env.DB.prepare("SELECT total FROM peer_snapshots ORDER BY ts DESC LIMIT 1").first<{ total: number }>().catch(() => null),
    getSizeOnDisk(env.XELIS_NODE).catch(() => null),
  ]);
  const value = { info, chainSize, txCount, accounts, assets, peers: peerRow?.total ?? 0 };
  await env.KV.put(cacheKey, JSON.stringify(value), { expirationTtl: 60 });
  return value;
}

// Protocol fee constants (atomic XEL). Kept in sync with the Xelis docs:
// https://docs.xelis.io/features/transaction-fees
const FEE_CONSTANTS = {
  per_output: 5_000,        // per transaction output (transfer)
  per_new_address: 100_000, // per address registered by the tx
  per_signature: 5_000,     // per extra multisig signature
  min_fee_per_kb: 10_000,   // protocol floor for the dynamic per-KiB base fee
} as const;

// Transaction fee data from the node, all in atomic XEL per KiB. Xelis has no
// user-set priority fee: the per-KiB rate is a protocol base fee that
// auto-regulates with chain usage. `fee_per_kb` is the current base and
// `predicated_fee_per_kb` the projected next value. Cached briefly since these
// move slowly.
export interface FeeRates {
  ok: boolean;
  fee_per_kb: number | null;
  predicated_fee_per_kb: number | null;
  per_output: number;
  per_new_address: number;
  per_signature: number;
  min_fee_per_kb: number;
  timestamp: number;
}

export async function getFeeRatesCached(env: Env): Promise<FeeRates> {
  const cacheKey = "fee-rates:v2";
  const cached = await env.KV.get<FeeRates>(cacheKey, "json").catch(() => null);
  if (cached) return cached;
  const kb = await rpc<Record<string, unknown>>("get_estimated_fee_per_kb", undefined, env.XELIS_NODE).catch(() => null);
  const n = (v: unknown, d = 0): number => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  const value: FeeRates = {
    ok: kb !== null,
    fee_per_kb: kb ? n(kb.fee_per_kb) : null,
    predicated_fee_per_kb: kb ? n(kb.predicated_fee_per_kb) : null,
    ...FEE_CONSTANTS,
    timestamp: Date.now(),
  };
  // Only cache a real answer; a failed RPC should retry on the next request.
  if (value.ok) await env.KV.put(cacheKey, JSON.stringify(value), { expirationTtl: 60 }).catch(() => { /* cache best effort */ });
  return value;
}
