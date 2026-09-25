/**
 * Export local backfill SQLite → D1 SQL + R2-ready archives.
 *
 * D1:
 *   - daily_stats, daily_miners, daily_block_types (aggregates, full history)
 *   - accounts (full)
 *   - blocks: full history (keyset-paginated browsing)
 *   - tx_index: full history
 * R2 (full raw history):
 *   - blocks-full.jsonl / txs-full.jsonl chunks (100k rows each)
 *
 * Restartable: each output file is rewritten independently; use --only to
 * regenerate specific files (comma-separated, e.g. --only tx,daily_stats).
 *
 * Usage: node --experimental-strip-types scripts/export.mts [--full] [--only=a,b]
 * Env:   BACKFILL_DB, EXPORT_DIR
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = process.env.BACKFILL_DB ?? "data/backfill.db";
const OUT_DIR = process.env.EXPORT_DIR ?? "export";
const FULL = process.argv.includes("--full");
const onlyRaw: string = (process.argv.find((a: string) => a.startsWith("--only=")) ?? "").split("=")[1] ?? "";
const ONLY: string[] = onlyRaw.split(",").filter((x) => x.length > 0);

if (!existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH} — run backfill first.`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const wanted = (name: string): boolean => !ONLY.length || ONLY.includes(name);

/** Remove a previous partial output so appends never duplicate rows. */
function fresh(file: string): void {
  try { unlinkSync(file); } catch { /* not there */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function esc(v: any): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "bigint") return String(v);
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** Keyset-paginated dump by integer key column (fast, no OFFSET). desc=true walks from the top. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dumpKeyset(table: string, keyCol: string, cols: string[], opts: { limit?: number; outFile?: string; chunkRows?: number; desc?: boolean; tieCol?: string; includeNull?: boolean }): number {
  const limit = opts.limit ?? Infinity;
  const file = opts.outFile ?? join(OUT_DIR, `${table}.sql`);
  fresh(file);
  const chunkRows = opts.chunkRows ?? 100_000;
  const desc = opts.desc ?? false;
  const dir = desc ? "DESC" : "ASC";
  const op = desc ? "<" : ">";
  // non-unique key columns (e.g. tx_index.block_topo) need a unique tie-breaker,
  // otherwise rows sharing the boundary key are skipped between pages
  const where = opts.tieCol
    ? `(${keyCol} ${op} ? OR (${keyCol} = ? AND ${opts.tieCol} ${op} ?))`
    : `${keyCol} ${op} ?`;
  const order = opts.tieCol ? `${keyCol} ${dir}, ${opts.tieCol} ${dir}` : `${keyCol} ${dir}`;
  let count = 0;
  let lastKey = desc ? Number.MAX_SAFE_INTEGER : -1;
  let lastTie = desc ? "\uffff" : "";
  let buffer: string[] = [];

  for (;;) {
    if (count >= limit) break;
    const pageSize = Math.min(chunkRows, limit - count);
    const stmt = db.prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`);
    stmt.setReadBigInts(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = opts.tieCol ? stmt.all(lastKey, lastKey, lastTie, pageSize) : stmt.all(lastKey, pageSize);
    if (!rows.length) break;
    for (const row of rows) {
      const vals = cols.map((c) => esc(row[c]));
      buffer.push(`(${vals.join(",")})`);
      count++;
    }
    // multi-row INSERT: fewer, larger statements for fast D1 import
    for (let i = 0; i < buffer.length; i += 100) {
      writeFileSync(file, `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES\n${buffer.slice(i, i + 100).join(",\n")};\n`, { flag: "a" });
    }
    buffer = [];
    const last = rows[rows.length - 1];
    lastKey = Number(last[keyCol]);
    if (opts.tieCol) lastTie = String(last[opts.tieCol]);
  }

  // rows whose key is NULL (e.g. txs whose executed block was pruned/orphaned)
  // can't be reached by the integer keyset; append them after the main pass
  if (opts.includeNull) {
    const stmt = db.prepare(`SELECT ${cols.join(", ")} FROM ${table} WHERE ${keyCol} IS NULL ORDER BY ${cols[0]} ${dir}`);
    stmt.setReadBigInts(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = stmt.all();
    const nullBuf = rows.map((row) => `(${cols.map((c) => esc(row[c])).join(",")})`);
    for (let i = 0; i < nullBuf.length; i += 100) {
      writeFileSync(file, `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES\n${nullBuf.slice(i, i + 100).join(",\n")};\n`, { flag: "a" });
    }
    count += rows.length;
  }
return count;
}

/** Keyset-paginated dump by a TEXT key column (e.g. hashes). Optionally uses a
 *  second column to break ties, since the value columns of join tables do not
 *  carry a numeric cursor. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dumpKeysetText(table: string, keyCol: string, cols: string[], opts: { outFile: string; chunkRows?: number; tieCol?: string }): number {
  const chunkRows = opts.chunkRows ?? 100_000;
  const tieCol = opts.tieCol;
  fresh(opts.outFile);
  const where = tieCol
    ? `(${keyCol} > ? OR (${keyCol} = ? AND ${tieCol} > ?))`
    : `${keyCol} > ?`;
  const order = tieCol ? `${keyCol} ASC, ${tieCol} ASC` : `${keyCol} ASC`;
  let count = 0;
  let lastKey = "";
  let lastTie = "";
  const buffer: string[] = [];

  for (;;) {
    const stmt = db.prepare(`SELECT DISTINCT ${cols.join(", ")} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`);
    stmt.setReadBigInts(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = tieCol ? stmt.all(lastKey, lastKey, lastTie, chunkRows) : stmt.all(lastKey, chunkRows);
    if (!rows.length) break;
    for (const row of rows) {
      buffer.push(`(${cols.map((c) => esc(row[c])).join(",")})`);
      count++;
    }
    for (let i = 0; i < buffer.length; i += 100) {
      writeFileSync(opts.outFile, `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES\n${buffer.slice(i, i + 100).join(",\n")};\n`, { flag: "a" });
    }
    buffer.length = 0;
    const last = rows[rows.length - 1];
    lastKey = String(last[keyCol]);
    if (tieCol) lastTie = String(last[tieCol]);
  }
  return count;
}

/** JSONL dump (for R2 raw archive). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dumpJsonl(table: string, keyCol: string, chunkRows: number, dir: string): number {
  let count = 0;
  let lastKey = -1;
  let chunkIndex = 0;
  let buffer: string[] = [];
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  for (;;) {
    const stmt = db.prepare(`SELECT * FROM ${table} WHERE ${keyCol} > ? ORDER BY ${keyCol} LIMIT ?`);
    stmt.setReadBigInts(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = stmt.all(lastKey, chunkRows);
    if (!rows.length) break;
    for (const row of rows) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const obj: any = {};
      for (const c of cols) obj[c] = typeof row[c] === "bigint" ? String(row[c]) : row[c];
      buffer.push(JSON.stringify(obj));
      count++;
    }
    lastKey = Number(rows[rows.length - 1][keyCol]);
    if (buffer.length >= chunkRows) {
      const f = join(dir, `${table}-${String(chunkIndex).padStart(4, "0")}.jsonl`);
      fresh(f);
      writeFileSync(f, buffer.join("\n") + "\n");
      buffer = [];
      chunkIndex++;
    }
  }
  if (buffer.length) {
    const f = join(dir, `${table}-${String(chunkIndex).padStart(4, "0")}.jsonl`);
    fresh(f);
    writeFileSync(f, buffer.join("\n") + "\n");
  }
  return count;
}

// ---------- aggregates (small, D1) ----------

console.log("Exporting aggregates (D1)…");
const AGG_JOBS: Array<[string, string, string[], string]> = [
  ["daily_stats", "daily_stats", ["date", "active_accounts", "new_accounts", "tx_count", "avg_fee", "hashrate", "unique_miners", "side_count", "miner_revenue", "fee_total_sum", "fees_vs_rewards_pct", "emitted_supply", "burned_supply", "circulating_supply"],
    `WITH per_day AS (
      SELECT date(ts/1000,'unixepoch') AS date, COUNT(*) blocks_found,
             AVG(difficulty)/5.0 hashrate_raw, COUNT(DISTINCT miner_address) unique_miners,
             SUM(tx_count) tx_count, SUM(CASE WHEN LOWER(block_type) = 'side' THEN 1 ELSE 0 END) side_count,
             SUM(fee_total) fee_total_sum, SUM(miner_reward+dev_reward) rewards_sum,
             SUM(burned) block_burned
      FROM blocks GROUP BY 1),
     tx_day AS (
      SELECT date(ts/1000,'unixepoch') AS date, COUNT(*) txs, AVG(fee) avg_fee,
             COUNT(DISTINCT sender) active_accounts
      FROM tx_index GROUP BY 1),
     acct_day AS (
      SELECT date(first_seen/1000,'unixepoch') AS date, COUNT(*) new_accounts FROM accounts GROUP BY 1),
     combined AS (
      SELECT p.date, a.active_accounts, n.new_accounts, p.tx_count, a.avg_fee, p.hashrate_raw hashrate,
             p.unique_miners, p.side_count, p.rewards_sum miner_revenue, p.fee_total_sum, p.block_burned,
             CASE WHEN p.rewards_sum > 0 THEN (a.avg_fee * a.txs * 100.0 / p.rewards_sum) ELSE NULL END fees_vs_rewards_pct
      FROM per_day p LEFT JOIN tx_day a USING(date) LEFT JOIN acct_day n USING(date)),
     cumulative AS (
      SELECT date, active_accounts, new_accounts, tx_count, avg_fee, hashrate, unique_miners,
             side_count, miner_revenue, fee_total_sum, fees_vs_rewards_pct,
             SUM(miner_revenue) OVER (ORDER BY date) emitted_supply,
             SUM(COALESCE(block_burned, 0)) OVER (ORDER BY date) burned_supply
      FROM combined)
     SELECT date, active_accounts, new_accounts, tx_count, avg_fee, hashrate, unique_miners,
            side_count, miner_revenue, fee_total_sum, fees_vs_rewards_pct,
            emitted_supply, burned_supply,
            emitted_supply - burned_supply AS circulating_supply
     FROM cumulative ORDER BY date`],
  ["daily_miners", "daily_miners", ["date", "address", "blocks_found", "rewards_earned", "side_count", "sync_count"],
    `SELECT date(ts/1000,'unixepoch') date, miner_address address, COUNT(*) blocks_found,
            SUM(miner_reward) rewards_earned,
            SUM(CASE WHEN LOWER(block_type) = 'side' THEN 1 ELSE 0 END) side_count,
            SUM(CASE WHEN LOWER(block_type) = 'sync' THEN 1 ELSE 0 END) sync_count
     FROM blocks WHERE miner_address != '' GROUP BY 1,2 ORDER BY 1`],
  ["daily_block_types", "daily_block_types", ["date", "block_type", "count"],
    `SELECT date(ts/1000,'unixepoch') date, block_type, COUNT(*) count FROM blocks GROUP BY 1,2 ORDER BY 1`],
  ["accounts", "accounts", ["address", "first_seen", "last_active", "tx_count"],
    `SELECT address, first_seen, last_active, tx_count FROM accounts ORDER BY first_seen`],
  ["daily_address_stats", "daily_address_stats", ["date", "address", "tx_count", "transfer_outputs"],
    `SELECT date(ts/1000,'unixepoch') date, sender address, COUNT(*) tx_count,
            SUM(transfer_count) transfer_outputs
     FROM tx_index GROUP BY 1,2 ORDER BY 1`],
  ["daily_assets", "daily_assets", ["date", "asset_id", "tx_count", "transfer_count"],
    `SELECT date(i.ts/1000,'unixepoch') date, ta.asset asset_id,
            COUNT(DISTINCT ta.tx_hash) tx_count, SUM(i.transfer_count) transfer_count
     FROM tx_assets ta JOIN tx_index i ON i.hash = ta.tx_hash GROUP BY 1,2 ORDER BY 1`],
  ["assets", "assets", ["asset_id", "name", "symbol", "decimals", "first_seen_topo"],
    `SELECT asset_id, name, symbol, decimals, first_seen_topo FROM assets ORDER BY first_seen_topo`],
  // contract registry: deploy facts from scripts/contracts.mts / tx pass;
// invoke+gas totals derived from indexed tx history so they always match
  ["contracts", "contracts", ["contract_id", "deployer", "deploy_topo", "invoke_count", "gas_total", "events_count"],
    `SELECT c.contract_id, c.deployer, c.deploy_topo,
            COALESCE(i.invokes, 0) invoke_count, COALESCE(i.gas, 0) gas_total, c.events_count
     FROM contracts c
     LEFT JOIN (
       SELECT contract_id, COUNT(*) invokes, SUM(gas) gas
       FROM tx_index WHERE tx_type = 'invoke_contract' AND contract_id IS NOT NULL AND contract_id != ''
       GROUP BY 1
     ) i ON i.contract_id = c.contract_id
     ORDER BY c.contract_id`],
  ["daily_contracts", "daily_contracts", ["date", "contract_id", "invoke_count", "gas_burned", "deploys"],
    `SELECT date(ts/1000,'unixepoch') date, contract_id,
            SUM(CASE WHEN tx_type = 'invoke_contract' THEN 1 ELSE 0 END) invoke_count,
            SUM(CASE WHEN tx_type = 'invoke_contract' THEN gas ELSE 0 END) gas_burned,
            SUM(CASE WHEN tx_type = 'deploy_contract' THEN 1 ELSE 0 END) deploys
     FROM tx_index WHERE contract_id IS NOT NULL AND contract_id != '' GROUP BY 1, 2 ORDER BY 1`],
];

for (const [file, table, cols, sql] of AGG_JOBS) {
  if (!wanted(file)) { console.log(`  ${table}: skipped (--only)`); continue; }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = stmt.all();
  const outFile = join(OUT_DIR, `${file}.sql`);
  fresh(outFile);
  const buffer: string[] = [];
  for (const row of rows) {
    const vals = cols.map((c) => esc(row[c]));
    buffer.push(`(${vals.join(",")})`);
  }
  // multi-row INSERT: batch 100 rows per statement for fast D1 import
  for (let i = 0; i < buffer.length; i += 100) {
    writeFileSync(outFile, `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES\n${buffer.slice(i, i + 100).join(",\n")};\n`, { flag: "a" });
  }
  console.log(`  ${table}: ${rows.length.toLocaleString()} rows${existsSync(outFile) ? ` (${(statSync(outFile).size / 1e6).toFixed(1)} MB)` : " (empty — file not written)"}`);
}

// ---------- chain data (D1) ----------

console.log("Exporting chain data (D1): all blocks, all txs, tx↔asset and tx↔contract links…");
if (wanted("blocks")) {
  const nBlocks = dumpKeyset("blocks", "topoheight",
    ["topoheight", "height", "hash", "ts", "version", "nonce", "difficulty", "size", "tx_count", "block_type", "miner_address", "miner_reward", "dev_reward", "burned", "fee_total", "cum_difficulty", "tips"],
    { outFile: join(OUT_DIR, "blocks.sql"), desc: true });
  console.log(`  blocks: ${nBlocks.toLocaleString()} rows (${(statSync(join(OUT_DIR, "blocks.sql")).size / 1e6).toFixed(1)} MB)`);
} else {
  console.log("  blocks: skipped (--only)");
}

if (wanted("tx")) {
  const nTxs = dumpKeyset("tx_index", "block_topo",
    ["hash", "block_topo", "ts", "fee", "size", "tx_type", "sender", "transfer_count", "version", "multisig", "contract_id", "gas", "executed", "encrypted", "burn_amount", "burn_asset"],
    { outFile: join(OUT_DIR, "tx.sql"), chunkRows: 100_000, tieCol: "hash", includeNull: true });
  console.log(`  tx: ${nTxs.toLocaleString()} rows`);
} else {
  console.log("  tx: skipped (--only)");
}

// join tables: without these the asset/contract detail pages have no tx links
// (tx_assets is keyed by hash+asset, tx_contracts by hash)
if (wanted("tx_assets")) {
  const n = dumpKeysetText("tx_assets", "tx_hash", ["tx_hash", "asset"],
    { outFile: join(OUT_DIR, "tx_assets.sql"), chunkRows: 100_000, tieCol: "asset" });
  console.log(`  tx_assets: ${n.toLocaleString()} rows`);
} else {
  console.log("  tx_assets: skipped (--only)");
}

if (wanted("tx_contracts")) {
  const n = dumpKeysetText("tx_contracts", "tx_hash", ["tx_hash", "contract_id", "max_gas"],
    { outFile: join(OUT_DIR, "tx_contracts.sql"), chunkRows: 100_000 });
  console.log(`  tx_contracts: ${n.toLocaleString()} rows`);
} else {
  console.log("  tx_contracts: skipped (--only)");
}

// ---------- full raw archives (R2) ----------

if (FULL) {
  console.log("Exporting full raw archives (R2 JSONL)…");
  const r2dir = join(OUT_DIR, "r2");
  mkdirSync(r2dir, { recursive: true });
  const nb = dumpJsonl("blocks", "topoheight", 100_000, r2dir);
  console.log(`  blocks jsonl: ${nb.toLocaleString()} rows in ${r2dir}`);
  const nt = dumpJsonl("tx_index", "block_topo", 100_000, r2dir);
  console.log(`  txs jsonl: ${nt.toLocaleString()} rows`);
}

console.log(`
Done. Import to D1 (in order):
npx wrangler d1 execute xelis-stats --file export/daily_stats.sql --remote
  npx wrangler d1 execute xelis-stats --file export/daily_miners.sql --remote
  npx wrangler d1 execute xelis-stats --file export/daily_block_types.sql --remote
  npx wrangler d1 execute xelis-stats --file export/daily_address_stats.sql --remote
  npx wrangler d1 execute xelis-stats --file export/daily_assets.sql --remote
  npx wrangler d1 execute xelis-stats --file export/accounts.sql --remote
  npx wrangler d1 execute xelis-stats --file export/assets.sql --remote
  npx wrangler d1 execute xelis-stats --file export/contracts.sql --remote
  npx wrangler d1 execute xelis-stats --file export/daily_contracts.sql --remote
  npx wrangler d1 execute xelis-stats --file export/blocks.sql --remote
  npx wrangler d1 execute xelis-stats --file export/tx.sql --remote
  npx wrangler d1 execute xelis-stats --file export/tx_assets.sql --remote
  npx wrangler d1 execute xelis-stats --file export/tx_contracts.sql --remote
Then seed cursor: sync_state.last_backfill_topoheight = (max stable at export time).
${FULL ? "R2: upload export/r2/*.jsonl with wrangler r2 object put." : "(re-run with --full for R2 raw archives)"}`);


