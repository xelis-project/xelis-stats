/**
 * D1 shard router: works around the 10GB per-database hardcap.
 *
 * Layout:
 *  - Hot DB (env.DB binding): aggregates, accounts, assets, market/peer data,
 *    plus the recent raw chain window (blocks/tx_index/tx_assets/tx_contracts
 *    with topoheight > hotFloor).
 *  - Shard DBs (created via the Cloudflare REST API, no wrangler bindings):
 *    sealed topoheight ranges of the same raw tables, e.g. [0 .. 500_000].
 *  - shards table (hot DB): the routing registry mapping topoheight ranges to
 *    shard databases. Hash lookups fall back to a fan-out over sealed shards.
 *
 * Rotation (rotateShards, called hourly from cron): when the hot DB crosses
 * SHARD_MAX_BYTES, create a shard DB and copy old raw rows topo batch by topo
 * batch within a time budget per run, then seal the shard. Deleting the hot
 * copies is deferred until after the seal (pruneShards) so a shard that is
 * still copying never makes its rows unreadable. Serving stays correct through
 * both phases: reads only target sealed shards, and hot reads are bounded to
 * topo > hotFloor, so rows duplicated between seal and prune are never served
 * twice. Rotation is size-triggered, not calendar-triggered: at current chain
 * volume shards are rare and each may span a year or more.
 *
 * Required setup:
 *   wrangler secret put CLOUDFLARE_ACCOUNT_ID
 *   wrangler secret put CLOUDFLARE_API_TOKEN
 *   vars: XELIS_EXPLORER_DB_ID (hot DB uuid, for size checks), SHARD_MAX_BYTES
 * Without the secrets the whole module is a no-op and the app behaves as before.
 */
import type { Env } from "./app";

const CF_API = "https://api.cloudflare.com/client/v4";
const CACHE_MS = 60_000;

// Raw chain tables replicated into every shard (subset of 0001_init.sql).
// Exported so scripts/bootstrap_shards.mts applies the exact same schema.
export const SHARD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS blocks (
    topoheight INTEGER PRIMARY KEY,
    height INTEGER, hash TEXT, ts INTEGER, version INTEGER, nonce INTEGER,
    difficulty INTEGER, size INTEGER, tx_count INTEGER, block_type TEXT,
    miner_address TEXT,
    miner_reward INTEGER, dev_reward INTEGER, burned INTEGER,
    fee_total INTEGER, cum_difficulty TEXT, tips TEXT, txs_hashes TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_ts ON blocks(ts)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_address)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_miner_ts ON blocks(miner_address, ts)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_ts_rewards ON blocks(ts, miner_reward, dev_reward)",
  "CREATE INDEX IF NOT EXISTS idx_tx_contract_id ON tx_index(contract_id, block_topo) WHERE contract_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS idx_tx_burn_asset ON tx_index(burn_asset) WHERE burn_asset IS NOT NULL",
  // sort indexes mirrored from migrations/0001_init.sql
  "CREATE INDEX IF NOT EXISTS idx_blocks_ts_topo ON blocks(ts, topoheight)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_tx_count_topo ON blocks(tx_count, topoheight)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_size_topo ON blocks(size, topoheight)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_difficulty_topo ON blocks(difficulty, topoheight)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_reward_topo ON blocks(miner_reward, topoheight)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_type_topo ON blocks(block_type, topoheight)",
  `CREATE TABLE IF NOT EXISTS tx_index (
    hash TEXT PRIMARY KEY, block_topo INTEGER, ts INTEGER,
    fee INTEGER, size INTEGER, tx_type TEXT, sender TEXT,
    transfer_count INTEGER, version INTEGER, multisig INTEGER, contract_id TEXT,
    gas INTEGER, executed INTEGER, encrypted INTEGER DEFAULT 0,
    burn_amount INTEGER DEFAULT 0, burn_asset TEXT)`,
  "CREATE INDEX IF NOT EXISTS idx_tx_block ON tx_index(block_topo)",
  "CREATE INDEX IF NOT EXISTS idx_tx_sender ON tx_index(sender)",
  "CREATE INDEX IF NOT EXISTS idx_tx_type_ts ON tx_index(tx_type, ts)",
  // sort/keyset indexes mirrored from migrations/0001_init.sql
  "CREATE INDEX IF NOT EXISTS idx_tx_block_hash ON tx_index(block_topo, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_ts_hash ON tx_index(ts, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_fee_hash ON tx_index(fee, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_type_hash ON tx_index(tx_type, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_sender_hash ON tx_index(sender, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_executed_hash ON tx_index(executed, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_transfer_count_hash ON tx_index(transfer_count, hash)",
  "CREATE INDEX IF NOT EXISTS idx_tx_size_hash ON tx_index(size, hash)",
  "CREATE TABLE IF NOT EXISTS tx_assets (tx_hash TEXT, asset TEXT, PRIMARY KEY (tx_hash, asset))",
  "CREATE INDEX IF NOT EXISTS idx_tx_assets_asset ON tx_assets(asset)",
  "CREATE TABLE IF NOT EXISTS tx_contracts (tx_hash TEXT PRIMARY KEY, contract_id TEXT, max_gas INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_tx_contracts_cid ON tx_contracts(contract_id)",
];

// The index DDL from SHARD_SCHEMA. SHARD_SCHEMA is only applied when a shard is
// created, so indexes added later (e.g. idx_blocks_size_topo) are missing from
// shards sealed before the change. ensureShardIndexes replays these on existing
// shards. Regex-captured names must match the DDL identifiers.
const SHARD_INDEXES = SHARD_SCHEMA.filter((s) => s.startsWith("CREATE INDEX"));

// column order used when copying rows into shard databases
const SHARD_TABLES: Record<string, string[]> = {
  blocks: ["topoheight", "height", "hash", "ts", "version", "nonce", "difficulty", "size", "tx_count", "block_type", "miner_address", "miner_reward", "dev_reward", "burned", "fee_total", "cum_difficulty", "tips", "txs_hashes"],
  tx_index: ["hash", "block_topo", "ts", "fee", "size", "tx_type", "sender", "transfer_count", "version", "multisig", "contract_id", "gas", "executed", "encrypted", "burn_amount", "burn_asset"],
  tx_assets: ["tx_hash", "asset"],
  tx_contracts: ["tx_hash", "contract_id", "max_gas"],
};

export type Row = Record<string, unknown>;

export interface ShardRow {
  id: number;
  name: string | null;
  db_id: string;
  first_topo: number;
  last_topo: number | null;
  copied_topo: number;
  first_ts: number | null;
  last_ts: number | null;
  sealed: number;
}

export interface RawTarget {
  kind: "hot" | "shard";
  dbId?: string;
}

export function shardsConfigured(env: Env): boolean {
  return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
}

function maxBytes(env: Env): number {
  return Number(env.SHARD_MAX_BYTES ?? 0) || 8 * 1024 * 1024 * 1024;
}

// ---------- Cloudflare REST ----------

async function cfFetch(env: Env, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json() as { success?: boolean; errors?: { message: string }[]; result?: unknown };
  if (!res.ok || json.success === false) {
    throw new Error(`CF API ${path}: ${res.status} ${json.errors?.[0]?.message ?? ""}`);
  }
  return json.result as Record<string, unknown>;
}

