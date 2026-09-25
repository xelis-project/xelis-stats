-- All-time transfer outputs per observed sender, denormalized like tx_count so
-- the accounts list can show and sort transfers without aggregating tx_index.
-- tx_index is only partially resident in the hot DB once shard rotation seals
-- older rows, so an on-the-fly SUM(sender) would silently under-report.
ALTER TABLE accounts ADD COLUMN transfer_count INTEGER DEFAULT 0;

-- Composite sort index for ORDER BY transfer_count DESC, address DESC.
CREATE INDEX IF NOT EXISTS idx_accounts_transfer_count ON accounts(transfer_count, address);

-- Backfill existing rows from the hot tx_index window. On a sharded database
-- this only covers the hot window; a rebuild via `npm run export` +
-- `npm run import:d1` (scripts/backfill.mts derives the column from full local
-- history) yields all-time totals, and the collector keeps it current going
-- forward.
UPDATE accounts SET transfer_count = (
  SELECT COALESCE(SUM(t.transfer_count), 0) FROM tx_index t WHERE t.sender = accounts.address
);
