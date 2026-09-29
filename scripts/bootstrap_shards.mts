/**
 * Bootstrap a sharded D1 layout from a local SQLite that is already above D1's
 * 10 GB per-database hardcap.
 *
 * `rotateShards` (src/server/shards.ts) can only move raw rows that are already
 * inside the hot DB, so it cannot seed a fresh remote from an oversized local
 * file. This script lays history out across databases from the start:
 *
 *   - sealed shard DBs hold old raw ranges (blocks/tx_index/tx_assets/tx_contracts)
 *   - the hot DB holds aggregates plus the recent window (topo > last range)
 *   - the hot `shards` registry rows are inserted so the router serves them
 *   - `shard_prune`/`shard_assets_<id>` cursors are pre-seeded because the hot
 *     DB never held those ranges, so there is nothing to prune or sweep
 *
 * Each range is exported by scripts/export.mts (--lo/--hi) and loaded by
 * scripts/import_d1.mts (--db/--out), so the split/import logic stays in one
 * place.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bootstrap_shards.mts \
 *     --ranges=0-3000000,3000001-6000000,6000001-8000000 \
 *     --remote [--hot=xelis-explorer] [--out=export] [--cursor=N] [--dry-run]
 *
 * --ranges is an ordered, contiguous, inclusive list of topoheight ranges, one
 * sealed shard each; the hot window is everything above the last range. Shard
 * databases are created (via `wrangler d1 create`) unless they already exist.
 */
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { SHARD_SCHEMA } from "../src/server/shards.ts";
import { localD1Path } from "./local_d1.mts";

const has = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | undefined =>
  process.argv.find((a: string) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const REMOTE = has("remote");
const DRY = has("dry-run");
const SKIP_CREATE = has("skip-create");
const SKIP_SCHEMA = has("skip-schema");
const TARGET = REMOTE ? "--remote" : "--local";
const HOT_NAME = arg("hot") ?? process.env.D1_NAME ?? "xelis-explorer";
const OUT_BASE = arg("out") ?? process.env.EXPORT_DIR ?? "export";

/** Ordered sealed-shard topo ranges, inclusive. */
interface Range { lo: number; hi: number; }

// Resolved before any local shard DB is created, and pinned into child exports
// via BACKFILL_DB so they always read the hot file.
const DB_PATH = process.env.BACKFILL_DB ?? localD1Path() ?? "data/backfill.db";

function parseRanges(raw: string): Range[] {
  const out: Range[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (!m) throw new Error(`bad range '${part}' (expected first-last)`);
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (!(lo <= hi)) throw new Error(`range '${part}': first > last`);
    out.push({ lo, hi });
  }
  if (!out.length) throw new Error("--ranges is required (e.g. --ranges=0-3000000,3000001-6000000)");
  out.sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < out.length; i++) {
    if (out[i].lo !== out[i - 1].hi + 1) {
      throw new Error(`ranges must be contiguous: ${out[i - 1].lo}-${out[i - 1].hi} then ${out[i].lo}-${out[i].hi}`);
    }
  }
  return out;
}