/** Run one SQL statement against an arbitrary D1 database (by uuid). */
export async function restQuery(env: Env, dbId: string, sql: string, params: unknown[] = []): Promise<Row[]> {
  const res = await cfFetch(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${dbId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql, params }),
  }) as unknown as Array<{ results?: Row[] }>;
  return (Array.isArray(res) ? res[0]?.results : []) ?? [];
}

/** Create a new D1 database and return its uuid. */
async function createShardDatabase(env: Env, name: string): Promise<string> {
  const res = await cfFetch(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return String(res.uuid ?? "");
}

async function initShardSchema(env: Env, dbId: string): Promise<void> {
  for (const stmt of SHARD_SCHEMA) await restQuery(env, dbId, stmt);
}

/**
 * Reconcile indexes on already-sealed shards. initShardSchema only runs at shard
 * creation, so an index added to SHARD_SCHEMA afterwards (like the blocks size
 * sort index) is absent on existing shards — every size/difficulty/reward sort
 * then does a full scan plus a temp B-tree sort per shard instead of an ordered
 * index scan. Idempotent: reads each shard's index list and creates only the
 * missing ones. Best-effort; a failed shard is retried on the next run.
 */
async function ensureShardIndexes(env: Env, shards: ShardRow[]): Promise<void> {
  const expected = SHARD_INDEXES.flatMap((sql) => {
    const name = /INDEX\s+(?:IF NOT EXISTS\s+)?([A-Za-z0-9_]+)/i.exec(sql)?.[1];
    return name ? [{ sql, name }] : [];
  });
  for (const s of shards) {
    if (!s.sealed) continue;
    try {
      const rows = await restQuery(env, s.db_id, "SELECT name FROM sqlite_master WHERE type = 'index'");
      const have = new Set(rows.map((r) => String(r.name)));
      for (const { sql, name } of expected) {
        if (!have.has(name)) await restQuery(env, s.db_id, sql);
      }
    } catch { /* shard unreachable: retry on the next hourly run */ }
  }
}

/** File size of any D1 database via the REST API (null if unknown). */
async function dbFileBytes(env: Env, dbId: string): Promise<number | null> {
  try {
    const res = await cfFetch(env, `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${dbId}`);
    const size = res.file_size ?? (res as { size?: number }).size;
    return size != null ? Number(size) : null;
  } catch {
    return null;
  }
}

/** Hot DB file size; uses the binding pragma, falls back to REST metadata. */
async function hotFileBytes(env: Env): Promise<number | null> {
  // Prefer used pages: pruned rows go to the freelist and are reused, but the
  // file never shrinks, so raw page_count would stay above SHARD_MAX_BYTES
  // after a rotation and cut a new tiny shard every hourly run.
  try {
    const row = await env.DB.prepare(
      "SELECT ((SELECT page_count FROM pragma_page_count) - (SELECT freelist_count FROM pragma_freelist_count)) * (SELECT page_size FROM pragma_page_size) AS bytes"
    ).first<{ bytes: number }>();
    if (row?.bytes) return Number(row.bytes);
  } catch { /* freelist pragma unavailable: fall back to page_count */ }
  try {
    const row = await env.DB.prepare(
      "SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS bytes"
    ).first<{ bytes: number }>();
    if (row?.bytes) return Number(row.bytes);
  } catch { /* fall through to REST */ }
  return env.XELIS_EXPLORER_DB_ID ? dbFileBytes(env, env.XELIS_EXPLORER_DB_ID) : null;
}

// ---------- registry ----------

let regCache: { at: number; shards: ShardRow[] } | null = null;

export async function getShards(env: Env, force = false): Promise<ShardRow[]> {
  if (!force && regCache && Date.now() - regCache.at < CACHE_MS) return regCache.shards;
  try {
    const rows = await env.DB.prepare(
      "SELECT id, name, db_id, first_topo, last_topo, copied_topo, first_ts, last_ts, sealed FROM shards ORDER BY first_topo"
    ).all<ShardRow>();
    regCache = { at: Date.now(), shards: rows.results ?? [] };
  } catch {
    regCache = { at: Date.now(), shards: regCache?.shards ?? [] };
  }
  return regCache.shards;
}

function invalidate(): void {
  regCache = null;
}

/** Topos <= hotFloor may live in shards; topos above it are in the hot DB. */
export function hotFloor(shards: ShardRow[]): number {
  let floor = -1;
  for (const s of shards) if (s.sealed && s.last_topo != null) floor = Math.max(floor, s.last_topo);
  return floor;
}

export function shardForTopo(shards: ShardRow[], topo: number): ShardRow | null {
  for (const s of shards) {
    if (s.sealed && topo >= s.first_topo && (s.last_topo == null || topo <= s.last_topo)) return s;
  }
  return null;
}

export function targetForTopo(shards: ShardRow[], topo: number): RawTarget {
  const s = shardForTopo(shards, topo);
  return s ? { kind: "shard", dbId: s.db_id } : { kind: "hot" };
}

/** Run a SELECT against the hot DB or a shard, returning rows. */
export async function runOn(env: Env, t: RawTarget, sql: string, params: unknown[] = []): Promise<Row[]> {
  if (t.kind === "hot") {
    return env.DB.prepare(sql).bind(...params).all<Row>().then((r) => r.results ?? []);
  }
  return restQuery(env, t.dbId!, sql, params);
}

// ---------- lookups ----------

export async function fetchTx(env: Env, hash: string): Promise<{ row: Row; target: RawTarget } | null> {
  const shards = await getShards(env);
  const hot = await env.DB.prepare("SELECT * FROM tx_index WHERE hash = ?").bind(hash).first<Row>();
  if (hot) return { row: hot, target: { kind: "hot" } };
  // not in hot: fan out sealed shards (bounded by shard count, rare path)
  for (const s of shards.filter((x) => x.sealed)) {
    const rows = await runOn(env, { kind: "shard", dbId: s.db_id }, "SELECT * FROM tx_index WHERE hash = ?", [hash]);
    if (rows[0]) return { row: rows[0], target: { kind: "shard", dbId: s.db_id } };
  }
  return null;
}

export async function fetchBlock(env: Env, id: string): Promise<{ row: Row; target: RawTarget } | null> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const byTopo = async (topo: number): Promise<Row | null> => {
    if (topo > floor) {
      const row = await env.DB.prepare("SELECT * FROM blocks WHERE topoheight = ?").bind(topo).first<Row>();
      if (row) return row;
    } else {
      const s = shardForTopo(shards, topo);
      if (s) {
        const rows = await restQuery(env, s.db_id, "SELECT * FROM blocks WHERE topoheight = ?", [topo]);
        if (rows[0]) return rows[0];
      }
    }
    return null;
  };
  if (/^\d+$/.test(id)) {
    const topo = Number(id);
    const row = await byTopo(topo);
    if (row) return { row, target: targetForTopo(shards, topo) };
  }
  const hot = await env.DB.prepare("SELECT * FROM blocks WHERE hash = ?").bind(id).first<Row>();
  if (hot) return { row: hot, target: { kind: "hot" } };
  for (const s of shards.filter((x) => x.sealed)) {
    const rows = await restQuery(env, s.db_id, "SELECT * FROM blocks WHERE hash = ?", [id]);
    if (rows[0]) return { row: rows[0], target: { kind: "shard", dbId: s.db_id } };
  }
  // numeric ids may also match by height
  if (/^\d+$/.test(id)) {
    const hotH = await env.DB.prepare("SELECT * FROM blocks WHERE height = ? ORDER BY topoheight DESC LIMIT 1").bind(Number(id)).first<Row>();
    if (hotH) return { row: hotH, target: { kind: "hot" } };
    for (const s of shards.filter((x) => x.sealed)) {
      const rows = await restQuery(env, s.db_id, "SELECT * FROM blocks WHERE height = ? ORDER BY topoheight DESC LIMIT 1", [Number(id)]);
      if (rows[0]) return { row: rows[0], target: { kind: "shard", dbId: s.db_id } };
    }
  }
  return null;
}

