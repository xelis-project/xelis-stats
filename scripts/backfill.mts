/**
 * Xelis historical backfill scanner.
 * Pass 1: block summaries via get_blocks_range_by_topoheight (max 20/call).
 * Pass 2: transaction details via get_transaction for each txs_hashes entry.
 * Local SQLite, resumable, INSERT OR REPLACE (idempotent).
 *
 * NOTE: XELIS is privacy-preserving — transfer amounts/receivers are encrypted.
 * We index tx counts, types, fees, sizes, senders, miners, supply. Not balances.
 *
 * Usage: node --experimental-strip-types scripts/backfill.mts [--txs]
 * Env:   BACKFILL_NODE (default http://192.168.18.20:8080)
 *        BACKFILL_DB   (default data/backfill.db)
 *        BATCH (default 20 — daemon max), CONCURRENCY (default 8)
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Agent, setGlobalDispatcher } from "undici";

// allow enough parallel RPC connections (default 6 per origin throttles fetches)
setGlobalDispatcher(new Agent({ connections: 64, keepAliveTimeout: 30_000 }));

const NODE = process.env.BACKFILL_NODE ?? "http://192.168.18.20:8080";
const DB_PATH = process.env.BACKFILL_DB ?? "data/backfill.db";
const BATCH = Number(process.env.BATCH ?? 20); // daemon max range is 20
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const TXS_ONLY = process.argv.includes("--txs");

// ---------- sqlite setup ----------

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA synchronous=NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_topoheight INTEGER NOT NULL DEFAULT 0,
  blocks_done INTEGER NOT NULL DEFAULT 0,
  tx_cursor INTEGER NOT NULL DEFAULT 0,
  tx_done INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS blocks (
  topoheight INTEGER PRIMARY KEY,
  height INTEGER, hash TEXT, ts INTEGER, version INTEGER, nonce INTEGER,
  difficulty INTEGER, size INTEGER, tx_count INTEGER, block_type TEXT,
  miner_address TEXT,
  miner_reward INTEGER, dev_reward INTEGER, burned INTEGER,
  fee_total INTEGER, cum_difficulty TEXT, tips TEXT, txs_hashes TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height);

CREATE TABLE IF NOT EXISTS tx_index (
  hash TEXT PRIMARY KEY, block_topo INTEGER, ts INTEGER,
  fee INTEGER, size INTEGER, tx_type TEXT, sender TEXT,
  transfer_count INTEGER, version INTEGER, multisig INTEGER, contract_id TEXT,
  gas INTEGER, result TEXT, encrypted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_block ON tx_index(block_topo);
CREATE INDEX IF NOT EXISTS idx_tx_sender ON tx_index(sender);
CREATE INDEX IF NOT EXISTS idx_tx_type ON tx_index(tx_type);
CREATE INDEX IF NOT EXISTS idx_blocks_txcount ON blocks(tx_count, topoheight);

CREATE TABLE IF NOT EXISTS accounts (
  address TEXT PRIMARY KEY, first_seen INTEGER, last_active INTEGER, tx_count INTEGER,
  is_labeled INTEGER DEFAULT 0, label TEXT
);

CREATE TABLE IF NOT EXISTS daily_block_types (
  date TEXT, block_type TEXT, count INTEGER,
  PRIMARY KEY (date, block_type)
);

CREATE TABLE IF NOT EXISTS daily_miners (
  date TEXT, address TEXT, blocks_found INTEGER, rewards_earned INTEGER,
  PRIMARY KEY (date, address)
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY, name TEXT, symbol TEXT, decimals INTEGER, first_seen_topo INTEGER
);

CREATE TABLE IF NOT EXISTS tx_assets (
  tx_hash TEXT, asset TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_assets_asset ON tx_assets(asset);

CREATE TABLE IF NOT EXISTS tx_contracts (
  tx_hash TEXT PRIMARY KEY, contract_id TEXT, max_gas INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_contracts_cid ON tx_contracts(contract_id);

CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY, deployer TEXT, deploy_topo INTEGER,
  invoke_count INTEGER, gas_total INTEGER, events_count INTEGER
);
`);

// NOTE: daily_stats (tx counts, fees, transfer counts, unique miners, hashrate, etc.)
// is derived at export time via SQL GROUP BY — not maintained incrementally here.

// lightweight migrations for pre-existing DBs
function migrate(): void {
  const cols = (db.prepare("PRAGMA table_info(sync_state)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("tx_cursor")) db.exec("ALTER TABLE sync_state ADD COLUMN tx_cursor INTEGER NOT NULL DEFAULT 0");
  if (!cols.includes("tx_done")) db.exec("ALTER TABLE sync_state ADD COLUMN tx_done INTEGER NOT NULL DEFAULT 0");
  const bcols = (db.prepare("PRAGMA table_info(blocks)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!bcols.includes("txs_hashes")) db.exec("ALTER TABLE blocks ADD COLUMN txs_hashes TEXT");
  const tcols = (db.prepare("PRAGMA table_info(tx_index)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!tcols.includes("contract_id")) db.exec("ALTER TABLE tx_index ADD COLUMN contract_id TEXT");
  if (!tcols.includes("gas")) db.exec("ALTER TABLE tx_index ADD COLUMN gas INTEGER");
  if (!tcols.includes("result")) db.exec("ALTER TABLE tx_index ADD COLUMN result TEXT");
  if (!tcols.includes("encrypted")) db.exec("ALTER TABLE tx_index ADD COLUMN encrypted INTEGER DEFAULT 0");
  // one-time repair for rows written before `result` existed: block_topo was
  // only resolved from executed_in_block, so a non-NULL topo means executed.
  db.exec("UPDATE tx_index SET result = 'ok' WHERE result IS NULL AND block_topo IS NOT NULL");
  try { db.exec("CREATE TABLE IF NOT EXISTS tx_assets (tx_hash TEXT, asset TEXT); CREATE INDEX IF NOT EXISTS idx_tx_assets_asset ON tx_assets(asset);"); } catch { /* exists */ }
  try { db.exec("CREATE TABLE IF NOT EXISTS tx_contracts (tx_hash TEXT PRIMARY KEY, contract_id TEXT, max_gas INTEGER); CREATE INDEX IF NOT EXISTS idx_tx_contracts_cid ON tx_contracts(contract_id);"); } catch { /* exists */ }
  try { db.exec("CREATE TABLE IF NOT EXISTS contracts (contract_id TEXT PRIMARY KEY, deployer TEXT, deploy_topo INTEGER, invoke_count INTEGER, gas_total INTEGER, events_count INTEGER);"); } catch { /* exists */ }
  // contract ids are the TXIDs of their deploy transactions; repair deploys
  // indexed before that was known, and register them
  db.exec(`UPDATE tx_index SET contract_id = hash WHERE tx_type = 'deploy_contract' AND (contract_id IS NULL OR contract_id = '')`);
  try {
    db.exec(`INSERT INTO contracts (contract_id, deployer, deploy_topo, invoke_count, gas_total, events_count)
      SELECT hash, sender, block_topo, 0, 0, 0 FROM tx_index WHERE tx_type = 'deploy_contract' AND contract_id = hash
      ON CONFLICT(contract_id) DO UPDATE SET
        deployer = CASE WHEN excluded.deployer != '' THEN excluded.deployer ELSE contracts.deployer END,
        deploy_topo = COALESCE(contracts.deploy_topo, excluded.deploy_topo)`);
  } catch { /* older SQLite without upsert support */ }
}
migrate();

