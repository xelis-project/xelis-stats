-- Cron job monitoring. cron_jobs keeps the latest outcome per named task so the
-- /status page can show which scheduled work is failing and how long it runs.
-- cron_runs is a bounded history (7 days, trimmed by the cron itself) of whole
-- invocations, letting the panel show success rate and stall/latency trends.
CREATE TABLE IF NOT EXISTS cron_jobs (
  job TEXT PRIMARY KEY,
  last_ts INTEGER NOT NULL,
  last_ok INTEGER NOT NULL,
  last_ms INTEGER NOT NULL,
  last_error TEXT,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  ok_total INTEGER NOT NULL DEFAULT 0,
  fail_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  schedule TEXT,
  duration_ms INTEGER NOT NULL,
  jobs INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  errors TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_ts ON cron_runs(ts);
