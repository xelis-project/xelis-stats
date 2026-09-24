-- On-disk chain (database) size snapshots, from the node's get_size_on_disk
-- RPC. Recorded by the cron alongside mempool/peer snapshots so the blockchain
-- size can be charted over time; the newest row is also the "current" size.
CREATE TABLE IF NOT EXISTS chain_size_snapshots (
  ts INTEGER PRIMARY KEY,
  size_bytes INTEGER
);