// ---------- state ----------

const getState = (): { last: number; done: number; txDone: number } => {
  const row = db.prepare("SELECT last_topoheight, blocks_done, tx_done FROM sync_state WHERE id = 1").get() as { last_topoheight: number; blocks_done: number; tx_done: number } | undefined;
  return row ? { last: row.last_topoheight, done: row.blocks_done, txDone: row.tx_done } : { last: 0, done: 0, txDone: 0 };
};

const saveState = (last: number, done: number, txDone: number, txCursor = -1): void => {
  if (txCursor >= 0) {
    db.prepare(`
      INSERT INTO sync_state (id, last_topoheight, blocks_done, tx_cursor, tx_done, started_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_topoheight = ?, blocks_done = ?, tx_cursor = ?, tx_done = ?, updated_at = ?
    `).run(last, done, txCursor, txDone, Date.now(), Date.now(), last, done, txCursor, txDone, Date.now());
  } else {
    db.prepare(`
      INSERT INTO sync_state (id, last_topoheight, blocks_done, tx_cursor, tx_done, started_at, updated_at)
      VALUES (1, ?, ?, COALESCE((SELECT tx_cursor FROM sync_state WHERE id = 1), 0), ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_topoheight = ?, blocks_done = ?, tx_done = ?, updated_at = ?
    `).run(last, done, txDone, Date.now(), Date.now(), last, done, txDone, Date.now());
  }
};

