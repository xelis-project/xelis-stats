-- Xelis Stats — D1 schema (Cloudflare live side)
-- Consolidated init schema (merges former 0001–0007 migrations).
-- sync state: separate per-stage checkpoints
CREATE TABLE IF NOT EXISTS sync_state (
  stage TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT,
  updated_at INTEGER
);

-- chain
CREATE TABLE IF NOT EXISTS blocks (
  topoheight INTEGER PRIMARY KEY,
  height INTEGER, hash TEXT, ts INTEGER, version INTEGER, nonce INTEGER,
  difficulty INTEGER, size INTEGER, tx_count INTEGER, block_type TEXT,
  miner_address TEXT,
  miner_reward INTEGER, dev_reward INTEGER, burned INTEGER,
  fee_total INTEGER, cum_difficulty TEXT, tips TEXT, txs_hashes TEXT
);
CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height);
CREATE INDEX IF NOT EXISTS idx_blocks_hash ON blocks(hash);
CREATE INDEX IF NOT EXISTS idx_blocks_ts ON blocks(ts);
-- per-address miner lookups (miner profile page, account page, search)
CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_address);
-- Composite miner + time index. The miner profile computes 24h hashrate with
--   SELECT SUM(difficulty), COUNT(*) FROM blocks WHERE miner_address = ? AND ts > ?
-- With only idx_blocks_miner(miner_address) SQLite narrows to every block the
-- address ever mined and then fetches each row to test `ts`; for a top miner
-- that is millions of row lookups to keep a few hundred rows. This index lets
-- the range be resolved in the index instead. Mirrored in SHARD_SCHEMA
-- (src/server/shards.ts) for newly created shards.
CREATE INDEX IF NOT EXISTS idx_blocks_miner_ts ON blocks(miner_address, ts);
-- Composite sort indexes. The list pages sort with a stable
-- `ORDER BY <col> <dir>, <tiebreak> <dir>` (the tiebreak follows the sort
-- direction). Without a matching index SQLite does a full scan plus a temp
-- B-tree sort (tens of seconds over millions of rows); with it the query is an
-- ordered index scan that stops after the page size. A `(sort key, tiebreak)`
-- index serves ASC via a forward scan and DESC via a reverse scan. These are
-- mirrored in SHARD_SCHEMA (src/server/shards.ts) for newly created shards.
CREATE INDEX IF NOT EXISTS idx_blocks_ts_topo ON blocks(ts, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_tx_count_topo ON blocks(tx_count, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_difficulty_topo ON blocks(difficulty, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_reward_topo ON blocks(miner_reward, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_type_topo ON blocks(block_type, topoheight);

CREATE TABLE IF NOT EXISTS tx_index (
  hash TEXT PRIMARY KEY, block_topo INTEGER, ts INTEGER,
  fee INTEGER, size INTEGER, tx_type TEXT, sender TEXT,
  transfer_count INTEGER, version INTEGER, multisig INTEGER, contract_id TEXT,
  gas INTEGER, executed INTEGER, encrypted INTEGER DEFAULT 0,
  -- burn payloads are public on Xelis: the burned amount and asset are plaintext
  -- on-chain (unlike transfer amounts); NULL burn_asset marks legacy rows
  -- still needing a backfill
  burn_amount INTEGER DEFAULT 0, burn_asset TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_block ON tx_index(block_topo);
CREATE INDEX IF NOT EXISTS idx_tx_sender ON tx_index(sender);
CREATE INDEX IF NOT EXISTS idx_tx_type_ts ON tx_index(tx_type, ts);
-- tx_index default order is block_topo DESC, hash DESC; the composite index is
-- both the sort index and the keyset cursor for deep transaction browsing.
CREATE INDEX IF NOT EXISTS idx_tx_block_hash ON tx_index(block_topo, hash);
CREATE INDEX IF NOT EXISTS idx_tx_ts_hash ON tx_index(ts, hash);
CREATE INDEX IF NOT EXISTS idx_tx_fee_hash ON tx_index(fee, hash);
CREATE INDEX IF NOT EXISTS idx_tx_type_hash ON tx_index(tx_type, hash);
CREATE INDEX IF NOT EXISTS idx_tx_sender_hash ON tx_index(sender, hash);
CREATE INDEX IF NOT EXISTS idx_tx_executed_hash ON tx_index(executed, hash);
CREATE INDEX IF NOT EXISTS idx_tx_transfer_count_hash ON tx_index(transfer_count, hash);

-- Public asset involvement per tx (ids only; amounts are encrypted)
CREATE TABLE IF NOT EXISTS tx_assets (
  tx_hash TEXT, asset TEXT,
  PRIMARY KEY (tx_hash, asset)
);
CREATE INDEX IF NOT EXISTS idx_tx_assets_asset ON tx_assets(asset);

-- Transfer amounts/receivers are encrypted on mainnet; per-transfer rows are not indexed.
-- Asset involvement per tx is public and stored in tx_assets.

-- accounts: observed public sender activity only (no balances)
CREATE TABLE IF NOT EXISTS accounts (
  address TEXT PRIMARY KEY, first_seen INTEGER, last_active INTEGER,
  tx_count INTEGER DEFAULT 0,
  is_labeled INTEGER DEFAULT 0, label TEXT
);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(last_active);

-- daily aggregates (public, sender-observation metrics only)
CREATE TABLE IF NOT EXISTS daily_stats (
  date TEXT PRIMARY KEY, active_accounts INTEGER, new_accounts INTEGER,
  tx_count INTEGER, transfer_count INTEGER,
  avg_fee INTEGER, median_fee INTEGER, fee_p90 INTEGER, fee_p99 INTEGER,
  hashrate INTEGER, unique_miners INTEGER,
  block_prod_gini REAL, orphan_count INTEGER,
  encrypted_tx_pct REAL, fees_vs_rewards_pct REAL,
  miner_revenue INTEGER, fee_total_sum INTEGER, emitted_supply INTEGER, burned_supply INTEGER,
  circulating_supply INTEGER, market_cap_usd REAL,
  dag_tips_avg REAL, peer_count INTEGER, stable_topo INTEGER, fee_rate_est INTEGER
);

CREATE TABLE IF NOT EXISTS daily_block_types (
  date TEXT, block_type TEXT, count INTEGER,
  PRIMARY KEY (date, block_type)
);

-- blocks_found counts every block a miner produced regardless of type
-- (Normal + Side + Sync); side_count/sync_count break out the non-normal share
-- so the leaderboard can show it without re-scanning the raw blocks table
-- (which is sharded once the 10GB cap nears). Normal = blocks_found - side - sync.
CREATE TABLE IF NOT EXISTS daily_miners (
  date TEXT, address TEXT, blocks_found INTEGER, rewards_earned INTEGER,
  side_count INTEGER NOT NULL DEFAULT 0, sync_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, address)
);
CREATE INDEX IF NOT EXISTS idx_daily_miners_addr ON daily_miners(address);

-- Sender-observation stats only. 'sent' counts transfer outputs publicly visible
-- as counts, not amounts. No 'received' column (receivers are encrypted).
CREATE TABLE IF NOT EXISTS daily_address_stats (
  date TEXT, address TEXT, tx_count INTEGER, transfer_outputs INTEGER, burned INTEGER,
  PRIMARY KEY (date, address)
);

-- Per-asset activity counts only; no private volume is inferred.
CREATE TABLE IF NOT EXISTS daily_assets (
  date TEXT, asset_id TEXT, tx_count INTEGER, transfer_count INTEGER,
  PRIMARY KEY (date, asset_id)
);

CREATE TABLE IF NOT EXISTS daily_contracts (
  date TEXT, contract_id TEXT, invoke_count INTEGER, gas_burned INTEGER, deploys INTEGER,
  PRIMARY KEY (date, contract_id)
);

CREATE TABLE IF NOT EXISTS tx_contracts (
  tx_hash TEXT PRIMARY KEY, contract_id TEXT, max_gas INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_contracts_cid ON tx_contracts(contract_id);

-- D1 sharding support (10GB per-database hardcap workaround).
-- Raw chain tables (blocks, tx_index, tx_assets, tx_contracts) are migrated out
-- of this database into per-range shard databases once the 10GB cap nears.
-- The shards table is the routing registry; hotFloor = max(last_topo) of sealed
-- shards; topos <= hotFloor live in shards, everything newer lives here.
CREATE TABLE IF NOT EXISTS shards (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  db_id TEXT NOT NULL,
  first_topo INTEGER NOT NULL,
  last_topo INTEGER,             -- cut target while open; final bound once sealed
  copied_topo INTEGER NOT NULL DEFAULT 0,
  first_ts INTEGER, last_ts INTEGER,
  sealed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shards_topo ON shards(first_topo, last_topo);

-- Point-lookup routing (hash -> topo) so tx/block detail pages hit exactly one
-- database. Written at ingest; backfilled lazily on first lookup miss.
CREATE TABLE IF NOT EXISTS tx_route (hash TEXT PRIMARY KEY, block_topo INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS block_route (hash TEXT PRIMARY KEY, topoheight INTEGER NOT NULL);

-- entities
CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY, name TEXT, symbol TEXT, decimals INTEGER, first_seen_topo INTEGER
);
CREATE TABLE IF NOT EXISTS contracts (
  contract_id TEXT PRIMARY KEY, deployer TEXT, deploy_topo INTEGER, invoke_count INTEGER, gas_total INTEGER, events_count INTEGER
);

-- market
CREATE TABLE IF NOT EXISTS market_snapshots (
  ts INTEGER, exchange TEXT, market TEXT, last REAL, bid REAL, ask REAL,
  high REAL, low REAL, change_pct REAL, base_volume REAL, quote_volume REAL,
  source_ts INTEGER,
  PRIMARY KEY (ts, exchange, market)
);
CREATE INDEX IF NOT EXISTS idx_market_ts ON market_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_market_ex ON market_snapshots(exchange, ts);

-- Exchange registry: lifecycle + display metadata for the market feeds.
-- Seeded by scripts/import_history.mts from the legacy Postgres market history;
-- venues live in src/server/market/sources.ts are 'active'. status is one of
-- 'active' | 'inactive'. added_ts/retired_ts are market-snapshot timestamps (ms)
-- bounding the data we hold, so the charts page can order and label venues.
CREATE TABLE IF NOT EXISTS exchanges (
  name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  url TEXT,
  added_ts INTEGER,
  retired_ts INTEGER,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_exchanges_status ON exchanges(status);

CREATE TABLE IF NOT EXISTS mempool_snapshots (ts INTEGER PRIMARY KEY, size INTEGER);

-- On-disk chain (database) size snapshots, from the node's get_size_on_disk
-- RPC. Recorded by the cron alongside mempool/peer snapshots so the blockchain
-- size can be charted over time; the newest row is also the "current" size.
CREATE TABLE IF NOT EXISTS chain_size_snapshots (
  ts INTEGER PRIMARY KEY,
  size_bytes INTEGER
);

-- peers
CREATE TABLE IF NOT EXISTS peer_snapshots (
  ts INTEGER PRIMARY KEY,
  total INTEGER, hidden INTEGER, pruned INTEGER,
  lagging INTEGER, stale INTEGER, divergent INTEGER,
  avg_lag REAL, avg_peer_view REAL, avg_conn_age INTEGER,
  new_conns INTEGER, bytes_recv INTEGER, bytes_sent INTEGER
);
CREATE TABLE IF NOT EXISTS node_versions (date TEXT, version TEXT, peer_count INTEGER, pruned_count INTEGER, PRIMARY KEY (date, version));
-- hourly tag / IP-prefix concentration rollups
CREATE TABLE IF NOT EXISTS daily_peer_tags (date TEXT, tag TEXT, peers INTEGER, PRIMARY KEY (date, tag));
CREATE TABLE IF NOT EXISTS daily_peer_prefixes (date TEXT, prefix TEXT, peers INTEGER, PRIMARY KEY (date, prefix));
-- hourly peer country concentration from GeoIP (aggregates only, no raw addresses stored)
CREATE TABLE IF NOT EXISTS daily_peer_countries (
  date TEXT, country TEXT, country_code TEXT, peers INTEGER,
  PRIMARY KEY (date, country)
);