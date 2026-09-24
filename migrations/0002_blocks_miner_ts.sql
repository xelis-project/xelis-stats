-- Composite miner + time index.
-- The miner profile computes 24h hashrate with
--   SELECT SUM(difficulty), COUNT(*) FROM blocks WHERE miner_address = ? AND ts > ?
-- With only idx_blocks_miner(miner_address) SQLite narrows to every block the
-- address ever mined and then fetches each row to test `ts`; for a top miner
-- that is millions of row lookups to keep a few hundred rows. This index lets
-- the range be resolved in the index instead. Mirrored in SHARD_SCHEMA
-- (src/server/shards.ts) for newly created shards.
CREATE INDEX IF NOT EXISTS idx_blocks_miner_ts ON blocks(miner_address, ts);
