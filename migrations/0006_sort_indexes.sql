-- Composite sort indexes for the hot database.
--
-- The list pages sort with a stable `ORDER BY <col> <dir>, <tiebreak> <dir>`
-- (the tiebreak follows the sort direction). Without a matching index SQLite
-- does a full scan plus a temp B-tree sort (tens of seconds over millions of
-- rows); with it the query is an ordered index scan that stops after the page
-- size. A `(sort key, tiebreak)` index serves ASC via a forward scan and DESC
-- via a reverse scan. These are mirrored in SHARD_SCHEMA
-- (src/server/shards.ts) for newly created shards.
CREATE INDEX IF NOT EXISTS idx_blocks_ts_topo ON blocks(ts, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_tx_count_topo ON blocks(tx_count, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_difficulty_topo ON blocks(difficulty, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_reward_topo ON blocks(miner_reward, topoheight);
CREATE INDEX IF NOT EXISTS idx_blocks_type_topo ON blocks(block_type, topoheight);

-- tx_index default order is block_topo DESC, hash DESC; the composite index is
-- both the sort index and the keyset cursor for deep transaction browsing.
CREATE INDEX IF NOT EXISTS idx_tx_block_hash ON tx_index(block_topo, hash);
CREATE INDEX IF NOT EXISTS idx_tx_ts_hash ON tx_index(ts, hash);
CREATE INDEX IF NOT EXISTS idx_tx_fee_hash ON tx_index(fee, hash);
CREATE INDEX IF NOT EXISTS idx_tx_type_hash ON tx_index(tx_type, hash);
CREATE INDEX IF NOT EXISTS idx_tx_sender_hash ON tx_index(sender, hash);
CREATE INDEX IF NOT EXISTS idx_tx_executed_hash ON tx_index(executed, hash);
