# xelis-stats

Charts and stats for the Xelis network, built with Vite, Hono, and uPlot. Runs on Cloudflare Workers (D1 + KV + Durable Objects).

## What it does

- Live chain dashboard with blocks, hashrate, supply, and market data
- Block and transaction browsing, account activity, search
- Core charts: block production, hashrate, activity, fees, supply, market history
- Miner rankings and daily aggregates, with CSV export

## Usage

```sh
npm install
npm run dev       # local dev server
npm run preview   # build + preview the Worker output locally
npm run deploy    # build + deploy to Cloudflare
```

## Deploy

The client bundle is built by Vite into the Worker's static assets; `npm run
deploy` runs `vite build` first. Deploying the Worker without a build ships a
site whose JavaScript entry does not exist, so always deploy via the script (or
run `npm run build` before `wrangler deploy`).

1. Create the Cloudflare resources once and fill in the ids in
   `wrangler.jsonc` (the `TODO_CREATE_WITH_WRANGLER` placeholders):

   ```sh
   npx wrangler d1 create xelis-stats
   npx wrangler kv namespace create KV
   ```

   `XELIS_STATS_DB_ID` must be the hot D1 database uuid (same as
   `database_id`).

2. Apply the schema to the remote database:

   ```sh
   npx wrangler d1 migrations apply xelis-stats --remote
   ```

3. Optional — D1 shard rotation (the 10 GB per-database workaround). Without
   these secrets rotation is disabled and the app runs in single-DB mode. Use
   an API token scoped to D1 edit on this account:

   ```sh
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   ```

4. Deploy and verify:

   ```sh
   npm run deploy
   npm run preview
   ```

For local development, secrets go in `.dev.vars` (gitignored).

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
