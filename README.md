# xelis-stats

Charts and stats for the Xelis network, built with Vite, Hono, and uPlot. Runs on Cloudflare Workers (D1 + KV + R2 + Durable Objects).

## What it does

- Live chain dashboard with blocks, hashrate, supply, and market data
- Block and transaction browsing, account activity, search
- Core charts: block production, hashrate, activity, fees, supply, market history
- Miner rankings and daily aggregates, with CSV export

## Usage

```sh
npm install
npm run dev       # local dev server
npm run preview   # preview the Worker build
npm run deploy    # deploy to Cloudflare
```

### Scripts

| Command                      | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `npm run backfill`         | Resumable local historical scan (SQLite)   |
| `npm run backfill:monitor` | Backfill progress and ETA                  |
| `npm run export`           | Export history to D1 SQL / R2 JSONL chunks |
| `npm run import:history`   | Import legacy market + chain-size CSV into D1 SQL |

### Legacy Postgres history

The pre-Cloudflare stats database is a PostgreSQL 16 data directory (not a
dump). Export the two useful tables to CSV, then transform them into the current
D1 schema:

```sh
# from a PG cluster containing the legacy database (single-user mode avoids
# needing a running server). ts columns are Unix seconds in the legacy schema.
postgres --single -D <pgdata> postgres <<'SQL'
COPY (SELECT exchange, asset, timestamp, price, high, low, volume
      FROM market_tickers ORDER BY timestamp, exchange)
  TO '/tmp/market_tickers.csv' WITH (FORMAT csv, HEADER);
COPY (SELECT height, timestamp, size_in_bytes
      FROM blockchain_size ORDER BY timestamp)
  TO '/tmp/blockchain_size.csv' WITH (FORMAT csv, HEADER);
SQL

npm run import:history -- --tickers=/tmp/market_tickers.csv --chain-size=/tmp/blockchain_size.csv
npx wrangler d1 migrations apply xelis-stats --remote
npx wrangler d1 execute xelis-stats --file export/exchanges.sql --remote
npx wrangler d1 execute xelis-stats --file export/market_snapshots.sql --remote
npx wrangler d1 execute xelis-stats --file export/chain_size_snapshots.sql --remote
```

`blockchain_size` is real on-disk chain growth sampled from the node, which
can't be reconstructed without replaying the chain, so the import extends the
live `chain_size_snapshots` series (cron keeps only the last 365 days) back to
2024-05. `market_tickers` is exchange price history the node can't provide;
`market_history` in the legacy DB is empty and unused.
