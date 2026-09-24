/**
 * D1 shard router: works around the 10GB per-database hardcap.
 *
 * Layout:
 *  - Hot DB (env.DB binding): aggregates, accounts, assets, market/peer data,
 *    plus the recent raw chain window (blocks/tx_index/tx_assets/tx_contracts
 *    with topoheight > hotFloor).
 *  - Shard DBs (created via the Cloudflare REST API, no wrangler bindings):
 *    sealed topoheight ranges of the same raw tables, e.g. [0 .. 500_000].
 *  - shards table (hot DB): the routing registry. tx_route/block_route map
 *    hashes to topoheights so point lookups hit exactly one database.
 *
 * Rotation (rotateShards, called hourly from cron): when the hot DB crosses
 * SHARD_MAX_BYTES, create a shard DB, then copy+delete old raw rows topo batch
 * by topo batch within a time budget per run, then seal the shard. Rotation is
 * size-triggered, not calendar-triggered: at current chain volume shards are
 * rare and each may span a year or more.
 *
 * Required setup:
 *   wrangler secret put CLOUDFLARE_ACCOUNT_ID
 *   wrangler secret put CLOUDFLARE_API_TOKEN
 *   vars: XELIS_STATS_DB_ID (hot DB uuid, for size checks), SHARD_MAX_BYTES
 * Without the secrets the whole module is a no-op and the app behaves as before.
 */
import type { Env } from "./app";

const CF_API = "https://api.cloudflare.com/client/v4";
const CACHE_MS = 60_000;

// Raw chain tables replicated into every shard (subset of 0001_init.sql).
const SHARD_SCHEMA = [
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
  // sort indexes mirrored from migrations/0001_init.sql
  "CREATE INDEX IF NOT EXISTS idx_blocks_ts_topo ON blocks(ts, topoheight)",
  "CREATE INDEX IF NOT EXISTS idx_blocks_tx_count_topo ON blocks(tx_count, topoheight)",
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
  "CREATE TABLE IF NOT EXISTS tx_assets (tx_hash TEXT, asset TEXT, PRIMARY KEY (tx_hash, asset))",
  "CREATE INDEX IF NOT EXISTS idx_tx_assets_asset ON tx_assets(asset)",
  "CREATE TABLE IF NOT EXISTS tx_contracts (tx_hash TEXT PRIMARY KEY, contract_id TEXT, max_gas INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_tx_contracts_cid ON tx_contracts(contract_id)",
];

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
  try {
    const row = await env.DB.prepare(
      "SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS bytes"
    ).first<{ bytes: number }>();
    if (row?.bytes) return Number(row.bytes);
  } catch { /* fall through to REST */ }
  return env.XELIS_STATS_DB_ID ? dbFileBytes(env, env.XELIS_STATS_DB_ID) : null;
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

// ---------- routing / lookups ----------

async function routeTopo(env: Env, table: "tx_route" | "block_route", hash: string): Promise<number | null> {
  const col = table === "tx_route" ? "block_topo" : "topoheight";
  const row = await env.DB.prepare(`SELECT ${col} AS t FROM ${table} WHERE hash = ?`).bind(hash).first<{ t: number }>();
  return row?.t != null ? Number(row.t) : null;
}

async function cacheRoute(env: Env, table: "tx_route" | "block_route", hash: string, topo: number): Promise<void> {
  if (!hash || topo <= 0) return;
  try {
    const col = table === "tx_route" ? "block_topo" : "topoheight";
    await env.DB.prepare(`INSERT OR IGNORE INTO ${table} (hash, ${col}) VALUES (?, ?)`).bind(hash, topo).run();
  } catch { /* best-effort cache */ }
}

