# xelis-stats

Charts and stats for the Xelis network, built with Vite, Hono, Preact, and uPlot. Runs on Cloudflare Workers (D1 + KV + R2 + Durable Objects).

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