/**
 * Resolve block timestamps (ms) for a set of topoheights across the hot DB and
 * sealed shards. Lookups are grouped per database so a list page costs at most
 * (1 + shard count) queries instead of one per row. Topos that cannot be
 * resolved (missing block, shard read error) are omitted from the map.
 */
export async function fetchBlockTimes(env: Env, topos: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const uniq = [...new Set(topos.filter((t) => Number.isFinite(t) && t > 0))];
  if (!uniq.length) return out;
  const shards = await getShards(env);
  const groups = new Map<string, { target: RawTarget; topos: number[] }>();
  for (const topo of uniq) {
    const target = targetForTopo(shards, topo);
    const key = target.kind === "hot" ? "hot" : target.dbId!;
    const g = groups.get(key);
    if (g) g.topos.push(topo);
    else groups.set(key, { target, topos: [topo] });
  }
  await Promise.all([...groups.values()].map(async ({ target, topos: ts }) => {
    try {
      const rows = await runOn(
        env, target,
        `SELECT topoheight, ts FROM blocks WHERE topoheight IN (${ts.map(() => "?").join(",")})`,
        ts,
      );
      for (const r of rows) out.set(Number(r.topoheight), Number(r.ts));
    } catch { /* shard unreachable: leave unresolved */ }
  }));
  return out;
}

/**
 * Keyset-paginated list over hot + sealed shards, newest first.
 * Walks descending segments: hot window first (topo > hotFloor), then each
 * sealed shard. `before` is the exclusive upper cursor (0 = from the top);
 * `extra` adds an arbitrary condition (e.g. block type filter).
 */
export async function pagedRaw(
  env: Env,
  opts: {
    table: string;
    cursorCol: string;
    select: string;
    before: number;
    limit: number;
    extra?: { sql: string; binds: (string | number)[] };
  },
): Promise<Row[]> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const segments: Array<{ t: RawTarget; hi: number; lo: number }> = shards
    .filter((s) => s.sealed && s.last_topo != null)
    .map((s) => ({ t: { kind: "shard" as const, dbId: s.db_id }, hi: s.last_topo!, lo: s.first_topo }));
  segments.push({ t: { kind: "hot" }, hi: Number.MAX_SAFE_INTEGER, lo: floor + 1 });
  segments.sort((a, b) => b.hi - a.hi);

  const out: Row[] = [];
  let cursor = opts.before > 0 ? opts.before : Number.MAX_SAFE_INTEGER;
  for (const seg of segments) {
    if (out.length >= opts.limit) break;
    // `< cursor` semantics: skip a segment only when all of it sits at or above
    // the exclusive cursor
    if (seg.lo >= cursor) continue;
    // exclusive upper bound; seg.hi + 1 keeps the segment's top row reachable
    const upper = seg.hi >= Number.MAX_SAFE_INTEGER ? cursor : Math.min(cursor, seg.hi + 1);
    const conds: string[] = [];
    const binds: (string | number)[] = [];
    conds.push(`${opts.cursorCol} < ?`);
    binds.push(upper);
    // hot keeps rows below the floor only until migration deletes them;
    // bound hot reads to the window to avoid double-serving copied rows
    if (seg.t.kind === "hot" && floor >= 0) {
      conds.push(`${opts.cursorCol} >= ?`);
      binds.push(seg.lo);
    }
    if (opts.extra) { conds.push(`(${opts.extra.sql})`); binds.push(...opts.extra.binds); }
    const want = opts.limit - out.length;
    const rows = await runOn(
      env, seg.t,
      `SELECT ${opts.select} FROM ${opts.table} WHERE ${conds.join(" AND ")} ORDER BY ${opts.cursorCol} DESC LIMIT ?`,
      [...binds, want],
    );
    out.push(...rows);
    // A short read means this segment is exhausted below the cursor, so the
    // walk continues strictly below it. Never raise the cursor: a `before`
    // inside a lower segment must not re-serve rows above it.
    if (rows.length < want) cursor = Math.min(cursor, seg.lo);
  }
  return out;
}

/**
 * Keyset-paginated list over hot + sealed shards, oldest first.
 * Mirror of {@link pagedRaw} for the "newer" direction: `after` is the
 * exclusive lower cursor; rows are returned ascending so callers can reverse
 * them to render the page above a known row. Enables stateless Prev links.
 */
export async function pagedRawAsc(
  env: Env,
  opts: {
    table: string;
    cursorCol: string;
    select: string;
    after: number;
    limit: number;
    extra?: { sql: string; binds: (string | number)[] };
  },
): Promise<Row[]> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const segments: Array<{ t: RawTarget; hi: number; lo: number }> = shards
    .filter((s) => s.sealed && s.first_topo != null && s.last_topo != null)
    .map((s) => ({ t: { kind: "shard" as const, dbId: s.db_id }, hi: s.last_topo!, lo: s.first_topo }));
  segments.push({ t: { kind: "hot" }, hi: Number.MAX_SAFE_INTEGER, lo: floor + 1 });
  segments.sort((a, b) => a.lo - b.lo);

  const out: Row[] = [];
  let cursor = opts.after;
  for (const seg of segments) {
    if (out.length >= opts.limit) break;
    // skippable only if the whole segment sits at or below the cursor
    if (seg.hi <= cursor) continue;
    const lower = Math.max(cursor, seg.lo - 1);
    const conds: string[] = [`${opts.cursorCol} > ?`];
    const binds: (string | number)[] = [lower];
    if (opts.extra) { conds.push(`(${opts.extra.sql})`); binds.push(...opts.extra.binds); }
    const rows = await runOn(
      env, seg.t,
      `SELECT ${opts.select} FROM ${opts.table} WHERE ${conds.join(" AND ")} ORDER BY ${opts.cursorCol} ASC LIMIT ?`,
      [...binds, opts.limit - out.length],
    );
    if (!rows.length) { cursor = seg.hi; continue; }
    out.push(...rows);
    const last = Number((rows[rows.length - 1] as Record<string, unknown>)[opts.cursorCol]);
    if (!Number.isFinite(last) || last >= seg.hi) { cursor = seg.hi; continue; }
    cursor = last;
  }
  return out;
}

/**
 * Exact bounded-range scan over hot + sealed shards for a partition-key window
 * (e.g. the topoheight slice a DAG page needs). Unlike {@link pagedRaw}, each
 * overlapping segment is asked only for its slice of [lo, hi] and the rows are
 * merged in order, so one window costs at most (1 + shard count) queries and
 * never walks the chain.
 */
