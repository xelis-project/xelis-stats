# XELIS Stats

Statistics platform for XELIS blockchain.

- Price history from multiple markets.
- Complete indexed blockchain (blocks, txs and accounts).
- Multiple aggregate functions with time intervals.
- Display data using classic table or visualize it with charts.
- Configurable parameters for in-depth data representation.

<https://stats.xelis.io>

A website using Xelis Index to provide accessible statistics of the Xelis network.

Testnet: <https://testnet-stats.xelis.io>

## Development

For development this app uses the `g45-react` package to bundle and serve app.
Simply run `npm start` to build, start the dev server and watch modified files automatically.
For environment variables, it will create a `bundler-define.json` file and check in the `env` folder.  

## Production

The app is served by cloudflare and uses `cf_build.sh` to build from a specific branch.
Pushing branch `testnet-pages` or `mainnet-pages` will automatically build and deploy to cloudflare.

To build for nodejs run `npm run build-prod:node`.
