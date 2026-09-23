-- Peer network statistics
CREATE TABLE IF NOT EXISTS peer_snapshots (
  ts INTEGER PRIMARY KEY,
  total INTEGER, hidden INTEGER, pruned INTEGER,
  lagging INTEGER, stale INTEGER, divergent INTEGER,
  avg_lag REAL, avg_peer_view REAL, avg_conn_age INTEGER,
  new_conns INTEGER, bytes_recv INTEGER, bytes_sent INTEGER
);

-- pruned node count per version
ALTER TABLE node_versions ADD COLUMN pruned_count INTEGER;

-- hourly tag / IP-prefix concentration rollups
CREATE TABLE IF NOT EXISTS daily_peer_tags (date TEXT, tag TEXT, peers INTEGER, PRIMARY KEY (date, tag));
CREATE TABLE IF NOT EXISTS daily_peer_prefixes (date TEXT, prefix TEXT, peers INTEGER, PRIMARY KEY (date, prefix));
