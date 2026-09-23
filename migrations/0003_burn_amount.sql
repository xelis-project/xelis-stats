-- Burn payloads are public on Xelis: the burned amount and asset are plaintext
-- on-chain (unlike transfer amounts). Persist them per tx so /tx pages can show
-- the amount; NULL burn_asset marks legacy rows still needing a backfill.
ALTER TABLE tx_index ADD COLUMN burn_amount INTEGER DEFAULT 0;
ALTER TABLE tx_index ADD COLUMN burn_asset TEXT;
