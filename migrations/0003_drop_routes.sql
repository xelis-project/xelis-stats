-- Remove the hash -> topo point-lookup routing cache. It was written eagerly on
-- every block/tx (the single largest D1 write cost) but only served hash-style
-- block/tx detail lookups, which now fall back to the hot table then a fan-out
-- over sealed shards.
DROP TABLE IF EXISTS tx_route;
DROP TABLE IF EXISTS block_route;
