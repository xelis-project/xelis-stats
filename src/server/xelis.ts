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

const DEFAULT_NODE = "https://node.xelis.io";
const RPC_ATTEMPTS = 3;
const RPC_TIMEOUT_MS = 10_000;
const RPC_RETRY_BASE_MS = 200;

let rpcId = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The node sits behind Cloudflare; when its origin briefly drops, the edge
// answers with 5xx (521 "Web Server Is Down", 522/524) instead of a JSON-RPC
// error. Those are transient, so retry before surfacing an error. 408/429 are
// also worth another try; other 4xx are real client errors.
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export async function rpc<T = unknown>(method: string, params?: unknown, node = DEFAULT_NODE): Promise<T> {
  const body: RpcRequest = { jsonrpc: "2.0", id: ++rpcId, method };
  if (params !== undefined) body.params = params;
  const url = `${node}/json_rpc`;

  let lastError: Error = new Error(`RPC ${method}: request failed`);
  for (let attempt = 1; attempt <= RPC_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
    } catch (err) {
      // Network failure, TLS error or timeout.
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < RPC_ATTEMPTS) {
        await sleep(RPC_RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      lastError = new Error(`RPC HTTP ${res.status}`);
      if (attempt < RPC_ATTEMPTS && isRetryableStatus(res.status)) {
        await sleep(RPC_RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }

    let json: RpcResponse<T>;
    try {
      json = (await res.json()) as RpcResponse<T>;
    } catch {
      // A 2xx with a non-JSON body is not a valid RPC reply (edge/proxy page).
      lastError = new Error(`RPC ${method}: invalid JSON response`);
      if (attempt < RPC_ATTEMPTS) {
        await sleep(RPC_RETRY_BASE_MS * attempt);
        continue;
      }
      throw lastError;
    }

    if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
    return json.result as T;
  }
  throw lastError;
}

export interface ChainSize {
  size_bytes: number;
  size_formatted: string;
}

export async function getInfo(node?: string): Promise<ChainInfo> {
  return rpc<ChainInfo>("get_info", undefined, node);
}

// On-disk chain (database) size. Not all nodes expose it; callers should
// tolerate rejection and treat the value as optional.
export async function getSizeOnDisk(node?: string): Promise<ChainSize> {
  return rpc<ChainSize>("get_size_on_disk", undefined, node);
}

export async function count(method: string, node?: string): Promise<number> {
  return rpc<number>(method, undefined, node);
}
