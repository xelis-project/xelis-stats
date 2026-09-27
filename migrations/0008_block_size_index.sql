-- Composite sort index for the blocks "Size" column (hot database).
--
-- `idx_blocks_size_topo` was added to migrations/0001_init.sql after that
-- migration had already been applied, so the live database never received it:
-- `wrangler d1 migrations apply` tracks applied migrations by filename and does
-- not re-run 0001_init.sql. This standalone migration creates it on existing
-- databases. The same `(sort key, tiebreak)` shape serves
-- `ORDER BY size ASC, topoheight ASC` via a forward index scan and
-- `ORDER BY size DESC, topoheight DESC` via a reverse scan.
CREATE INDEX IF NOT EXISTS idx_blocks_size_topo ON blocks(size, topoheight);
