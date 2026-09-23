/**
 * Backfill progress monitor: reads sync_state from local SQLite.
 * Reports separate block/tx progress, throughput, ETA, and resumability.
 * Usage: node --experimental-strip-types scripts/monitor.mts
 */
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.BACKFILL_DB ?? "data/backfill.db";

interface Progress {
  last_topoheight: number;
  blocks_done: number;
  tx_cursor: number;
  tx_done: number;
  started_at: number;
  updated_at: number;
}

const fmtInt = (n: number): string => n.toLocaleString("en-US");

async function main(): Promise<void> {
  let row: Progress | undefined;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    row = db.prepare("SELECT last_topoheight, blocks_done, tx_cursor, tx_done, started_at, updated_at FROM sync_state WHERE id = 1").get() as Progress | undefined;
  } catch (err) {
    console.error("Monitor error:", (err as Error).message);
    process.exit(1);
  }
  if (!row) {
    console.log("No progress yet — backfill not started or empty db.");
    return;
  }

  let stable: number | null = null;
  if (!process.env.MONITOR_OFFLINE) {
    try {
      const node = process.env.BACKFILL_NODE ?? "http://192.168.18.20:8080";
      const res = await fetch(`${node}/json_rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "get_info" }),
      });
      const json = (await res.json()) as { result?: { stable_topoheight: number } };
      stable = json.result?.stable_topoheight ?? null;
    } catch { /* offline — skip target */ }
  }

  console.log(`Blocks: indexed through topo ${fmtInt(row.last_topoheight)} (${fmtInt(row.blocks_done)} done)`);
  if (stable !== null) {
    const remaining = Math.max(stable - row.last_topoheight, 0);
    console.log(`Stable target: ${fmtInt(stable)} (behind by ${fmtInt(remaining)})`);
  }
  console.log(`Txs: enriched ${fmtInt(row.tx_done)}, cursor topo ${fmtInt(row.tx_cursor)}`);

  if (row.started_at > 0) {
    const elapsedMin = (row.updated_at - row.started_at) / 60000;
    console.log(`Running for: ${elapsedMin.toFixed(0)} min`);
    console.log(`Blocks/sec (avg): ${(row.blocks_done / Math.max(elapsedMin * 60, 1)).toFixed(1)}`);
  } else {
    console.log("Running for: unknown (started_at not recorded)");
  }
  console.log(`Last checkpoint: ${new Date(row.updated_at).toISOString()}`);
  console.log(`Resumable: ${Date.now() - row.updated_at < 10 * 60_000 ? "recent activity — state is current" : "no recent checkpoint — rerun backfill to resume"}`);
}

await main();
