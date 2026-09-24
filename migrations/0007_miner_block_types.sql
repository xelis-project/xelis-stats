-- Per-miner block-type breakdown for the miners leaderboard.
-- daily_miners.blocks_found counts every block a miner produced regardless of
-- type (Normal + Side + Sync). side_count/sync_count break out the non-normal
-- share so the leaderboard can show it without re-scanning the raw blocks table
-- (which is sharded once the 10GB cap nears). Normal = blocks_found - side - sync.
ALTER TABLE daily_miners ADD COLUMN side_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_miners ADD COLUMN sync_count INTEGER NOT NULL DEFAULT 0;