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
