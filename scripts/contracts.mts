/**
 * Contract registry scanner (one-shot, resumable).
 *
 * Xelis contract IDs are the TXIDs of the transactions that deployed them,
 * so the deploy tx for every contract can be fetched directly with
 * get_transaction(<contract_id>). From it we take the deployer (source),
 * timestamp, and the executing block (resolved against the local blocks
 * table). Deploy info does not depend on the tx-detail pass, which may
 * still be scanning older history.
 *
 * Writes the `contracts` table in the local backfill DB; export.mts ships
 * it to D1. Invoke/gas aggregates stay untouched here and are bumped by
 * the backfill tx pass and the live collector as those txs get indexed.
 *
 * Usage: node --experimental-strip-types scripts/contracts.mts
 * Env:   BACKFILL_NODE (default http://192.168.18.20:8080)
 *        BACKFILL_DB   (default data/backfill.db)
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const NODE = process.env.BACKFILL_NODE ?? "http://192.168.18.20:8080";
const DB_PATH = process.env.BACKFILL_DB ?? "data/backfill.db";

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY, deployer TEXT, deploy_topo INTEGER,
  invoke_count INTEGER, gas_total INTEGER, events_count INTEGER
);
`);

let rpcId = 0;
async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const res = await fetch(`${NODE}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params !== undefined ? { params } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

const lookupTopo = db.prepare("SELECT topoheight, ts FROM blocks WHERE hash = ?");
const getContract = db.prepare("SELECT deployer, deploy_topo FROM contracts WHERE contract_id = ?");
const insertContract = db.prepare(
  "INSERT INTO contracts (contract_id, deployer, deploy_topo, invoke_count, gas_total, events_count) VALUES (?, ?, ?, 0, 0, 0)"
);
const updateContract = db.prepare(`
  UPDATE contracts SET
    deployer = CASE WHEN ? != '' THEN ? ELSE deployer END,
    deploy_topo = COALESCE(deploy_topo, ?)
  WHERE contract_id = ?
`);

async function fetchContractIds(): Promise<string[]> {
  const ids: string[] = [];
  const page = 100;
  for (let skip = 0; ; skip += page) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch = await rpc<string[]>("get_contracts", { skip, maximum: page });
    if (!batch?.length) break;
    ids.push(...batch);
    if (batch.length < page) break;
  }
  return ids;
}

const ids = await fetchContractIds();
console.log(`Contracts on chain: ${ids.length} (node=${NODE})`);

let seeded = 0;
for (const id of ids) {
  const cid = String(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let t: any;
  for (let attempt = 0; ; attempt++) {
    try {
      t = await rpc<Record<string, unknown>>("get_transaction", { hash: cid });
      break;
    } catch (err) {
      if (attempt >= 4) {
        console.error(`${cid.slice(0, 12)}: get_transaction failed (${(err as Error).message})`);
        t = null;
        break;
      }
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
  if (!t) continue;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (t.data ?? {}) as any;
  if (!data.deploy_contract) {
    console.error(`${cid.slice(0, 12)}: not a deploy tx — skipping`);
    continue;
  }

  const deployer = String(t.source ?? "");
  let deployTopo: number | null = null;
  let ts: number | null = null;
  const exec = typeof t.executed_in_block === "string" ? t.executed_in_block : null;
  if (exec) {
    const r = lookupTopo.get(exec) as { topoheight: number; ts: number } | undefined;
    if (r) {
      deployTopo = Number(r.topoheight);
      ts = Number(r.ts);
    }
  }

  const existing = getContract.get(cid) as { deployer: string; deploy_topo: number } | undefined;
  if (!existing) {
    insertContract.run(cid, deployer, deployTopo);
  } else {
    updateContract.run(deployer, deployer, deployTopo, cid);
  }
  seeded++;

  const date = ts ? new Date(ts).toISOString().slice(0, 10) : "—";
  console.log(`${cid.slice(0, 12)}  deployer=${deployer ? deployer.slice(0, 16) + "…" : "?"}  topo=${deployTopo ?? "?"}  ${date}`);
}

console.log(`Seeded ${seeded}/${ids.length} contracts into ${DB_PATH}`);
console.log("Next: npm run export -- --only=contracts,daily_contracts, then import contracts.sql to D1.");