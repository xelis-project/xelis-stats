export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; kind?: string };
}

export interface ChainInfo {
  average_block_time: number;
  block_reward: number;
  block_time_target: number;
  block_version: number;
  burned_supply: number;
  circulating_supply: number;
  dev_reward: number;
  difficulty: string;
  emitted_supply: number;
  height: number;
  maximum_supply: number;
  mempool_size: number;
  miner_reward: number;
  network: string;
  pruned_topoheight: number | null;
  stable_topoheight: number;
  stableheight: number;
  top_block_hash: string;
  topoheight: number;
  version: string;
}

let rpcId = 0;

export async function rpc<T = unknown>(method: string, params?: unknown, node = "https://node.xelis.io"): Promise<T> {
  const body: RpcRequest = { jsonrpc: "2.0", id: ++rpcId, method };
  if (params !== undefined) body.params = params;
  const res = await fetch(`${node}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = (await res.json()) as RpcResponse<T>;
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

export async function getInfo(node?: string): Promise<ChainInfo> {
  return rpc<ChainInfo>("get_info", undefined, node);
}

export async function count(method: string, node?: string): Promise<number> {
  return rpc<number>(method, undefined, node);
}