// ---------- rpc ----------

let rpcId = 0;
async function rpc<T>(method: string, params?: unknown): Promise<T> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id: ++rpcId, method };
  if (params !== undefined) body.params = params;
  const res = await fetch(`${NODE}/json_rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${method}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result as T;
}

async function getStableTopo(): Promise<number> {
  const info = await rpc<{ stable_topoheight: number; topoheight: number; height: number }>("get_info");
  return info.stable_topoheight;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBlocksRange(from: number, to: number): Promise<any[]> {
  return rpc<any[]>("get_blocks_range_by_topoheight", { start_topoheight: from, end_topoheight: to });
}

// ---------- prepared statements ----------

const insertBlock = db.prepare(`
  INSERT OR REPLACE INTO blocks
  (topoheight, height, hash, ts, version, nonce, difficulty, size, tx_count, block_type,
   miner_address, miner_reward, dev_reward, burned, fee_total, cum_difficulty, tips, txs_hashes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTx = db.prepare(`
  INSERT OR REPLACE INTO tx_index
  (hash, block_topo, ts, fee, size, tx_type, sender, transfer_count, version, multisig, contract_id, gas, result, encrypted)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const upsertAccount = db.prepare(`
  INSERT INTO accounts (address, first_seen, last_active, tx_count)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(address) DO UPDATE SET
    last_active = MAX(last_active, ?),
    tx_count = tx_count + 1
`);
const upsertAccountNoCount = db.prepare(`
  INSERT INTO accounts (address, first_seen, last_active, tx_count)
  VALUES (?, ?, ?, 0)
  ON CONFLICT(address) DO UPDATE SET last_active = MAX(last_active, ?)
`);
const insertTxAsset = db.prepare("INSERT OR IGNORE INTO tx_assets (tx_hash, asset) VALUES (?, ?)");
const upsertAsset = db.prepare(`
  INSERT INTO assets (asset_id, name, symbol, decimals, first_seen_topo)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(asset_id) DO UPDATE SET
    name = CASE WHEN assets.name IS NULL OR assets.name = '' THEN excluded.name ELSE assets.name END,
    symbol = CASE WHEN assets.symbol IS NULL OR assets.symbol = '' THEN excluded.symbol ELSE assets.symbol END,
    decimals = COALESCE(assets.decimals, excluded.decimals),
    first_seen_topo = COALESCE(assets.first_seen_topo, excluded.first_seen_topo)
`);

// asset registry: ids seen in transfers get one best-effort get_asset lookup each
const registeredAssets = new Set<string>();
const assetMetaJobs = new Map<string, Promise<{ name: string; symbol: string; decimals: number }>>();

async function getAssetMeta(assetId: string): Promise<{ name: string; symbol: string; decimals: number }> {
  let p = assetMetaJobs.get(assetId);
  if (!p) {
    p = rpc<{ name?: string; ticker?: string; decimals?: number }>("get_asset", { asset: assetId })
      .then((a) => ({ name: String(a.name ?? ""), symbol: String(a.ticker ?? ""), decimals: Number(a.decimals ?? 8) }))
      .catch(() => ({ name: "", symbol: "", decimals: 8 }));
    assetMetaJobs.set(assetId, p);
  }
  return p;
}

async function ensureAsset(assetId: string, firstSeenTopo: number | null): Promise<void> {
  if (registeredAssets.has(assetId)) return;
  registeredAssets.add(assetId);
  const meta = await getAssetMeta(assetId);
  upsertAsset.run(assetId, meta.name, meta.symbol, meta.decimals, firstSeenTopo);
}

// load known asset ids; re-lookup rows stored without metadata (node was
// unreachable during a previous pass) so the upsert can fill them in
for (const r of db.prepare("SELECT asset_id FROM assets").all() as Array<{ asset_id: string }>) registeredAssets.add(r.asset_id);
for (const r of db.prepare("SELECT asset_id FROM assets WHERE (name IS NULL OR name = '') AND (symbol IS NULL OR symbol = '')").all() as Array<{ asset_id: string }>) registeredAssets.delete(r.asset_id);
const insertTxContract = db.prepare("INSERT OR REPLACE INTO tx_contracts (tx_hash, contract_id, max_gas) VALUES (?, ?, ?)");
// contract registry: deploys register identity (id, deployer, topo); invokes bump usage
const insertContractRegistry = db.prepare(`
  INSERT INTO contracts (contract_id, deployer, deploy_topo, invoke_count, gas_total, events_count)
  VALUES (?, ?, ?, 0, 0, 0)
  ON CONFLICT(contract_id) DO UPDATE SET
    deployer = CASE WHEN excluded.deployer != '' THEN excluded.deployer ELSE contracts.deployer END,
    deploy_topo = COALESCE(contracts.deploy_topo, excluded.deploy_topo)
`);
const upsertContractInvoke = db.prepare(`
  INSERT INTO contracts (contract_id, deployer, deploy_topo, invoke_count, gas_total, events_count)
  VALUES (?, '', NULL, 1, ?, 0)
  ON CONFLICT(contract_id) DO UPDATE SET
    invoke_count = invoke_count + 1,
    gas_total = gas_total + ?
`);
const upsertDailyMiner = db.prepare(`
  INSERT INTO daily_miners (date, address, blocks_found, rewards_earned)
  VALUES (?, ?, 1, ?)
  ON CONFLICT(date, address) DO UPDATE SET
    blocks_found = blocks_found + 1,
    rewards_earned = rewards_earned + ?
`);
const upsertDailyBlockType = db.prepare(`
  INSERT INTO daily_block_types (date, block_type, count)
  VALUES (?, ?, 1)
  ON CONFLICT(date, block_type) DO UPDATE SET count = count + 1
`);

// ---------- helpers ----------

// daemon timestamps are milliseconds
function dayOf(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function processBlock(b: any): void {
  const topo = Number(b.topoheight);
  const tsMs = Number(b.timestamp ?? 0);
  const blockType = String(b.block_type ?? "normal"); // "normal" | "sync"
  const txsHashes = (b.txs_hashes ?? []) as string[];

  insertBlock.run(
    topo, Number(b.height ?? 0), String(b.hash ?? ""), tsMs, Number(b.version ?? 0),
    Number(b.nonce ?? 0), Number(b.difficulty ?? 0), Number(b.total_size_in_bytes ?? 0),
    txsHashes.length, blockType,
    String(b.miner ?? ""), Number(b.miner_reward ?? 0), Number(b.dev_reward ?? 0),
    Number(b.total_fees_burned ?? 0), Number(b.total_fees ?? 0),
String(b.cumulative_difficulty ?? ""), JSON.stringify(b.tips ?? []),
    JSON.stringify(txsHashes),
  );

  // miner account + daily aggregates
  if (b.miner) {
    const day = dayOf(tsMs);
    const reward = Number(b.miner_reward ?? 0);
    upsertAccountNoCount.run(String(b.miner), tsMs, tsMs, tsMs);
    upsertDailyMiner.run(day, String(b.miner), reward, reward);
    upsertDailyBlockType.run(day, blockType);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyTx(t: any): { type: string; contractId: string | null } {
  const data = t.data ?? {};
  if (data.burn) return { type: "burn", contractId: null };
  if (data.invoke_contract) return { type: "invoke_contract", contractId: String(data.invoke_contract.contract ?? "") || null };
  // contract ids are the TXIDs of their deploy transactions
  if (data.deploy_contract) return { type: "deploy_contract", contractId: String(t.hash ?? "") || null };
  if (t.multisig) return { type: "multisig", contractId: null };
  if (data.transfers) return { type: "transfer", contractId: null };
  return { type: "other", contractId: null };
}

// hash -> topo lookup for executed_in_block resolution
const lookupTopo = db.prepare("SELECT topoheight FROM blocks WHERE hash = ?");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processTx(t: any, tsMs: number): Promise<boolean> {
  const hash = String(t.hash ?? "");
  if (!hash) return false;
  const existing = db.prepare("SELECT 1 FROM tx_index WHERE hash = ?").get(hash);
  if (existing) return false;

  // executed_in_block is a block HASH string (verified against daemon)
  let blockTopo: number | null = null;
  const exec = t.executed_in_block;
  if (typeof exec === "string") {
    const r = lookupTopo.get(exec) as { topoheight: number } | undefined;
    blockTopo = r ? r.topoheight : null;
  } else if (Array.isArray(t.blocks) && t.blocks.length > 0) {
    const r = lookupTopo.get(String(t.blocks[0])) as { topoheight: number } | undefined;
    blockTopo = r ? Number(r.topoheight) : null;
  }

  const { type: txType, contractId } = classifyTx(t);
  const transfers = Array.isArray(t.data?.transfers) ? t.data.transfers : [];
  const transferCount = transfers.length;

insertTx.run(
    hash, blockTopo, tsMs,
    Number(t.fee_paid ?? t.fee ?? 0), Number(t.size ?? 0),
    txType, String(t.source ?? ''),
    transferCount, Number(t.version ?? 0), t.multisig ? 1 : 0,
    contractId,
    Number(t.data?.invoke_contract?.max_gas ?? 0),
    exec ? "ok" : "unexecuted",
    transferCount > 0 ? 1 : 0,
  );

  // gas burned for contract ops (deploy max_gas lives under deploy_contract.invoke)
  if (txType === "invoke_contract" && contractId) {
    insertTxContract.run(hash, contractId, Number(t.data?.invoke_contract?.max_gas ?? 0));
    upsertContractInvoke.run(contractId, Number(t.data?.invoke_contract?.max_gas ?? 0));
  } else if (txType === "deploy_contract" && contractId) {
    insertTxContract.run(hash, contractId, Number(t.data?.deploy_contract?.invoke?.max_gas ?? 0));
    insertContractRegistry.run(contractId, String(t.source ?? ""), blockTopo);
  }

  // capture asset ids (amounts/receivers are encrypted, ids are visible)
  for (const tr of transfers) {
    if (tr && typeof tr.asset === "string") {
      const assetId = String(tr.asset);
      insertTxAsset.run(hash, assetId);
      await ensureAsset(assetId, blockTopo);
    }
  }

  if (t.source) {
    upsertAccount.run(String(t.source), tsMs, tsMs, tsMs);
  }
  return true;
}

// ---------- pass 1: blocks ----------

async function backfillBlocks(): Promise<void> {
  const stable = await getStableTopo();
  const { last, done } = getState();
  const start = Math.max(last + 1, 0);
  console.log(`[blocks] stable=${stable} resume from ${start} (remaining ${stable - start + 1})`);
  if (start > stable) return;

  const completed = new Map<number, number>(); // contiguous frontier tracking
  let frontier = start - 1;
  let doneBlocks = done;
  let sinceCheckpoint = 0;
  const startedAt = Date.now();
  const CHECKPOINT_EVERY = 20_000;

  const markComplete = (from: number, to: number): void => {
    completed.set(to, from);
    while (completed.has(frontier + 1)) {
      const fStart = completed.get(frontier + 1)!;
      const fEnd = frontier + 1;
      completed.delete(fEnd);
      frontier = fEnd;
      sinceCheckpoint += fEnd - fStart + 1;
      doneBlocks += fEnd - fStart + 1;
    }
  };

  let batchStart = start;
  const inflight = new Set<Promise<void>>();

  const runBatch = async (from: number, to: number): Promise<void> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let blocks: any[];
    for (let attempt = 0; ; attempt++) {
      try {
        blocks = await getBlocksRange(from, to);
        break;
      } catch (err) {
        if (attempt >= 8) throw err;
        const wait = Math.pow(2, Math.min(attempt, 5)) * 1000;
        console.error(`[blocks] batch ${from}-${to} failed (${(err as Error).message}); retry ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    for (const b of blocks) processBlock(b);
    markComplete(from, to);
  };

  while (frontier < stable) {
    if (batchStart > stable) {
      // all remaining batches launched; wait for out-of-order completions
      await Promise.race(inflight);
      continue;
    }
    const batchEnd = Math.min(batchStart + BATCH - 1, stable);
    const p = runBatch(batchStart, batchEnd);
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
    batchStart = batchEnd + 1;
    if (inflight.size >= CONCURRENCY) await Promise.race(inflight);

    if (sinceCheckpoint >= CHECKPOINT_EVERY) {
      saveState(frontier, doneBlocks, getState().txDone);
      sinceCheckpoint = 0;
      const elapsed = (Date.now() - startedAt) / 1000;
      const bps = (frontier - start + 1) / elapsed;
      const etaH = ((stable - frontier) / Math.max(bps, 0.1) / 3600).toFixed(1);
      console.log(`[blocks] ${frontier}/${stable} (${((frontier / stable) * 100).toFixed(2)}%) · ${bps.toFixed(0)} blk/s · ETA ${etaH}h`);
    }
  }

  await Promise.all(inflight);
  saveState(stable, doneBlocks, getState().txDone);
  console.log(`[blocks] complete through stable topoheight ${stable}`);
}

// ---------- pass 2: transactions ----------

async function backfillTxs(): Promise<void> {
  const stable = await getStableTopo();
  const state = db.prepare("SELECT tx_cursor, tx_done FROM sync_state WHERE id = 1").get() as { tx_cursor: number; tx_done: number } | undefined;
  let txCursor = state?.tx_cursor ?? 0;
  let txDone = state?.tx_done ?? 0;
  console.log(`[txs] indexing from topo > ${txCursor} (tx_done: ${txDone})`);

  const fetchTx = async (hash: string, ts: number): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await rpc<any>("get_transaction", { hash });
        await processTx(t, ts);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        // pruned/orphaned txs: daemon wording varies ("not found", "Couldn't find", NON_EXISTENT)
        if (/not found|couldn'?t find|doesn'?t exist|non.?existent|no transaction/i.test(msg)) return;
        if (attempt >= 3) { console.error(`[txs] ${hash.slice(0, 10)} giving up: ${msg}`); return; }
        await new Promise((r) => setTimeout(r, Math.pow(2, Math.min(attempt, 3)) * 1000));
      }
    }
  };

  const startedAt = Date.now();
  let doneSinceCheckpoint = 0;

  for (;;) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = db.prepare(`
      SELECT topoheight, ts, txs_hashes FROM blocks
      WHERE tx_count > 0 AND topoheight > ? AND topoheight <= ?
      ORDER BY topoheight LIMIT 200
    `).all(txCursor, stable);

    if (!rows.length) break;

    const jobs: Promise<void>[] = [];
    for (const row of rows) {
      const hashes = JSON.parse(row.txs_hashes) as string[];
      for (const h of hashes) {
        jobs.push(fetchTx(h, Number(row.ts)).then(() => { doneSinceCheckpoint++; }));
      }
    }
    await Promise.all(jobs.map((p) => p.catch(() => {})));

    txCursor = Number(rows[rows.length - 1].topoheight);
    txDone += doneSinceCheckpoint;
    doneSinceCheckpoint = 0;

    const elapsed = (Date.now() - startedAt) / 1000;
    console.log(`[txs] cursor=${txCursor} · tx_done≈${txDone} · ${((txDone - (state?.tx_done ?? 0)) / Math.max(elapsed, 1)).toFixed(0)} tx/s`);
    saveState(getState().last, getState().done, txDone, txCursor);
  }

  saveState(getState().last, getState().done, txDone, txCursor);
  console.log(`[txs] pass complete through topo ${txCursor}`);
}

// ---------- main ----------

async function main(): Promise<void> {
  console.log(`Backfill: node=${NODE} db=${DB_PATH} batch=${BATCH} concurrency=${CONCURRENCY}`);
  if (TXS_ONLY) {
    await backfillTxs();
  } else {
    await backfillBlocks();
  }
}

main().catch((err) => {
  console.error("Backfill fatal:", err);
  process.exit(1);
});




