-- Partial indexes for per-contract invoke counts (contract page) and per-asset
-- burn totals (asset page). Both previously scanned tx_index. Mirrored in SHARD_SCHEMA.
CREATE INDEX IF NOT EXISTS idx_tx_contract_id ON tx_index(contract_id, block_topo) WHERE contract_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_burn_asset ON tx_index(burn_asset) WHERE burn_asset IS NOT NULL;
