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
