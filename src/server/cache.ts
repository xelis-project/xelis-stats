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
