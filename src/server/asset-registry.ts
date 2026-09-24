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
}

const UPSERT = `INSERT INTO assets (asset_id, name, symbol, decimals, first_seen_topo) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(asset_id) DO UPDATE SET
    name = CASE WHEN excluded.name != '' THEN excluded.name ELSE assets.name END,
    symbol = CASE WHEN excluded.symbol != '' THEN excluded.symbol ELSE assets.symbol END,
    decimals = COALESCE(assets.decimals, excluded.decimals),
    first_seen_topo = COALESCE(assets.first_seen_topo, excluded.first_seen_topo)`;

const BATCH_LIMIT = 50;

/** Reconcile the daemon asset registry into D1. Returns rows written. */
export async function syncAssetRegistry(env: Env): Promise<number> {
  const assets = await rpc<NodeAsset[]>("get_assets", undefined, env.XELIS_NODE);
  if (!Array.isArray(assets) || !assets.length) return 0;

  const existing = await env.DB.prepare(
    "SELECT asset_id, name, symbol, decimals FROM assets"
  ).all<{ asset_id: string; name: string | null; symbol: string | null; decimals: number | null }>();
  const known = new Map((existing.results ?? []).map((r) => [r.asset_id, r]));

  const stmts: D1PreparedStatement[] = [];
  for (const a of assets) {
    if (!a?.asset) continue;
    const id = String(a.asset);
    const name = String(a.name ?? "");
    const symbol = String(a.ticker ?? "");
    const decimals = Number(a.decimals ?? 8);
    const topo = a.topoheight != null ? Number(a.topoheight) : null;
    const prev = known.get(id);
    // skip rows already carrying the registry metadata
    if (prev && prev.name === name && prev.symbol === symbol && prev.decimals === decimals) continue;
    stmts.push(env.DB.prepare(UPSERT).bind(id, name, symbol, decimals, topo));
  }

  let written = 0;
  for (let i = 0; i < stmts.length; i += BATCH_LIMIT) {
    const chunk = stmts.slice(i, i + BATCH_LIMIT);
    await env.DB.batch(chunk);
    written += chunk.length;
  }
  return written;
}