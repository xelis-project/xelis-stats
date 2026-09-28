/**
 * Locate the live local D1 SQLite behind `wrangler dev`.
 *
 * A local shard bootstrap (`bootstrap_shards.mts --local`) creates additional
 * D1 objects next to the hot one in the same Miniflare directory, so picking
 * the first `*.sqlite` is ambiguous. The hot DB is the only one that carries
 * the aggregate tables (`daily_stats`) and it always owns the newest blocks, so
 * prefer a database with `daily_stats`, then the highest `blocks.topoheight`,
 * then the largest file.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const STATE_D1_DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

function hasTable(path: string, table: string): boolean {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      return Boolean(row);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function maxTopo(path: string): number {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare("SELECT MAX(topoheight) AS m FROM blocks").get() as { m: number | null } | undefined;
      return row?.m != null ? Number(row.m) : 0;
    } finally {
      db.close();
    }
  } catch {
    return -1;
  }
}

/** The local Miniflare D1 SQLite file, or undefined if the state dir is absent. */
export function localD1Path(): string | undefined {
  let names: string[];
  try {
    names = readdirSync(STATE_D1_DIR).filter((n) => n.endsWith(".sqlite") && n !== "metadata.sqlite");
  } catch {
    return undefined;
  }
  let best: { path: string; score: [number, number, number] } | undefined;
  for (const n of names) {
    const path = join(STATE_D1_DIR, n);
    let size = 0;
    try { size = statSync(path).size; } catch { continue; }
    const score: [number, number, number] = [hasTable(path, "daily_stats") ? 1 : 0, maxTopo(path), size];
    if (!best || score[0] > best.score[0]
      || (score[0] === best.score[0] && score[1] > best.score[1])
      || (score[0] === best.score[0] && score[1] === best.score[1] && score[2] > best.score[2])) {
      best = { path, score };
    }
  }
  return best?.path;
}
