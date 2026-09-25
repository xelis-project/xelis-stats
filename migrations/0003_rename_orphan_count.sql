-- daily_stats.orphan_count was misnamed: the live rollup (cron.ts) counted only
-- Side blocks while the export pipeline counted every non-Normal block, which
-- wrongly included Sync. Rename it to side_count and count Side only.
ALTER TABLE daily_stats RENAME COLUMN orphan_count TO side_count;
