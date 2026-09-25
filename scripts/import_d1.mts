/**
 * Import the exported SQL files into D1, in dependency order.
 *
 *   scripts/import_d1.mts [--remote] [--reset] [--only=a,b] [--no-migrate]
 *                         [--no-seed] [--cursor=N] [--dry-run] [--out=export]
 *
 * Default target is the local Miniflare D1 (`.wrangler/state/v3/d1`); pass
 * --remote for the deployed database.
 *
 * --reset wipes the local D1 state first (refused for --remote). Use it after a
 * fresh backfill: the aggregate tables are exported with INSERT OR IGNORE, so a
 * re-import never refreshes aggregate rows already present in an existing DB.
 *
 * Order: schema -> legacy market/chain-size -> daily aggregates -> chain rows.
 * The live collector cursors ('live_blocks'/'live_txs') are then seeded to the
 * backfill top (max topoheight in BACKFILL_DB, or --cursor=N) so `npm run dev`
 * resumes from the tip instead of re-walking history, which would double-count
 * the daily_miners/daily_block_types upserts.
 */
import { existsSync, rmSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const has = (name: string): boolean => process.argv.includes(`--${name}`);
const arg = (name: string): string | undefined =>
  process.argv.find((a: string) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const REMOTE = has("remote");
const RESET = has("reset");
const DRY = has("dry-run");
const NO_MIGRATE = has("no-migrate");
const NO_SEED = has("no-seed");
const ONLY = (arg("only") ?? "").split(",").filter((x) => x.length > 0);
const OUT_DIR = arg("out") ?? process.env.EXPORT_DIR ?? "export";
const DB_PATH = process.env.BACKFILL_DB ?? "data/backfill.db";
const DB_NAME = process.env.D1_NAME ?? "xelis-stats";
const STATE_DIR = ".wrangler/state/v3/d1";
const TARGET = REMOTE ? "--remote" : "--local";

// legacy history first (only meaningful on an empty DB), then export.mts output
// in the same order export.mts prints it
const FILES = [
  "exchanges", "market_snapshots", "chain_size_snapshots",
  "daily_stats", "daily_miners", "daily_block_types", "daily_address_stats",
  "daily_assets", "accounts", "assets", "contracts", "daily_contracts",
  "blocks", "tx", "tx_assets", "tx_contracts",
];

function run(args: string[]): void {
  if (DRY) { console.log(`  [dry-run] npx wrangler ${args.join(" ")}`); return; }
  const res = spawnSync("npx", ["wrangler", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`npx wrangler ${args.join(" ")} failed (exit ${res.status})`);
}

function backfillTop(): number | undefined {
  if (!existsSync(DB_PATH)) return undefined;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const row = db.prepare("SELECT MAX(topoheight) AS topo FROM blocks").get() as { topo: number | null };
      return row?.topo ?? undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

if (RESET) {
  if (REMOTE) {
    console.error("--reset only applies to --local; refusing to touch the remote database.");
    process.exit(1);
  }
  try {
    rmSync(STATE_DIR, { recursive: true, force: true });
    console.log(`Removed local D1 state at ${STATE_DIR} (stop any running dev server first).`);
  } catch (err) {
    console.error(`Could not remove ${STATE_DIR}: ${(err as Error).message}`);
    console.error("Stop `npm run dev` / `npm run preview` and retry.");
    process.exit(1);
  }
}

console.log(`Importing into ${DB_NAME} (${REMOTE ? "remote" : "local"}):`);
if (!NO_MIGRATE) run(["d1", "migrations", "apply", DB_NAME, TARGET]);

const unknown = ONLY.filter((f) => !FILES.includes(f));
if (unknown.length) {
  console.error(`Unknown --only file(s): ${unknown.join(", ")}`);
  process.exit(1);
}
const selected = ONLY.length ? FILES.filter((f) => ONLY.includes(f)) : FILES;

for (const name of selected) {
  const file = join(OUT_DIR, `${name}.sql`);
  if (!existsSync(file)) {
    if (ONLY.length) {
      console.error(`  ${name}: missing ${file}`);
      process.exitCode = 1;
    } else {
      console.log(`  ${name}: skipped (no ${file})`);
    }
    continue;
  }
  const mb = (statSync(file).size / 1e6).toFixed(1);
  console.log(`  ${name}.sql (${mb} MB)`);
  run(["d1", "execute", DB_NAME, "--file", file, TARGET]);
}

if (!NO_SEED) {
  const cursor = arg("cursor") !== undefined ? Number(arg("cursor")) : backfillTop();
  if (cursor === undefined || !Number.isFinite(cursor)) {
    console.log("Skipped cursor seed: no --cursor and no max topoheight in " + DB_PATH);
    console.log("Pass --cursor=<max stable topoheight> to seed sync_state for live collection.");
  } else {
    const now = "CAST(strftime('%s','now') AS INTEGER)*1000";
    const sql =
      `INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('live_blocks', ${cursor}, ${now})\n` +
      `  ON CONFLICT(stage) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at;\n` +
      `INSERT INTO sync_state (stage, cursor, updated_at) VALUES ('live_txs', ${cursor}, ${now})\n` +
      `  ON CONFLICT(stage) DO UPDATE SET cursor=excluded.cursor, updated_at=excluded.updated_at;\n`;
    const seedFile = join(OUT_DIR, ".seed_sync_state.sql");
    writeFileSync(seedFile, sql);
    try {
      console.log(`  seeding 'live_blocks'/'live_txs' cursor = ${cursor}`);
      run(["d1", "execute", DB_NAME, "--file", seedFile, TARGET]);
    } finally {
      unlinkSync(seedFile);
    }
  }
}

console.log("Done.");