export async function rangeRaw(
  env: Env,
  opts: { table: string; select: string; lo: number; hi: number; col?: string; order?: "ASC" | "DESC" },
): Promise<Row[]> {
  const col = opts.col ?? "topoheight";
  const order = opts.order ?? "ASC";
  if (!(opts.lo <= opts.hi)) return [];
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const segments: Array<{ t: RawTarget; hi: number; lo: number }> = shards
    .filter((s) => s.sealed && s.first_topo != null && s.last_topo != null)
    .map((s) => ({ t: { kind: "shard" as const, dbId: s.db_id }, hi: s.last_topo!, lo: s.first_topo }));
  segments.push({ t: { kind: "hot" }, hi: Number.MAX_SAFE_INTEGER, lo: floor + 1 });
  segments.sort((a, b) => a.lo - b.lo);

  const out: Row[] = [];
  for (const seg of segments) {
    if (seg.hi < opts.lo || seg.lo > opts.hi) continue;
    const lo = Math.max(opts.lo, seg.lo);
    const hi = Math.min(opts.hi, seg.hi);
    const rows = await runOn(
      env, seg.t,
      `SELECT ${opts.select} FROM ${opts.table} WHERE ${col} >= ? AND ${col} <= ? ORDER BY ${col} ${order}`,
      [lo, hi],
    );
    out.push(...rows);
  }
  return out;
}

/**
 * Keyset scan over hot + sealed shards for a two-column cursor ordered by
 * `cols` (e.g. "block_topo DESC, hash DESC"). The "older" direction walks
 * below the cursor and returns rows in display order; "newer" walks above it
 * and returns them nearest-first (callers reverse them for display). The first
 * column must be the shard partition key (block_topo / topoheight).
 */
export async function pagedCompositeRaw(
  env: Env,
  opts: {
    table: string;
    select: string;
    cols: [{ col: string; dir: "ASC" | "DESC" }, { col: string; dir: "ASC" | "DESC" }];
    cursor: [number | string, number | string] | null;
    limit: number;
    direction: "older" | "newer";
    extra?: { sql: string; binds: (string | number)[] };
  },
): Promise<Row[]> {
  const older = opts.direction === "older";
  if (!older && !opts.cursor) return [];
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const [c0, c1] = opts.cols;
  const part = c0.col;
  // "before/after" for the walk direction, per column direction
  const cmp = (dir: "ASC" | "DESC") => ((dir === "DESC") === older ? "<" : ">");
  const pred = opts.cursor
    ? `(${c0.col} ${cmp(c0.dir)} ? OR (${c0.col} = ? AND ${c1.col} ${cmp(c1.dir)} ?))`
    : "";
  const orderCols = older
    ? opts.cols
    : opts.cols.map((c) => ({ col: c.col, dir: c.dir === "DESC" ? ("ASC" as const) : ("DESC" as const) }));
  const order = orderCols.map((c) => `${c.col} ${c.dir}`).join(", ");

  const segments: Array<{ t: RawTarget; hi: number; lo: number }> = shards
    .filter((s) => s.sealed && s.first_topo != null && s.last_topo != null)
    .map((s) => ({ t: { kind: "shard" as const, dbId: s.db_id }, hi: s.last_topo!, lo: s.first_topo }));
  segments.push({ t: { kind: "hot" }, hi: Number.MAX_SAFE_INTEGER, lo: floor + 1 });
  segments.sort((a, b) => (older ? b.hi - a.hi : a.lo - b.lo));

  const cur0 = opts.cursor ? Number(opts.cursor[0]) : null;
  const out: Row[] = [];
  for (const seg of segments) {
    if (out.length >= opts.limit) break;
    // skip segments that sit entirely outside the cursor on the partition col
    if (cur0 != null && (older ? seg.lo > cur0 : seg.hi <= cur0)) continue;
    const conds: string[] = [];
    const binds: (string | number)[] = [];
    if (older) {
      const upper = cur0 == null ? seg.hi : Math.min(cur0, seg.hi);
      conds.push(`${part} <= ?`);
      binds.push(upper === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : upper);
      if (seg.t.kind === "hot" && floor >= 0) { conds.push(`${part} >= ?`); binds.push(seg.lo); }
    } else {
      conds.push(`${part} >= ?`);
      binds.push(cur0 == null ? seg.lo : Math.max(cur0, seg.lo));
    }
    if (pred) { conds.push(pred); binds.push(opts.cursor![0], opts.cursor![0], opts.cursor![1]); }
    if (opts.extra) { conds.push(`(${opts.extra.sql})`); binds.push(...opts.extra.binds); }
    const rows = await runOn(
      env, seg.t,
      `SELECT ${opts.select} FROM ${opts.table} WHERE ${conds.join(" AND ")} ORDER BY ${order} LIMIT ?`,
      [...binds, opts.limit - out.length],
    );
    out.push(...rows);
  }
  return out;
}

