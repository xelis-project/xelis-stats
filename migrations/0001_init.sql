-- Xelis Stats — D1 schema (Cloudflare live side)
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

CREATE TABLE IF NOT EXISTS tx_index (
  hash TEXT PRIMARY KEY, block_topo INTEGER, ts INTEGER,
  fee INTEGER, size INTEGER, tx_type TEXT, sender TEXT,
  transfer_count INTEGER, version INTEGER, multisig INTEGER, contract_id TEXT,
  gas INTEGER, result TEXT, encrypted INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tx_block ON tx_index(block_topo);
CREATE INDEX IF NOT EXISTS idx_tx_sender ON tx_index(sender);
CREATE INDEX IF NOT EXISTS idx_tx_type_ts ON tx_index(tx_type, ts);

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

CREATE TABLE IF NOT EXISTS daily_miners (
  date TEXT, address TEXT, blocks_found INTEGER, rewards_earned INTEGER,
  PRIMARY KEY (date, address)
);

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

CREATE TABLE IF NOT EXISTS mempool_snapshots (ts INTEGER PRIMARY KEY, size INTEGER);

-- archive export tracking (R2 chunks + publication status)
CREATE TABLE IF NOT EXISTS archive_manifests (
  chunk_key TEXT PRIMARY KEY, table_name TEXT, topo_start INTEGER, topo_end INTEGER,
  checksum TEXT, schema_version TEXT, record_count INTEGER, status TEXT, published_at INTEGER
);

-- ingestion failure tracking for inspection/retry
CREATE TABLE IF NOT EXISTS ingestion_failures (
  stage TEXT, record_id TEXT, error_class TEXT, message TEXT,
  retries INTEGER DEFAULT 0, resolved INTEGER DEFAULT 0, first_seen INTEGER, last_seen INTEGER,
  PRIMARY KEY (stage, record_id)
);

CREATE TABLE IF NOT EXISTS node_versions (date TEXT, version TEXT, peer_count INTEGER, PRIMARY KEY (date, version));
