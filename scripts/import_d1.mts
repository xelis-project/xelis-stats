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
 * Large dumps may be split by export.mts into numbered chunks (`blocks.000.sql`
 * …) to stay under the size `wrangler d1 execute --file` can read; each logical
 * table's chunks are applied in order. Any file still above the safe read size
 * (e.g. produced by an older export) is re-split on statement boundaries into
 * temporary parts before being applied.
 * The live collector cursors ('live_blocks'/'live_txs') are then seeded to the
 * backfill top (max topoheight in BACKFILL_DB, or --cursor=N) so `npm run dev`
 * resumes from the tip instead of re-walking history, which would double-count
 * the daily_miners/daily_block_types upserts.
 */
import { existsSync, rmSync, writeFileSync, unlinkSync, statSync, readdirSync, createReadStream, createWriteStream, mkdtempSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
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
// `wrangler d1 execute --file` reads the whole dump into a JS string, so V8's
// max string length (0x1fffffe8 ≈ 512 MiB) is the real cap — not D1's 2 GiB
// file limit. Keep parts comfortably under it; larger files are re-split.
const MAX_FILE_BYTES = Number(process.env.IMPORT_CHUNK_BYTES ?? 400_000_000);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pick up the file(s) for a logical dump: the numbered chunks when the export
 *  was split to stay under D1's 2 GiB `--file` limit, otherwise `<name>.sql`. */
function filesFor(name: string): string[] {
  if (!existsSync(OUT_DIR)) return [];
  const re = new RegExp(`^${escapeRegExp(name)}\\.(\\d{3})\\.sql$`);
  const parts: Array<[number, string]> = [];
  for (const f of readdirSync(OUT_DIR)) {
    const m = re.exec(f);
    if (m) parts.push([Number(m[1]), join(OUT_DIR, f)]);
  }
  if (parts.length) return parts.sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const base = join(OUT_DIR, `${name}.sql`);
  return existsSync(base) ? [base] : [];
}

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

/** Split a large `.sql` dump into temp parts under MAX_FILE_BYTES so wrangler
 *  can read each one. Cuts only between statements (after `;` + newline, outside
 *  single-quoted strings) so every part is valid SQL on its own. */
async function splitSqlFile(file: string, dir: string): Promise<string[]> {
  const parts: string[] = [];
  let out: ReturnType<typeof createWriteStream> | undefined;
  let outBytes = 0;

  const openPart = (): void => {
    const p = join(dir, `part-${String(parts.length).padStart(3, "0")}.sql`);
    out = createWriteStream(p);
    outBytes = 0;
    parts.push(p);
  };
  const closePart = async (): Promise<void> => {
    if (!out) return;
    const done = once(out, "close");
    out.end();
    await done;
    out = undefined;
  };
  const writeStmt = async (stmt: string): Promise<void> => {
    if (out && outBytes >= MAX_FILE_BYTES) await closePart();
    if (!out) openPart();
    const ok = out!.write(stmt);
    outBytes += Buffer.byteLength(stmt);
    if (!ok) await once(out!, "drain");
  };

  let carry = "";
  let inQuote = false;
  let semicolonPending = false;
  for await (const chunk of createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 24 })) {
    const piece = chunk as string;
    let start = 0;
    let i = 0;
    if (semicolonPending) {
      semicolonPending = false;
      if (piece[0] === "\n") {
        await writeStmt(carry + "\n");
        carry = "";
        i = 1;
      }
    }
    start = i;
    while (i < piece.length) {
      const ch = piece[i];
      if (inQuote) {
        if (ch === "'") {
          if (piece[i + 1] === "'") { i += 2; continue; }
          inQuote = false;
        }
        i++;
      } else if (ch === "'") {
        inQuote = true;
        i++;
      } else if (ch === ";") {
        if (i + 1 < piece.length) {
          if (piece[i + 1] === "\n") {
            await writeStmt(carry + piece.slice(start, i + 2));
            carry = "";
            i += 2;
            start = i;
            continue;
          }
          i++;
        } else {
          carry += piece.slice(start, i + 1);
          semicolonPending = true;
          i++;
          start = i;
        }
      } else {
        i++;
      }
    }
    if (start < piece.length) carry += piece.slice(start);
  }
  if (carry.trim().length) await writeStmt(carry);
  await closePart();
  return parts;
}

/** Apply one dump file, re-splitting first when it is too large to read. */
async function applyFile(file: string): Promise<void> {
  if (statSync(file).size <= MAX_FILE_BYTES) {
    run(["d1", "execute", DB_NAME, "--file", file, TARGET]);
    return;
  }
  const mb = (statSync(file).size / 1e6).toFixed(0);
  const dir = mkdtempSync(join(tmpdir(), "d1-import-"));
  try {
    const parts = await splitSqlFile(file, dir);
    console.log(`    ${basename(file)} is ${mb} MB; split into ${parts.length} parts`);
    if (DRY) { console.log(`  [dry-run] would import ${parts.length} temporary parts from ${dir}`); return; }
    for (const p of parts) run(["d1", "execute", DB_NAME, "--file", p, TARGET]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const files = filesFor(name);
  if (!files.length) {
    if (ONLY.length) {
      console.error(`  ${name}: no ${join(OUT_DIR, `${name}.sql`)} or ${name}.NNN.sql chunks`);
      process.exitCode = 1;
    } else {
      console.log(`  ${name}: skipped (no export file)`);
    }
    continue;
  }
  const mb = (files.reduce((n, f) => n + statSync(f).size, 0) / 1e6).toFixed(1);
  console.log(`  ${name}.sql (${mb} MB${files.length > 1 ? `, ${files.length} parts` : ""})`);
  for (const file of files) await applyFile(file);
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
