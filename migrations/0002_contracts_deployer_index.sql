-- Per-deployer contract lookup for the account page "Contracts Deployed" panel.
-- 0001_init.sql already carries this for fresh databases; this migration applies
-- it to databases created before the index was added.
CREATE INDEX IF NOT EXISTS idx_contracts_deployer ON contracts(deployer);