/** Synchronous sleep (Node has no blocking sleep). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const EXEC_RETRIES = 3;
// Invoke wrangler's bin through node instead of `npx` + shell: SQL passed via
// --command contains parentheses/commas that cmd.exe would mangle, and file
// paths may contain spaces.
const WRANGLER_BIN = join("node_modules", "wrangler", "bin", "wrangler.js");

function run(args: string[], capture = false): string {
  if (DRY && args[0] === "d1" && (args[1] === "create" || args[1] === "execute")) {
    console.log(`  [dry-run] wrangler ${args.join(" ")}`);
    return "";
  }
  // `d1 execute --file` goes through D1's import path, which can return a
  // transient D1_RESET_DO while it resets the backing Durable Object (the CLI
  // itself says the operation is safe to retry). The statements here are
  // idempotent (IF NOT EXISTS / INSERT OR REPLACE), so retry with backoff.
  const attempts = args[0] === "d1" && args[1] === "execute" ? EXEC_RETRIES : 1;
  let last = "";
  for (let i = 0; i < attempts; i++) {
    const res = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (res.error) throw res.error;
    const out = typeof res.stdout === "string" ? res.stdout : "";
    const err = typeof res.stderr === "string" ? res.stderr : "";
    if (!capture) { if (out) process.stdout.write(out); if (err) process.stderr.write(err); }
    if (res.status === 0) return out;
    last = `${out}\n${err}`;
    if (i < attempts - 1 && /D1_RESET_DO|D1 reset before execute/.test(last)) {
      console.log(`  transient D1 error; retrying (${i + 2}/${attempts})…`);
      sleepSync(5_000 * (i + 1));
      continue;
    }
    break;
  }
  throw new Error(`wrangler ${args.join(" ")} failed\n${last.trim()}`);
}

/** Run a child node script (export/import) in this repo, pinned to the hot DB. */
function runNode(script: string, args: string[]): void {
  const full = join("scripts", script);
  if (DRY) { console.log(`  [dry-run] node --experimental-strip-types ${full} ${args.join(" ")}`); return; }
  const res = spawnSync(process.execPath, ["--experimental-strip-types", full, ...args], {
    stdio: "inherit",
    // creating local shard DBs adds more *.sqlite files next to the hot one, so
    // tell the children exactly which source DB to read
    env: { ...process.env, BACKFILL_DB: DB_PATH },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${full} failed (exit ${res.status})`);
}

interface DbInfo { uuid: string; name: string; }

/** `wrangler d1 list --json`, tolerating npm banner lines around the JSON. */
function listDbs(): DbInfo[] {
  let raw = "";
  try {
    raw = run(["d1", "list", "--json"], true);
  } catch {
    return [];
  }
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(raw.slice(start, end + 1)) as Array<Record<string, unknown>>;
    return arr.map((d) => ({ uuid: String(d.uuid ?? ""), name: String(d.name ?? "") })).filter((d) => d.uuid && d.name);
  } catch {
    return [];
  }
}

function findDb(name: string): DbInfo | undefined {
  return listDbs().find((d) => d.name === name);
}

function createDb(name: string): DbInfo {
  const out = run(["d1", "create", name], true);
  const m = /database_id\s*=\s*"([0-9a-fA-F-]+)"/.exec(out);
  if (m) return { uuid: m[1], name };
  const found = findDb(name);
  if (found) return found;
  throw new Error(`created ${name} but could not resolve its uuid; check \`wrangler d1 list\``);
}

/** Resolve or create a database by name and return its info. */
function ensureDb(name: string): DbInfo {
  const existing = findDb(name);
  if (existing) {
    console.log(`  ${name}: exists (${existing.uuid})`);
    return existing;
  }
  if (DRY) {
    console.log(`  [dry-run] would create ${name}`);
    return { uuid: "<uuid>", name };
  }
  console.log(`  ${name}: creating…`);
  const db = createDb(name);
  console.log(`  ${name}: created (${db.uuid})`);
  return db;
}

/** Apply SHARD_SCHEMA to a shard database via a temp .sql file. */
function applyShardSchema(name: string): void {
  if (SKIP_SCHEMA) return;
  if (DRY) { console.log(`  [dry-run] apply SHARD_SCHEMA to ${name}`); return; }
  const file = join(tmpdir(), `shard-schema-${Date.now().toString(36)}.sql`);
  writeFileSync(file, SHARD_SCHEMA.join(";\n") + ";\n");
  try {
    run(["d1", "execute", name, "--file", file, TARGET, "--yes"]);
  } finally {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

/** Execute one SQL statement against a database via a temp file (safe quoting). */
function execSql(name: string, sql: string): void {
  if (DRY) { console.log(`  [dry-run] execute against ${name}:\n${sql}`); return; }
  const file = join(tmpdir(), `shard-exec-${Date.now().toString(36)}.sql`);
  writeFileSync(file, sql);
  try {
    run(["d1", "execute", name, "--file", file, TARGET, "--yes"]);
  } finally {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
}

function localDb(): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: true });
}

function localMaxTopo(): number | undefined {
  try {
    const db = localDb();
    try {
      const r = db.prepare("SELECT MAX(topoheight) AS m FROM blocks").get() as { m: number | null };
      return r?.m ?? undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

function localTopTimes(lo: number, hi: number): { first: number | null; last: number | null } {
  try {
    const db = localDb();
    try {
      const r = db.prepare("SELECT MIN(ts) AS f, MAX(ts) AS l FROM blocks WHERE topoheight >= ? AND topoheight <= ?")
        .get(lo, hi) as { f: number | null; l: number | null };
      return { first: r?.f ?? null, last: r?.l ?? null };
    } finally { db.close(); }
  } catch { return { first: null, last: null }; }
}

/** [min,max] topoheight already present in a shard DB, or nulls when the shard
 *  has no blocks table yet / is unreachable. Index-backed, so it is cheap even
 *  on a multi-GB shard. */
function remoteBlockBounds(name: string): { mn: number | null; mx: number | null } {
  try {
    const out = run(["d1", "execute", name, "--command",
      "SELECT MIN(topoheight) AS mn, MAX(topoheight) AS mx FROM blocks",
      TARGET, "--yes", "--json"], true);
    const start = out.indexOf("[");
    const end = out.lastIndexOf("]");
    if (start < 0 || end < start) return { mn: null, mx: null };
    const arr = JSON.parse(out.slice(start, end + 1)) as Array<{ results?: Array<{ mn: number | null; mx: number | null }> }>;
    const row = arr[0]?.results?.[0];
    return { mn: row?.mn ?? null, mx: row?.mx ?? null };
  } catch {
    return { mn: null, mx: null };
  }
}

// ---------- plan ----------

const rangesArg = arg("ranges") ?? "";
if (!rangesArg) {
  console.error("Usage: bootstrap_shards.mts --ranges=0-2999999,3000000-5999999 --remote [--hot=NAME] [--out=DIR] [--cursor=N] [--dry-run]");
  process.exit(1);
}
if (!REMOTE && !DRY) {
  // the app reaches shards by uuid through the Cloudflare REST API, so Miniflare
  // (local) shard objects cannot be routed; shards must be real remote D1 DBs
  console.error("bootstrap_shards requires --remote: local Miniflare shards are not reachable by the running Worker.");
  process.exit(1);
}
if (!existsSync(DB_PATH)) {
  console.error(`No source database at ${DB_PATH} — start the local D1 (npm run dev) or set BACKFILL_DB.`);
  process.exit(1);
}
const ranges = parseRanges(rangesArg);
const hotFrom = ranges[ranges.length - 1].hi + 1;

console.log(`Bootstrap ${REMOTE ? "remote" : "local"} D1 from ${DB_PATH}`);
console.log(`  hot DB: ${HOT_NAME} (window topo >= ${hotFrom})`);
ranges.forEach((r, i) => console.log(`  shard ${i + 1}: ${r.lo}..${r.hi}`));

if (!DRY) {
  // the hot DB must already exist and have the schema (shards/sync_state are
  // written before the hot import runs)
  const hot = findDb(HOT_NAME);
  if (!hot) {
    console.error(`Hot database '${HOT_NAME}' not found. Create it first:\n  npx wrangler d1 create ${HOT_NAME}`);
    process.exit(1);
  }
  run(["d1", "migrations", "apply", HOT_NAME, TARGET]);
}

const shardRows: Array<Range & { id: number; name: string; uuid: string; first_ts: number | null; last_ts: number | null }> = [];

for (let i = 0; i < ranges.length; i++) {
  const range = ranges[i];
  const id = i + 1;
  const name = `${HOT_NAME}-shard-${id}`;
  console.log(`\nShard ${id} (${range.lo}..${range.hi})`);
  const db = SKIP_CREATE ? (findDb(name) ?? { uuid: "<uuid>", name }) : ensureDb(name);
  applyShardSchema(name);

  const dir = join(OUT_BASE, `shard-${id}`);
  // resumable: if this shard already holds its whole range, don't export/import
  // it again (re-processing multi-GB dumps is slow and idempotent-but-costly)
  const bounds = DRY ? { mn: null, mx: null } : remoteBlockBounds(name);
  const loaded = bounds.mn != null && bounds.mx != null && bounds.mn <= range.lo && bounds.mx >= range.hi;
  if (loaded) {
    console.log(`  already loaded (blocks ${bounds.mn}..${bounds.mx}), skipping export/import`);
  } else {
    console.log(`  exporting range → ${dir}`);
    runNode("export.mts", [`--lo=${range.lo}`, `--hi=${range.hi}`, `--no-aggregates`, `--out=${dir}`]);
    console.log(`  importing into ${name}`);
    // No --only: a range can legitimately have no rows in one of the raw tables
    // (e.g. tx_contracts), and export writes no file for an empty table. Without
    // --only, import_d1 skips absent files instead of failing on them.
    runNode("import_d1.mts", [
      `--db=${name}`, `--out=${dir}`,
      "--no-migrate", "--no-seed",
      REMOTE ? "--remote" : "--local",
    ]);
  }

  const times = DRY ? { first: null, last: null } : localTopTimes(range.lo, range.hi);
  shardRows.push({ ...range, id, name, uuid: db.uuid, first_ts: times.first, last_ts: times.last });
}

// ---------- register shards + pre-seed cursors in the hot DB ----------

const now = Date.now();
const regSql = shardRows.map((s) =>
  `INSERT OR REPLACE INTO shards (id, name, db_id, first_topo, last_topo, copied_topo, first_ts, last_ts, sealed, created_at)\n` +
  `  VALUES (${s.id}, '${s.name}', '${s.uuid}', ${s.lo}, ${s.hi}, ${s.hi}, ${s.first_ts ?? "NULL"}, ${s.last_ts ?? "NULL"}, 1, ${now});`
).join("\n");
// hot never held these ranges, so nothing to prune/sweep: move both cursors to
// the top of the sharded range and let route backfill seed from the shards.
const cursorSql =
  `INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('shard_prune', ${hotFrom - 1}, ${now})\n` +
  `  ON CONFLICT(stage) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at;\n` +
  shardRows.map((s) =>
    `INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('shard_assets_${s.id}', ${s.hi}, ${now})\n` +
    `  ON CONFLICT(stage) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at;`
  ).join("\n");

console.log(`\nRegistering ${shardRows.length} shard(s) in ${HOT_NAME}`);
execSql(HOT_NAME, regSql + "\n" + cursorSql);

// ---------- hot window + aggregates ----------

const hotDir = join(OUT_BASE, "hot");
console.log(`\nHot window (topo >= ${hotFrom})`);
runNode("export.mts", [`--lo=${hotFrom}`, "--include-null", `--out=${hotDir}`]);
const cursor = arg("cursor") !== undefined ? Number(arg("cursor")) : localMaxTopo();
const importArgs = [`--db=${HOT_NAME}`, `--out=${hotDir}`, REMOTE ? "--remote" : "--local"];
if (cursor !== undefined && Number.isFinite(cursor)) importArgs.push(`--cursor=${cursor}`);
runNode("import_d1.mts", importArgs);

console.log(`
Done. Next rotation will cache sealed-shard aggregates; cold hash lookups fan
out across the shards.`);
