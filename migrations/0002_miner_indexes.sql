-- Per-address miner lookups (miner profile page, account page, search)
CREATE INDEX IF NOT EXISTS idx_blocks_miner ON blocks(miner_address);
CREATE INDEX IF NOT EXISTS idx_daily_miners_addr ON daily_miners(address);
