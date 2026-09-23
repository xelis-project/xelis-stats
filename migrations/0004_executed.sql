-- rename tx_index.result (TEXT 'ok'/'unexecuted') to executed (INTEGER 0/1)
ALTER TABLE tx_index RENAME COLUMN result TO executed;
UPDATE tx_index SET executed = CASE executed WHEN 'ok' THEN 1 WHEN 'unexecuted' THEN 0 ELSE NULL END;
