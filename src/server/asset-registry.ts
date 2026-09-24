import type { Env } from "./app";
import { rpc } from "./xelis";

/**
 * Full asset-registry sync.
 *
 * The tx-detail pass only registers assets it happens to see in a transfer or
 * burn, so the local `assets` table lags the chain registry (an asset that was
 * never transferred in the indexed window stays invisible). `get_assets`
 * returns the daemon's complete registry with metadata, so we reconcile it
 * into D1 to keep `/assets` and the dashboard counts consistent.
 */

interface NodeAsset {
  asset?: string;
  name?: string | null;
  ticker?: string | null;
  decimals?: number | null;
  topoheight?: number | null;
  max_supply?: unknown;
  owner?: unknown;
}

export interface AssetMaxSupply {
  kind: "none" | "fixed" | "mintable";
  value: number | null;
}

export interface AssetOwner {
  contract: string | null;
  assetId: number | null;
}

/**
 * Normalize the node's `max_supply` shape: "none", { fixed: n } or
 * { mintable: n } (n is the cap in atomic units).
 */
export function parseMaxSupply(v: unknown): AssetMaxSupply {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.fixed != null) return { kind: "fixed", value: Number(o.fixed) };
    if (o.mintable != null) return { kind: "mintable", value: Number(o.mintable) };
  }
  return { kind: "none", value: null };
}

/** Normalize the node's `owner` shape: "none" or { creator: { contract, id } }. */
export function parseOwner(v: unknown): AssetOwner {
  if (v && typeof v === "object") {
    const creator = (v as Record<string, unknown>).creator;
    if (creator && typeof creator === "object") {
      const c = creator as Record<string, unknown>;
      const contract = typeof c.contract === "string" ? c.contract : null;
      if (contract) return { contract, assetId: c.id != null ? Number(c.id) : null };
    }
  }
  return { contract: null, assetId: null };
}

const UPSERT = `INSERT INTO assets (asset_id, name, symbol, decimals, first_seen_topo, max_supply_kind, max_supply, owner_contract, owner_asset_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(asset_id) DO UPDATE SET
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE assets.name END,
    symbol = CASE WHEN excluded.symbol != '' THEN excluded.symbol ELSE assets.symbol END,
    decimals = COALESCE(assets.decimals, excluded.decimals),
    first_seen_topo = COALESCE(assets.first_seen_topo, excluded.first_seen_topo),
    max_supply_kind = excluded.max_supply_kind,
    max_supply = excluded.max_supply,
    owner_contract = excluded.owner_contract,
    owner_asset_id = excluded.owner_asset_id`;

const BATCH_LIMIT = 50;

interface ExistingAsset {
  asset_id: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  max_supply_kind: string | null;
  max_supply: number | null;
  owner_contract: string | null;
  owner_asset_id: number | null;
}

/** Reconcile the daemon asset registry into D1. Returns rows written. */
export async function syncAssetRegistry(env: Env): Promise<number> {
  const assets = await rpc<NodeAsset[]>("get_assets", undefined, env.XELIS_NODE);
  if (!Array.isArray(assets) || !assets.length) return 0;

  const existing = await env.DB.prepare(
    "SELECT asset_id, name, symbol, decimals, max_supply_kind, max_supply, owner_contract, owner_asset_id FROM assets"
  ).all<ExistingAsset>();
  const known = new Map((existing.results ?? []).map((r) => [r.asset_id, r]));

  const stmts: D1PreparedStatement[] = [];
  for (const a of assets) {
    if (!a?.asset) continue;
    const id = String(a.asset);
    const name = String(a.name ?? "");
    const symbol = String(a.ticker ?? "");
    const decimals = Number(a.decimals ?? 8);
    const topo = a.topoheight != null ? Number(a.topoheight) : null;
    const max = parseMaxSupply(a.max_supply);
    const owner = parseOwner(a.owner);
    const prev = known.get(id);
    // skip rows already carrying the registry metadata
    if (prev
      && prev.name === name && prev.symbol === symbol && prev.decimals === decimals
      && prev.max_supply_kind === max.kind && prev.max_supply === max.value
      && prev.owner_contract === owner.contract && prev.owner_asset_id === owner.assetId) continue;
    stmts.push(env.DB.prepare(UPSERT).bind(id, name, symbol, decimals, topo, max.kind, max.value, owner.contract, owner.assetId));
  }

  let written = 0;
  for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
    const chunk = stmts.slice(i, i + BATCH_LIMIT);
    await env.DB.batch(chunk);
    written += chunk.length;
  }
  return written;
}
