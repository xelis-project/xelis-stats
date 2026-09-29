# xelis-explorer

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

The contract page can reconstruct Silex source from a deployed module. The
decompiler is the upstream `silex-decompiler` compiled to wasm; the built
artifacts live in `public/decompiler/` and are committed, so `npm run build` and
deploys need no Rust toolchain. Rebuild them with `npm run decompiler:wasm`
(needs Rust nightly with `rust-src`, `wasm-pack` and a wasm-capable clang).

1. Create the Cloudflare resources once and fill in the ids in
   `wrangler.jsonc` (the `TODO_CREATE_WITH_WRANGLER` placeholders):

   ```sh
   npx wrangler d1 create xelis-explorer
   npx wrangler kv namespace create KV
   ```

   `XELIS_EXPLORER_DB_ID` must be the hot D1 database uuid (same as
   `database_id`).

2. Apply the schema to the remote database:

   ```sh
   npx wrangler d1 migrations apply xelis-explorer --remote
   ```

3. Optional — D1 shard rotation (the 10 GB per-database workaround). Without
   these secrets rotation is disabled and the app runs in single-DB mode. Use
   an API token scoped to D1 edit on this account:

   ```sh
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   ```

   Hash lookups check the hot table and then fan out over the sealed shards.
   Cross-shard aggregate pages cache the immutable
   sealed-shard contribution in KV (`shardagg:*`, 30-day TTL), so each request
   scans only the hot window; the cache is keyed by `hotFloor`, so sealing a new
   shard starts fresh keys.

4. Deploy and verify:

   ```sh
   npm run deploy
   npm run preview
   ```

For local development, secrets go in `.dev.vars` (gitignored).

### Cron error logs

The public `/api/cron` endpoint and the `/status` panel only report pass/fail,
durations, and fail streaks — never error text. Failed scheduled jobs log a
structured `{ event: "cron_job_failed", job, ms, error }` record instead, which
Workers Logs captures because `observability.enabled` is set in
`wrangler.jsonc`. View and filter them in the Cloudflare dashboard under
**Workers & Pages → xelis-explorer → Observability** (query `event = "cron_job_failed"`),
or via a `wrangler tail`. For external shipping, use Logpush or OpenTelemetry
export; Workers Logs retention is 3 days on Free and 7 days on Paid.

### Scripts

| Command                      | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `npm run backfill`         | Resumable local historical scan (SQLite)   |
| `npm run backfill:monitor` | Backfill progress and ETA                  |
| `npm run export`           | Export the live local D1 to D1 SQL / R2 JSONL chunks |
| `npm run import:history`   | Import legacy market + chain-size CSV into D1 SQL |
| `npm run import:d1`        | Apply migrations and load `export/*.sql` into D1 |
| `npm run decompiler:wasm`  | Rebuild the Silex decompiler wasm under `public/decompiler` |

One-shot legacy/rebuild helpers live in `scripts/legacy/`. You only need
`contracts` to seed the contract registry ahead of the tx pass, and
`import:history` when rebuilding from the old Postgres cluster; neither runs
during normal operation.

### Export and D1 import

`npm run export` reads the live local D1 SQLite that `npm run dev` writes and
produces the D1 SQL artifacts in `export/`. Set `BACKFILL_DB` to export from a
standalone backfill file instead. Apply the artifacts with:

```sh
npm run import:d1 -- --remote     # deployed D1
npm run import:d1                 # local Miniflare D1, incremental
```

`--reset` wipes the local target `.wrangler/state/v3/d1` first (stop dev/preview
first). It is refused when the source resolves to that same local D1, so it only
applies alongside an explicit `BACKFILL_DB`. Prefer it after a fresh backfill:
the aggregate tables are exported with `INSERT OR IGNORE`, so an incremental
import never refreshes aggregate rows already present in an existing DB. The script also
seeds the `live_blocks`/`live_txs` cursors to the source top (max topoheight) so the collector
resumes from the top instead of re-walking history. Use `--only=a,b`, `--dry-run`,
`--no-seed`, or `--cursor=N` to control a run.

Large dumps (`blocks`, `tx`) are split by both scripts: `wrangler d1 execute
--file` rejects files above 2 GiB, so `npm run export` writes
`blocks.000.sql`, `blocks.001.sql`, … once a dump passes 1 GB (override with
`EXPORT_CHUNK_BYTES`), and `npm run import:d1` applies the parts in order.
Small dumps keep their plain `<name>.sql` name, and `--only=blocks` works with
either form.

#### Oversized local D1 (shard bootstrap)

Once the local SQLite passes D1's 10 GB per-database hardcap it can never be
imported as one database, and `rotateShards` cannot rescue it — rotation only
moves rows already inside the hot DB. Lay the history out across databases from
the start instead:

```sh
npm run bootstrap:shards -- \
  --ranges=0-2999999,3000000-5999999 \
  --remote
```

Each `--ranges` entry (ordered, contiguous, inclusive topoheight ranges) becomes
its own sealed shard database: `bootstrap_shards.mts` creates it
(`wrangler d1 create`), applies the shard schema, exports that range with
`export.mts --lo/--hi --no-aggregates`, loads it with `import_d1.mts --db`, then
writes the `shards` registry rows into the hot DB. The hot window (everything
above the last range) plus all aggregate tables is then exported and imported
into the hot DB, and the live cursors are seeded to the source tip. Pick range
boundaries so each shard stays under `SHARD_MAX_BYTES` (8 GB); at ~9M blocks two
or three ranges are typical. `--remote` is required (the Worker reaches shards
by uuid through the Cloudflare API, so local Miniflare shards are not routable);
pass `--dry-run` first to print the plan, which works without `--remote`.

The export range flags are also usable directly: `--lo=N --hi=N` slices the
blocks/tx dumps (and the tx-linked join tables) to an inclusive range,
`--no-aggregates` omits the aggregate tables, and `--include-null` keeps the
orphaned (NULL `block_topo`) txs that only the hot export should carry.

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
npx wrangler d1 migrations apply xelis-explorer --remote
npx wrangler d1 execute xelis-explorer --file export/exchanges.sql --remote
npx wrangler d1 execute xelis-explorer --file export/market_snapshots.sql --remote
npx wrangler d1 execute xelis-explorer --file export/chain_size_snapshots.sql --remote
```

`blockchain_size` is real on-disk chain growth sampled from the node, which
can't be reconstructed without replaying the chain, so the import extends the
live `chain_size_snapshots` series (cron keeps only the last 365 days) back to
2024-05. `market_tickers` is exchange price history the node can't provide;
`market_history` in the legacy DB is empty and unused.
