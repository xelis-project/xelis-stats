-- Index transfer destinations as observed accounts.
--
-- On Xelis the transfer amounts and account balances are encrypted, but the
-- transfer destination addresses and asset ids are plaintext tx-payload fields
-- (the flow is public; only the amounts are hidden, and a sender can obfuscate
-- the flow further by splitting into multiple zero-amount transfers). Receiver
-- addresses were previously dropped, so an address that only ever received
-- (never sent, never mined) had no row here.
--
-- received_count is the all-time number of transfer outputs received by the
-- address, the counterpart to transfer_count (outputs sent). tx_count stays
-- sent-only, so sender-based metrics (active senders, top senders) are unchanged.
ALTER TABLE accounts ADD COLUMN received_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_accounts_received_count ON accounts(received_count, address);
