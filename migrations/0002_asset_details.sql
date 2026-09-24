-- Asset detail page: registry metadata (max supply + owner) and supply history.

-- The node reports max_supply as "none" | { fixed: n } | { mintable: n } and
-- owner as "none" | { creator: { contract, id } }. Denormalize both so the
-- asset page (and list) can render them without a live RPC.
-- max_supply_kind is 'none' | 'fixed' | 'mintable'; max_supply is the cap in
-- atomic units (NULL when kind is 'none'). owner_contract/owner_asset_id
-- identify the creator contract and the asset's index within it (NULL when
-- unowned).
ALTER TABLE assets ADD COLUMN max_supply_kind TEXT;
ALTER TABLE assets ADD COLUMN max_supply INTEGER;
ALTER TABLE assets ADD COLUMN owner_contract TEXT;
ALTER TABLE assets ADD COLUMN owner_asset_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_assets_owner ON assets(owner_contract);

-- Supply history. get_asset_supply only returns the current minted amount (its
-- topoheight param is ignored), so the cron records snapshots itself. One row
-- per asset per hourly tick, written only when the value changes.
CREATE TABLE IF NOT EXISTS asset_supply_snapshots (
  ts INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  supply INTEGER NOT NULL,
  PRIMARY KEY (ts, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_supply_asset_ts ON asset_supply_snapshots(asset_id, ts);
