-- Covering index for the block-detail 24h average reward:
--   SELECT AVG(miner_reward + dev_reward) FROM blocks WHERE ts > ?
-- Resolves entirely in the index (no per-row table fetches of wide blocks rows).
CREATE INDEX IF NOT EXISTS idx_blocks_ts_rewards ON blocks(ts, miner_reward, dev_reward);