export async function fetchTx(env: Env, hash: string): Promise<{ row: Row; target: RawTarget } | null> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const routed = await routeTopo(env, "tx_route", hash);
  if (routed != null && routed <= floor) {
    const rows = await runOn(env, targetForTopo(shards, routed), "SELECT * FROM tx_index WHERE hash = ?", [hash]);
    if (rows[0]) return { row: rows[0], target: targetForTopo(shards, routed) };
  }
  const hot = await env.DB.prepare("SELECT * FROM tx_index WHERE hash = ?").bind(hash).first<Row>();
  if (hot) {
    const topo = Number(hot.block_topo ?? 0);
    if (topo > 0) void cacheRoute(env, "tx_route", hash, topo);
    return { row: hot, target: { kind: "hot" } };
  }
  // not in hot: fan out sealed shards (bounded by shard count, rare path)
  for (const s of shards.filter((x) => x.sealed)) {
    const rows = await runOn(env, { kind: "shard", dbId: s.db_id }, "SELECT * FROM tx_index WHERE hash = ?", [hash]);
    if (rows[0]) {
      void cacheRoute(env, "tx_route", hash, Number(rows[0].block_topo ?? 0));
      return { row: rows[0], target: { kind: "shard", dbId: s.db_id } };
    }
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
  const routed = await routeTopo(env, "block_route", id);
  if (routed != null) {
    const row = await byTopo(routed);
    if (row) return { row, target: targetForTopo(shards, routed) };
  }
  const hot = await env.DB.prepare("SELECT * FROM blocks WHERE hash = ?").bind(id).first<Row>();
  if (hot) {
    void cacheRoute(env, "block_route", id, Number(hot.topoheight ?? 0));
    return { row: hot, target: { kind: "hot" } };
  }
  for (const s of shards.filter((x) => x.sealed)) {
    const rows = await restQuery(env, s.db_id, "SELECT * FROM blocks WHERE hash = ?", [id]);
    if (rows[0]) {
      void cacheRoute(env, "block_route", id, Number(rows[0].topoheight ?? 0));
      return { row: rows[0], target: { kind: "shard", dbId: s.db_id } };
    }
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
    // `< cursor` semantics: a segment is skippable only if even its top row
    // falls at or above the exclusive cursor boundary
    if (seg.hi < cursor - 1) continue;
    const upper = Math.min(cursor, seg.hi);
    const conds: string[] = [];
    const binds: (string | number)[] = [];
    conds.push(`${opts.cursorCol} < ?`);
    binds.push(upper === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : upper);
    // hot keeps rows below the floor only until migration deletes them;
    // bound hot reads to the window to avoid double-serving copied rows
    if (seg.t.kind === "hot" && floor >= 0) {
      conds.push(`${opts.cursorCol} >= ?`);
      binds.push(seg.lo);
    }
    if (opts.extra) { conds.push(`(${opts.extra.sql})`); binds.push(...opts.extra.binds); }
    const rows = await runOn(
      env, seg.t,
      `SELECT ${opts.select} FROM ${opts.table} WHERE ${conds.join(" AND ")} ORDER BY ${opts.cursorCol} DESC LIMIT ?`,
      [...binds, opts.limit - out.length],
    );
    if (!rows.length) { cursor = seg.lo; continue; }
    out.push(...rows);
    const last = Number((rows[rows.length - 1] as Record<string, unknown>)[opts.cursorCol]);
    if (!Number.isFinite(last) || last <= seg.lo) { cursor = seg.lo - 1; continue; }
    cursor = last;
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

// bound hot reads to the retained window so rows mid-migration (present in
// hot and shard) are never served twice; NULL cursors never migrate, keep them
function hotFloorBound(floorCol: string, floor: number): string {
  return `(${floorCol} > ${floor} OR ${floorCol} IS NULL)`;
}

const countCache = new Map<string, { at: number; n: number }>();

/** COUNT(*) over hot + all sealed shards (60s cache). */
export async function countRaw(
  env: Env,
  opts: { table: string; extra?: { sql: string; binds: unknown[] }; floorCol?: string },
): Promise<number> {
  const shards = await getShards(env);
  const floor = hotFloor(shards);
  const where = opts.extra ? `WHERE ${opts.extra.sql}` : "";
  const key = `${opts.table}|${where}|${(opts.extra?.binds ?? []).join(",")}|${floor}`;
  const hit = countCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.n;
  const results = await Promise.all(allTargets(shards).map(async (t) => {
    let w = where;
    const binds = [...(opts.extra?.binds ?? [])];
    if (t.kind === "hot" && floor >= 0 && opts.floorCol) {
      w = where ? `${where} AND ${hotFloorBound(opts.floorCol, floor)}` : `WHERE ${hotFloorBound(opts.floorCol, floor)}`;
    }
    const rows = await runOn(env, t, `SELECT COUNT(*) AS n FROM ${opts.table} ${w}`, binds);
    return Number(rows[0]?.n ?? 0);
  }));
  const n = results.reduce((a, b) => a + b, 0);
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
    return runOn(env, t, `SELECT ${opts.select} FROM ${opts.table} ${w} ORDER BY ${opts.order} LIMIT ${fetch}`, binds);
  }));
  const merged = per.flat();
  merged.sort(cmpBy(opts.order));
  return merged.slice(skip, need);
}