// ---------- cross-shard fan-out helpers (SSR pages) ----------
function cmpVal(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1; // SQLite NULLs sort smallest
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  const af = Number(a), bf = Number(b);
  if (Number.isFinite(af) && Number.isFinite(bf) && String(af) === String(a) && String(bf) === String(b)) {
    return af < bf ? -1 : af > bf ? 1 : 0;
  }
  const as = String(a), bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Build a JS comparator from an SQL ORDER BY clause ("col DESC, other ASC"). */
export function cmpBy(order: string): (a: Row, b: Row) => number {
  const cols = order.split(",").map((s) => s.trim()).filter(Boolean).map((t) => {
    const parts = t.split(/\s+/);
    return { col: parts[0], desc: (parts[1] ?? "ASC").toUpperCase() === "DESC" };
  });
  return (a, b) => {
    for (const { col, desc } of cols) {
      let r = cmpVal(a[col], b[col]);
      if (r !== 0) return desc ? -r : r;
    }
    return 0;
  };
}

function allTargets(shards: ShardRow[]): RawTarget[] {
  const ts: RawTarget[] = shards.filter((s) => s.sealed).map((s) => ({ kind: "shard", dbId: s.db_id }));
  ts.push({ kind: "hot" });
  return ts;
}

function sealedTargets(shards: ShardRow[]): RawTarget[] {
  return shards.filter((s) => s.sealed).map((s) => ({ kind: "shard", dbId: s.db_id }));
}

// Sealed shards are immutable, so their contribution to any query is fixed for
// a given hotFloor. The additive helpers below split the targets into sealed
// shards (computed once and cached in KV) and the hot window (computed live),
// so a request scans only the recent window plus a single cache read instead of
// all history. Keys include the floor, so sealing a new shard starts a fresh
// key; the TTL reclaims the old ones without any enumeration.
const AGG_CACHE_TTL = 30 * 86400;

async function aggCacheKey(scope: string, floor: number, sql: string, binds: unknown[]): Promise<string> {
  const raw = `${scope}|${floor}|${sql}|${JSON.stringify(binds)}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return "shardagg:" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readAggCache<T>(env: Env, key: string): Promise<T | null> {
  try {
    return (await env.KV.get(key, "json")) as T | null;
  } catch {
    return null;
  }
}

async function writeAggCache(env: Env, key: string, value: unknown): Promise<void> {
  try {
    await env.KV.put(key, JSON.stringify(value), { expirationTtl: AGG_CACHE_TTL });
  } catch { /* cache is best-effort: a miss just recomputes */ }
}

// bound hot reads to the retained window so rows mid-migration (present in
// hot and shard) are never served twice; NULL cursors never migrate, keep them
function hotFloorBound(floorCol: string, floor: number): string {
  return `(${floorCol} > ${floor} OR ${floorCol} IS NULL)`;
}

// Inject that bound into a caller-supplied single-scope aggregate SELECT.
// Contract: the SQL must be `SELECT ... FROM ... [WHERE ...]` with any
// GROUP BY / ORDER BY / LIMIT / HAVING only at the end. Callers that run over
// raw tables across shards pass floorCol so the hot target skips rows that are
// still duplicated between seal and prune; shard targets read unmodified.
function boundHotTarget(sql: string, floorCol: string, floor: number): string {
  const cond = hotFloorBound(floorCol, floor);
  // only a top-level clause keyword splits the statement; keywords inside a
  // parenthesised subquery (e.g. `(SELECT ... ORDER BY ...)`) are skipped
  const re = /\s(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING)\s/gi;
  let cut = -1;
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    let depth = 0;
    for (let i = 0; i < m.index; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
    }
    if (depth === 0) { cut = m.index; break; }
  }
  const head = cut >= 0 ? sql.slice(0, cut) : sql;
  const tail = cut >= 0 ? sql.slice(cut) : "";
  // same depth rule for WHERE: a subquery's WHERE is not the outer one
  let topWhere = false;
  let depth = 0;
  const wre = /\bWHERE\b|\(|\)/gi;
  for (let m = wre.exec(head); m; m = wre.exec(head)) {
    if (m[0] === "(") depth++;
    else if (m[0] === ")") depth--;
    else if (depth === 0) { topWhere = true; break; }
  }
  return topWhere ? `${head} AND ${cond}${tail}` : `${head} WHERE ${cond}${tail}`;
}

/**
 * Run one query on each sealed shard, tolerating unreachable shards: a failed
 * shard contributes nothing and `ok` is false so the partial result is served
 * but never cached as the immutable sealed contribution.
 */
async function runSealed(env: Env, targets: RawTarget[], sql: string, binds: unknown[]): Promise<{ rows: Row[][]; ok: boolean }> {
  let ok = true;
  const rows = await Promise.all(targets.map((t) => runOn(env, t, sql, binds).catch((err) => {
    ok = false;
    console.error("shard read failed:", t.dbId, err instanceof Error ? err.message : err);
    return [] as Row[];
  })));
  return { rows, ok };
}

const countCache = new Map<string, { at: number; n: number }>();

/**
 * COUNT(*) over hot + all sealed shards (60s in-process cache; the sealed-shard
 * contribution is cached in KV so only the hot window is counted per request).
 */
export async function countRaw(
  env: Env,
  opts: { table: string; extra?: { sql: string; binds: unknown[] }; floorCol?: string },
): Promise<number> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const where = opts.extra ? `WHERE ${opts.extra.sql}` : "";
  const binds = [...(opts.extra?.binds ?? [])];
  const key = `${opts.table}|${where}|${binds.join(",")}|${floor}`;
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.n;

  const sql = `SELECT COUNT(*) AS n FROM ${opts.table} ${where}`;
  const sealed = sealedTargets(shards);
  let sealedN = 0;
  if (sealed.length) {
    const ck = await aggCacheKey("count", floor, sql, binds);
    const cached = await readAggCache<number>(env, ck);
    if (cached != null) {
      sealedN = cached;
    } else {
      const { rows: parts, ok } = await runSealed(env, sealed, sql, binds);
      sealedN = parts.reduce((a, rows) => a + Number(rows[0]?.n ?? 0), 0);
      if (ok) await writeAggCache(env, ck, sealedN);
    }
  }

  // the hot target is bounded to the retained window only when a floor column
  // is supplied (same contract as before: callers without one count all of hot)
  let hotWhere = where;
  if (floor >= 0 && opts.floorCol) {
    const cond = hotFloorBound(opts.floorCol, floor);
    hotWhere = where ? `${where} AND ${cond}` : `WHERE ${cond}`;
  }
  let hot: Row[];
  if (opts.table === "blocks" && !opts.extra && opts.floorCol === "topoheight" && floor >= 0) {
    // topoheight is the rowid PK of a contiguous chain: MIN/MAX are O(1) b-tree
    // edge reads, versus COUNT(*) walking millions of rows over the hot window.
    const r = await runOn(env, { kind: "hot" },
      "SELECT MIN(topoheight) AS lo, MAX(topoheight) AS hi FROM blocks WHERE topoheight > ?", [floor]);
    const lo = Number(r[0]?.lo), hi = Number(r[0]?.hi);
    hot = [{ n: Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo + 1 : 0 }];
  } else {
    hot = await runOn(env, { kind: "hot" }, `SELECT COUNT(*) AS n FROM ${opts.table} ${hotWhere}`, binds);
  }
  const n = sealedN + Number(hot[0]?.n ?? 0);
  countCache.set(key, { at: Date.now(), n });
  return n;
}

// Ceiling on rows fetched per database when merging across shards. A Worker
// cannot materialize an arbitrary OFFSET across multiple DBs in memory, so
// offsets deeper than this degrade to an empty page instead of an OOM crash
// (which the dev proxy surfaces as a bare "fetch failed").
const MAX_MERGE_FETCH = 10_000;

/**
 * Top-N over hot + all sealed shards for arbitrary ORDER BY / OFFSET pages:
 * each segment returns its own top (skip+limit) rows, merged and re-sorted in
 * JS, then sliced — equivalent to ORDER BY ... LIMIT ? OFFSET ? over one DB.
 */
export async function topNRaw(
  env: Env,
  opts: {
    table: string;
    select: string;
    order: string;
    limit: number;
    skip?: number;
    extra?: { sql: string; binds: unknown[] };
    floorCol?: string;
  },
): Promise<Row[]> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const skip = Math.max(0, opts.skip ?? 0);
  const need = skip + opts.limit;
  const where = opts.extra ? `WHERE ${opts.extra.sql}` : "";
  const binds = [...(opts.extra?.binds ?? [])];
  const targets = allTargets(shards);

  // Single database (hot only): push OFFSET into SQL. A deep page then returns
  // just `limit` rows instead of every preceding row, which is what previously
  // exhausted Worker memory on pages like `?page=361742`.
  if (targets.length === 1) {
    return runOn(
      env, targets[0],
      `SELECT ${opts.select} FROM ${opts.table} ${where} ORDER BY ${opts.order} LIMIT ? OFFSET ?`,
      [...binds, opts.limit, skip],
    );
  }

  let hotWhere = where;
  if (floor >= 0 && opts.floorCol) {
    hotWhere = where ? `${where} AND ${hotFloorBound(opts.floorCol, floor)}` : `WHERE ${hotFloorBound(opts.floorCol, floor)}`;
  }
  const fetch = Math.min(need, MAX_MERGE_FETCH);
  const per = await Promise.all(targets.map(async (t) => {
    // beyond the addressable window the global offset cannot be resolved
    if (skip >= MAX_MERGE_FETCH) return [] as Row[];
    const w = t.kind === "hot" ? hotWhere : where;
    const q = `SELECT ${opts.select} FROM ${opts.table} ${w} ORDER BY ${opts.order} LIMIT ${fetch}`;
    if (t.kind === "hot") return runOn(env, t, q, binds);
    return (await runSealed(env, [t], q, binds)).rows[0];
  }));
  const merged = per.flat();
  merged.sort(cmpBy(opts.order));
  return merged.slice(skip, need);
}

function normalizeCols(c: string | string[] | undefined): string[] {
  return c == null ? [] : typeof c === "string" ? [c] : c;
}

/**
 * Fold one or more single-row aggregate row sets into an accumulator. Sum
 * columns add, min/max columns combine by min/max; `accIn` seeds the fold (the
 * cached sealed-shard result) so only the hot row set needs merging per request.
 */
function foldAgg(
  rowsets: Row[][],
  sumCols: string[],
  mins: string[],
  maxs: string[],
  accIn: Record<string, number> | null,
): Record<string, number> {
  const out: Record<string, number> = accIn ? { ...accIn } : {};
  for (const col of sumCols) out[col] = out[col] ?? 0;
  for (const rowsOne of rowsets) {
    const r = rowsOne[0];
    if (!r) continue;
    for (const col of sumCols) {
      const v = r[col];
      if (v != null) out[col] = (out[col] ?? 0) + Number(v);
    }
    for (const [kind, cols] of [["min", mins], ["max", maxs]] as const) {
      for (const col of cols) {
        const v = r[col];
        if (v == null) continue;
        const n = Number(v);
        if (!Number.isFinite(out[col])) out[col] = n;
        else out[col] = kind === "min" ? Math.min(out[col], n) : Math.max(out[col], n);
      }
    }
  }
  return out;
}

/**
 * Run an additive aggregate (SUMs/COUNTs + optional MIN/MAX cols) over the hot
 * window and merge it with the sealed-shard result. Use SUM instead of AVG in
 * the SQL; averages are computed by the caller from sum/count pairs. When
 * `floorCol` is set the hot target is bounded to the retained window (see
 * {@link boundHotTarget}). The sealed-shard contribution is immutable for a
 * given floor and cached in KV.
 */
export async function mergeAgg(
  env: Env,
  sql: string,
  binds: unknown[],
  opts: { sum: string[]; min?: string | string[]; max?: string | string[]; floorCol?: string; minTs?: number },
): Promise<Record<string, number>> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  // `minTs`: the query only matches rows with ts > minTs, so shards that end
  // at or before it cannot contribute. Skipping them keeps rolling windows
  // (e.g. "last 24h", whose binds change every request) off the shards and
  // out of the KV cache, which such keys could never hit anyway.
  const sealed = opts.minTs == null
    ? sealedTargets(shards)
    : sealedTargets(shards.filter((s) => s.last_ts == null || s.last_ts > opts.minTs!));
  const mins = normalizeCols(opts.min);
  const maxs = normalizeCols(opts.max);

  let sealedAgg: Record<string, number> | null = null;
  if (sealed.length) {
    const scope = `agg|${opts.sum.join(",")}|${mins.join(",")}|${maxs.join(",")}`;
    const ck = await aggCacheKey(scope, floor, sql, binds);
    sealedAgg = await readAggCache<Record<string, number>>(env, ck);
    if (!sealedAgg) {
      const { rows, ok } = await runSealed(env, sealed, sql, binds);
      sealedAgg = foldAgg(rows, opts.sum, mins, maxs, null);
      if (ok) await writeAggCache(env, ck, sealedAgg);
    }
  }

  const hot = await runOn(
    env, { kind: "hot" },
    floor >= 0 && opts.floorCol ? boundHotTarget(sql, opts.floorCol, floor) : sql,
    binds,
  );
  return foldAgg([hot], opts.sum, mins, maxs, sealedAgg);
}

/**
 * Merge GROUP BY rows into a key-indexed accumulator. Sum columns add; max/min
 * columns combine by max/min (monotonic or boundary columns, e.g. cumulative
 * chain difficulty). `into` seeds the map with the cached sealed-shard groups.
 */
function foldGroups(
  rowsets: Row[][],
  keyCol: string,
  sumCols: string[],
  maxs: string[],
  mins: string[],
  into?: Map<string, Row>,
): Map<string, Row> {
  const byKey = into ?? new Map<string, Row>();
  for (const rs of rowsets) {
    for (const r of rs) {
      const key = String(r[keyCol] ?? "");
      const acc = byKey.get(key);
      if (!acc) {
        const fresh: Row = { [keyCol]: r[keyCol] };
        for (const c of sumCols) fresh[c] = Number(r[c] ?? 0);
        for (const c of maxs) {
          const v = r[c];
          fresh[c] = v == null ? null : Number(v);
        }
        for (const c of mins) {
          const v = r[c];
          fresh[c] = v == null ? null : Number(v);
        }
        byKey.set(key, fresh);
      } else {
        for (const c of sumCols) acc[c] = Number(acc[c] ?? 0) + Number(r[c] ?? 0);
        for (const c of maxs) {
          const v = r[c];
          if (v == null) continue;
          const n = Number(v);
          acc[c] = acc[c] == null ? n : Math.max(Number(acc[c]), n);
        }
        for (const c of mins) {
          const v = r[c];
          if (v == null) continue;
          const n = Number(v);
          acc[c] = acc[c] == null ? n : Math.min(Number(acc[c]), n);
        }
      }
    }
  }
  return byKey;
}

/**
 * GROUP BY over hot + sealed shards with additive value columns, merged by key
 * in JS. Returns unmerged-order rows: [{ [keyCol]: key, ...sums }]. `maxCols`
 * and `minCols` merge by max/min (monotonic or boundary columns); `floorCol`
 * bounds the hot target to the retained window, like {@link boundHotTarget}.
 * The sealed-shard groups are immutable for a given floor and cached in KV.
 */
export async function mergeGroups(
  env: Env,
  sql: string,
  binds: unknown[],
  keyCol: string,
  sumCols: string[],
  opts: { maxCols?: string[]; minCols?: string[]; floorCol?: string } = {},
): Promise<Row[]> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const sealed = sealedTargets(shards);
  const maxs = opts.maxCols ?? [];
  const mins = opts.minCols ?? [];

  let byKey: Map<string, Row>;
  if (sealed.length) {
    const scope = `groups|${keyCol}|${sumCols.join(",")}|${maxs.join(",")}|${mins.join(",")}`;
    const ck = await aggCacheKey(scope, floor, sql, binds);
    const cached = await readAggCache<Row[]>(env, ck);
    if (cached) {
      byKey = new Map();
      for (const r of cached) byKey.set(String(r[keyCol] ?? ""), r);
    } else {
      const { rows: rowsets, ok } = await runSealed(env, sealed, sql, binds);
      byKey = foldGroups(rowsets, keyCol, sumCols, maxs, mins);
      if (ok) await writeAggCache(env, ck, [...byKey.values()]);
    }
  } else {
    byKey = new Map();
  }

  const hot = await runOn(
    env, { kind: "hot" },
    floor >= 0 && opts.floorCol ? boundHotTarget(sql, opts.floorCol, floor) : sql,
    binds,
  );
  foldGroups([hot], keyCol, sumCols, maxs, mins, byKey);
  return [...byKey.values()];
}

// ---------- rotation ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqlVal(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "bigint") return String(v);
  // REST-side bulk inserts cannot use bound params (D1 allows only 100/query),
  // so literals are quoted here; NUL is stripped because SQLite treats it as a
  // statement terminator.
  return "'" + String(v).replace(/\u0000/g, "").replace(/'/g, "''") + "'";
}

function insertLiteral(table: string, rows: Row[]): string {
  const cols = SHARD_TABLES[table];
  const values = rows.map((r) => `(${cols.map((c) => sqlVal(r[c])).join(",")})`);
  return `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")}`;
}

// D1 caps SQL statements at 100 KB, so bulk inserts are split by row count and
// approximate payload size rather than issuing one huge statement.
const INSERT_CHUNK = 90;
const INSERT_BYTES = 40_000;

function chunkRows(rows: Row[], maxRows: number, maxBytes: number): Row[][] {
  const out: Row[][] = [];
  let cur: Row[] = [];
  let bytes = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (cur.length && (cur.length >= maxRows || bytes + n > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(r);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Bulk insert rows into a shard via REST, chunked under D1's SQL size cap. */
async function restInsert(env: Env, dbId: string, table: string, rows: Row[]): Promise<void> {
  for (const chunk of chunkRows(rows, INSERT_CHUNK, INSERT_BYTES)) {
    await restQuery(env, dbId, insertLiteral(table, chunk));
  }
}

async function cursorOf(env: Env, stage: string, fallback: number): Promise<number> {
  const row = await env.DB.prepare("SELECT cursor FROM sync_state WHERE stage = ?").bind(stage).first<{ cursor: number }>();
  return row?.cursor ?? fallback;
}

async function setCursor(env: Env, stage: string, cursor: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO sync_state (stage, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(stage) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at"
  ).bind(stage, cursor, Date.now()).run();
}

function changesOf(r: D1Result<unknown> | undefined): number {
  return Number((r as { meta?: { changes?: number } } | undefined)?.meta?.changes ?? 0);
}

const COPY_BATCH = 200;
// keep this many recent topoheights in the hot DB window
const KEEP_HOT_BLOCKS = 200_000;
// hot rows deleted per prune batch once their shard is sealed
const PRUNE_BLOCKS = 500;
// prune batches shrink to this block span before a failure is fatal
const PRUNE_MIN = 100;
// sealed-shard hashes enumerated per REST read when sweeping legacy assets
const ASSET_CHUNK = 90;
// topoheight span of one legacy asset-sweep boundary
const ASSET_SWEEP_BLOCKS = 500;

/**
 * Size-triggered rotation, run hourly. Prunes hot rows already owned by sealed
 * shards, then creates a shard DB when the hot DB crosses SHARD_MAX_BYTES and
 * incrementally copies old raw rows into it within the remaining per-run
 * budget. Deletion is deferred to {@link pruneShards} until after the seal.
 * Idempotent and resumable via sync_state stages and `shards.copied_topo`.
 */
export async function rotateShards(env: Env, budgetMs = 25_000): Promise<string> {
  if (!shardsConfigured(env)) return "disabled";
  const started = Date.now();
  const deadline = started + budgetMs;

  // Prune first: deferred deletes mean sealed shards leave duplicates in hot
  // until this drains them, and freeing space is what keeps writes under the
  // hardcap. A third of the budget is enough; the copy phase keeps the rest.
  const pruned = await pruneShards(env, started + Math.min(Math.floor(budgetMs / 3), 10_000));

  let shards = await getShards(env, true);
  await ensureShardIndexes(env, shards);
  let open = shards.find((s) => !s.sealed && s.last_topo != null);

  if (!open) {
    const bytes = await hotFileBytes(env);
    if (bytes == null || bytes < maxBytes(env)) return joinStatus(pruned, `ok (${bytes ?? "?"} bytes)`);
    const b = await env.DB.prepare("SELECT MIN(topoheight) AS mn, MAX(topoheight) AS mx FROM blocks").first<{ mn: number | null; mx: number | null }>();
    const maxTopo = Number(b?.mx ?? 0);
    // never re-copy a range an earlier shard already owns: unpruned duplicates
    // can sit below hotFloor while the new shard is being filled
    const minTopo = Math.max(Number(b?.mn ?? 0), hotFloor(shards) + 1);
    const cut = maxTopo - KEEP_HOT_BLOCKS;
    if (!maxTopo || cut <= minTopo) return joinStatus(pruned, "ok (nothing to cut yet)");
    // unique suffix: a crash between create and registry insert leaves an
    // orphan DB, and a reused name would make every later create fail
    const name = `xelis-explorer-shard-${shards.length + 1}-${Date.now().toString(36)}`;
    const dbId = await createShardDatabase(env, name);
    if (!dbId) throw new Error("shard create: no uuid returned");
    await initShardSchema(env, dbId);
    await env.DB.prepare(
      "INSERT INTO shards (name, db_id, first_topo, last_topo, copied_topo, sealed, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)"
    ).bind(name, dbId, minTopo, cut, Date.now()).run();
    invalidate();
    shards = await getShards(env, true);
    open = shards.find((s) => !s.sealed);
    if (!open) return joinStatus(pruned, "created shard, retry next run");
  }

  const target = open.last_topo!;
  let cursor = open.copied_topo >= open.first_topo ? open.copied_topo : open.first_topo - 1;
  let copied = 0;

  while (cursor < target && Date.now() < deadline) {
    const prev = cursor;
    // 1) copy block batch into the shard
    const blocks = await env.DB.prepare(
      "SELECT * FROM blocks WHERE topoheight > ? AND topoheight <= ? ORDER BY topoheight LIMIT ?"
    ).bind(cursor, target, COPY_BATCH).all<Row>();
    const blockRows = blocks.results ?? [];
    if (blockRows.length) {
      await restInsert(env, open.db_id, "blocks", blockRows);
      copied += blockRows.length;
      cursor = Number(blockRows[blockRows.length - 1].topoheight);
    } else {
      cursor = target;
    }

    // 2) copy dependent tx rows for the same topo slice (hash lookups chunked:
    // D1 allows only 100 bound params per query)
    if (cursor > prev) {
      const txs = await env.DB.prepare(
        "SELECT * FROM tx_index WHERE block_topo > ? AND block_topo <= ?"
      ).bind(prev, cursor).all<Row>();
      const txRows = txs.results ?? [];
      if (txRows.length) {
        const hashes = txRows.map((r) => String(r.hash));
        await restInsert(env, open.db_id, "tx_index", txRows);
        copied += txRows.length;
        for (const [table, keyCol] of [["tx_assets", "tx_hash"], ["tx_contracts", "tx_hash"]] as const) {
          for (let i = 0; i < hashes.length; i += ASSET_CHUNK) {
            const chunk = hashes.slice(i, i + ASSET_CHUNK);
            const rows = await env.DB.prepare(
              `SELECT * FROM ${table} WHERE ${keyCol} IN (${chunk.map(() => "?").join(",")})`
            ).bind(...chunk).all<Row>();
            if (rows.results?.length) {
              await restInsert(env, open.db_id, table, rows.results);
              copied += rows.results.length;
            }
          }
        }
      }
      // 3) the copied slice stays in hot: serving is bounded to topo >
      // hotFloor, so duplicates are invisible until pruneShards removes them.
      await env.DB.prepare("UPDATE shards SET copied_topo = ? WHERE id = ?").bind(cursor, open.id).run();
    }
  }

  // 4) seal when the whole range has been migrated
  if (cursor >= target) {
    const bounds = await restQuery(env, open.db_id, "SELECT MIN(ts) AS f, MAX(ts) AS l FROM blocks").then((r) => r[0] ?? null);
    // Shards copied by this deferred-delete code still have their whole range
    // in hot, so the generic prune covers their tx_assets rows and the legacy
    // per-shard hash sweep can be marked done. A missing prefix means an older
    // copy-and-delete run migrated part of the range; let the sweep clean up.
    const minRow = await env.DB.prepare(
      "SELECT MIN(topoheight) AS mn FROM blocks WHERE topoheight >= ? AND topoheight <= ?"
    ).bind(open.first_topo, target).first<{ mn: number | null }>();
    if (minRow?.mn != null && Number(minRow.mn) <= open.first_topo) {
      await setCursor(env, `shard_assets_${open.id}`, target);
    }
    await env.DB.prepare(
      "UPDATE shards SET sealed = 1, copied_topo = ?, first_ts = ?, last_ts = ? WHERE id = ?"
    ).bind(target, bounds ? Number(bounds.f ?? 0) : null, bounds ? Number(bounds.l ?? 0) : null, open.id).run();
    invalidate();
    return joinStatus(pruned, `sealed shard ${open.name} (${open.first_topo}..${target})`);
  }
  return joinStatus(pruned, `copied ${copied} rows, cursor ${cursor}/${target}`);
}

function joinStatus(...parts: string[]): string {
  return parts.filter(Boolean).join("; ");
}

/**
 * Delete hot rows whose topoheight range a sealed shard already owns. Deletes
 * are deferred until after the seal so a copying shard never makes its rows
 * unreadable; pruning then runs in bounded batches. Progress is one monotonic
 * cursor ('shard_prune') because sealed shards form a contiguous topo range.
 * Each batch deletes tx_assets/tx_contracts (via a subquery on the hot
 * tx_index rows), then tx_index and blocks, atomically. Shards sealed by the
 * old copy-and-delete rotation have no hot tx_index left, so their orphaned
 * tx_assets/tx_contracts rows are swept per shard, driven by the shard copy.
 */
async function pruneShards(env: Env, deadline: number): Promise<string> {
  const shards = await getShards(env, true);
  const floor = hotFloor(shards);
  if (floor < 0) return "";
  let cursor = await cursorOf(env, "shard_prune", -1);
  let deleted = 0;
  let step = PRUNE_BLOCKS;
  while (cursor < floor && Date.now() < deadline) {
    const s = shards
      .filter((x) => x.sealed && x.last_topo != null && x.last_topo > cursor)
      .sort((a, b) => a.first_topo - b.first_topo)[0];
    if (!s) break;
    if (cursor < s.first_topo) cursor = s.first_topo - 1; // gap: nothing to delete
    const target = Math.min(s.last_topo!, floor);
    const boundary = await env.DB.prepare(
      "SELECT MAX(topoheight) AS m FROM (SELECT topoheight FROM blocks WHERE topoheight > ? AND topoheight <= ? ORDER BY topoheight LIMIT ?)"
    ).bind(cursor, target, step).first<{ m: number | null }>();
    if (boundary?.m == null) {
      // no hot blocks left in this slice: either already pruned, or migrated by
      // the old rotation which deleted blocks/tx_index but left tx_assets
      const swept = await sweepShardAssets(env, s, deadline);
      deleted += swept.deleted;
      if (!swept.done) break;
      cursor = target;
      await setCursor(env, "shard_prune", cursor);
      continue;
    }
    const hi = Number(boundary.m);
    let res: D1Result<unknown>[];
    try {
      res = await env.DB.batch([
        env.DB.prepare("DELETE FROM tx_assets WHERE tx_hash IN (SELECT hash FROM tx_index WHERE block_topo > ? AND block_topo <= ?)").bind(cursor, hi),
        env.DB.prepare("DELETE FROM tx_contracts WHERE tx_hash IN (SELECT hash FROM tx_index WHERE block_topo > ? AND block_topo <= ?)").bind(cursor, hi),
        env.DB.prepare("DELETE FROM tx_index WHERE block_topo > ? AND block_topo <= ?").bind(cursor, hi),
        env.DB.prepare("DELETE FROM blocks WHERE topoheight > ? AND topoheight <= ?").bind(cursor, hi),
        env.DB.prepare("INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('shard_prune', ?, ?) ON CONFLICT(stage) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at").bind(hi, Date.now()),
      ]);
    } catch (err) {
      // oversized batch (dense tx blocks) or a transient D1 error: shrink and
      // retry; the batch is atomic, so the cursor did not move
      if (step <= PRUNE_MIN) throw err;
      step = Math.max(PRUNE_MIN, Math.floor(step / 2));
      continue;
    }
    deleted += changesOf(res[2]) + changesOf(res[3]);
    cursor = hi;
  }
  return deleted > 0 ? `pruned ${deleted} rows` : "";
}

/**
 * One-time cleanup for ranges migrated by the old copy-and-delete rotation:
 * enumerate tx hashes from the shard copy (hot no longer has them) and delete
 * any matching tx_assets/tx_contracts rows still in hot. Resumable: the stage
 * cursor records the last fully swept topoheight, so an interrupted boundary
 * is simply redone (deletes are idempotent).
 */
async function sweepShardAssets(env: Env, s: ShardRow, deadline: number): Promise<{ done: boolean; deleted: number }> {
  const last = s.last_topo ?? 0;
  const stage = `shard_assets_${s.id}`;
  let cursor = await cursorOf(env, stage, -1);
  if (cursor >= last) return { done: true, deleted: 0 };
  let deleted = 0;
  while (cursor < last && Date.now() < deadline) {
    const hi = Math.min(last, cursor + ASSET_SWEEP_BLOCKS);
    let kTopo: number | null = null;
    let kHash = "";
    for (;;) {
      const keyset = kTopo == null ? "" : " AND (block_topo > ? OR (block_topo = ? AND hash > ?))";
      const binds = kTopo == null ? [cursor, hi, ASSET_CHUNK] : [cursor, hi, kTopo, kTopo, kHash, ASSET_CHUNK];
      const rows = await restQuery(
        env, s.db_id,
        `SELECT hash, block_topo FROM tx_index WHERE block_topo > ? AND block_topo <= ?${keyset} ORDER BY block_topo, hash LIMIT ?`,
        binds,
      );
      if (!rows.length) break;
      for (let i = 0; i < rows.length; i += ASSET_CHUNK) {
        const hs = rows.slice(i, i + ASSET_CHUNK).map((r) => String(r.hash));
        const marks = hs.map(() => "?").join(",");
        const res = await env.DB.batch([
          env.DB.prepare(`DELETE FROM tx_assets WHERE tx_hash IN (${marks})`).bind(...hs),
          env.DB.prepare(`DELETE FROM tx_contracts WHERE tx_hash IN (${marks})`).bind(...hs),
        ]);
        deleted += changesOf(res[0]) + changesOf(res[1]);
      }
      const lastRow = rows[rows.length - 1];
      kTopo = Number(lastRow.block_topo);
      kHash = String(lastRow.hash);
      if (rows.length < ASSET_CHUNK) break;
      if (Date.now() >= deadline) return { done: false, deleted };
    }
    cursor = hi;
    await setCursor(env, stage, cursor);
  }
  return { done: cursor >= last, deleted };
}