/**
 * Run an additive aggregate (SUMs/COUNTs + optional MIN/MAX cols) on every
 * target and merge the results. Use SUM instead of AVG in the SQL; averages
 * are computed by the caller from sum/count pairs.
 */
export async function mergeAgg(
  env: Env,
  sql: string,
  binds: unknown[],
  opts: { sum: string[]; min?: string | string[]; max?: string | string[] },
): Promise<Record<string, number>> {
  const shards = await getShards(env);
  const rows = await Promise.all(allTargets(shards).map((t) => runOn(env, t, sql, binds)));
  const out: Record<string, number> = {};
  for (const col of opts.sum) out[col] = 0;
  const one = (c: string | string[] | undefined): string[] => (c == null ? [] : typeof c === "string" ? [c] : c);
  const mins = one(opts.min);
  const maxs = one(opts.max);
  for (const rowsOne of rows) {
    const r = rowsOne[0];
    if (!r) continue;
    for (const col of opts.sum) {
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
 * GROUP BY over hot + sealed shards with additive value columns, merged by key
 * in JS. Returns unmerged-order rows: [{ [keyCol]: key, ...sums }].
 */
export async function mergeGroups(
  env: Env,
  sql: string,
  binds: unknown[],
  keyCol: string,
  sumCols: string[],
): Promise<Row[]> {
  const shards = await getShards(env);
  const rows = await Promise.all(allTargets(shards).map((t) => runOn(env, t, sql, binds)));
  const byKey = new Map<string, Row>();
  for (const rs of rows) {
    for (const r of rs) {
      const key = String(r[keyCol] ?? "");
      const acc = byKey.get(key);
      if (!acc) {
        const fresh: Row = { [keyCol]: r[keyCol] };
        for (const c of sumCols) fresh[c] = Number(r[c] ?? 0);
        byKey.set(key, fresh);
      } else {
        for (const c of sumCols) acc[c] = Number(acc[c] ?? 0) + Number(r[c] ?? 0);
      }
    }
  }
  return [...byKey.values()];
}

// ---------- rotation ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqlVal(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "bigint") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function insertLiteral(table: string, rows: Row[]): string {
  const cols = SHARD_TABLES[table];
  const values = rows.map((r) => `(${cols.map((c) => sqlVal(r[c])).join(",")})`);
  return `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES ${values.join(",")}`;
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

const COPY_BATCH = 200;
// keep this many recent topoheights in the hot DB window
const KEEP_HOT_BLOCKS = 200_000;

/**
 * Size-triggered rotation, run hourly. Creates a shard DB when the hot DB
 * crosses SHARD_MAX_BYTES, then incrementally copies (and deletes) old raw
 * rows into it within a per-run budget. Idempotent and resumable via
 * sync_state stage 'shard_out'.
 */
export async function rotateShards(env: Env, budgetMs = 25_000): Promise<string> {
  if (!shardsConfigured(env)) return "disabled";
  let shards = await getShards(env, true);
  let open = shards.find((s) => !s.sealed && s.last_topo != null);

  if (!open) {
    const bytes = await hotFileBytes(env);
    if (bytes == null || bytes < maxBytes(env)) return `ok (${bytes ?? "?"} bytes)`;
    const b = await env.DB.prepare("SELECT MIN(topoheight) AS mn, MAX(topoheight) AS mx FROM blocks").first<{ mn: number | null; mx: number | null }>();
    const maxTopo = Number(b?.mx ?? 0);
    const minTopo = Number(b?.mn ?? 0);
    const cut = maxTopo - KEEP_HOT_BLOCKS;
    if (!maxTopo || cut <= minTopo) return "ok (nothing to cut yet)";
    const name = `xelis-stats-shard-${shards.length + 1}`;
    const dbId = await createShardDatabase(env, name);
    if (!dbId) throw new Error("shard create: no uuid returned");
    await initShardSchema(env, dbId);
    await env.DB.prepare(
      "INSERT INTO shards (name, db_id, first_topo, last_topo, copied_topo, sealed, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)"
    ).bind(name, dbId, minTopo, cut, Date.now()).run();
    invalidate();
    shards = await getShards(env, true);
    open = shards.find((s) => !s.sealed);
    if (!open) return "created shard, retry next run";
  }

  const target = open.last_topo!;
  const started = Date.now();
  let cursor = open.copied_topo >= open.first_topo ? open.copied_topo : open.first_topo - 1;
  let copied = 0;

  while (cursor < target && Date.now() - started < budgetMs) {
    const prev = cursor;
    // 1) copy block batch into the shard
    const blocks = await env.DB.prepare(
      "SELECT * FROM blocks WHERE topoheight > ? AND topoheight <= ? ORDER BY topoheight LIMIT ?"
    ).bind(cursor, target, COPY_BATCH).all<Row>();
    const blockRows = blocks.results ?? [];
    if (blockRows.length) {
      await restQuery(env, open.db_id, insertLiteral("blocks", blockRows));
      copied += blockRows.length;
      cursor = Number(blockRows[blockRows.length - 1].topoheight);
    } else {
      cursor = target;
    }

    // 2) copy dependent tx rows for the same topo slice
    if (cursor > prev) {
      const txs = await env.DB.prepare(
        "SELECT * FROM tx_index WHERE block_topo > ? AND block_topo <= ?"
      ).bind(prev, cursor).all<Row>();
      const txRows = txs.results ?? [];
      if (txRows.length) {
        const hashes = txRows.map((r) => String(r.hash));
        await restQuery(env, open.db_id, insertLiteral("tx_index", txRows));
        copied += txRows.length;
        for (const [table, keyCol] of [["tx_assets", "tx_hash"], ["tx_contracts", "tx_hash"]] as const) {
          const rows = await env.DB.prepare(
            `SELECT * FROM ${table} WHERE ${keyCol} IN (${hashes.map(() => "?").join(",")})`
          ).bind(...hashes).all<Row>();
          if (rows.results?.length) {
            await restQuery(env, open.db_id, insertLiteral(table, rows.results));
            copied += rows.results.length;
          }
        }
      }
      // 3) delete the copied slice from hot only after the shard write succeeded
      await env.DB.batch([
        env.DB.prepare("DELETE FROM blocks WHERE topoheight > ? AND topoheight <= ?").bind(prev, cursor),
        env.DB.prepare("DELETE FROM tx_index WHERE block_topo > ? AND block_topo <= ?").bind(prev, cursor),
      ]);
      await setCursor(env, "shard_out", cursor);
      await env.DB.prepare("UPDATE shards SET copied_topo = ? WHERE id = ?").bind(cursor, open.id).run();
    }
  }

  // 4) seal when the whole range has been migrated
  if (cursor >= target) {
    const bounds = await restQuery(env, open.db_id, "SELECT MIN(ts) AS f, MAX(ts) AS l FROM blocks").then((r) => r[0] ?? null);
    await env.DB.prepare(
      "UPDATE shards SET sealed = 1, copied_topo = ?, first_ts = ?, last_ts = ? WHERE id = ?"
    ).bind(target, bounds ? Number(bounds.f ?? 0) : null, bounds ? Number(bounds.l ?? 0) : null, open.id).run();
    invalidate();
    return `sealed shard ${open.name} (${open.first_topo}..${target})`;
  }
  return `copied ${copied} rows, cursor ${cursor}/${target}`;
}
