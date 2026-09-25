import { Hono } from "hono";
import type { Env } from "./app";
import { layout } from "../client/layout";

export const docs = new Hono<{ Bindings: Env }>();

const ENDPOINTS: Array<[string, string, string]> = [
  ["GET", "/api/stats", "Aggregated chain overview (KV-cached 60s)"],
  ["GET", "/api/summary", "Compact full-state JSON — AI/agent friendly"],
  ["GET", "/api/market", "Aggregated XEL market data + per-exchange tickers"],
  ["GET", "/api/blocks?before=&type=&limit=&sort=&dir=", "Blocks (D1). ?type filters block_type (Normal|Side|Sync). ?sort runs over the full dataset: topo|hash|time|txs|difficulty|reward|type"],
  ["GET", "/api/transactions?before=&type=&limit=&sort=&dir=", "Transactions (D1). ?sort over the full dataset: block|time|type|sender|transfers|fee|executed. Responses include transfer_count (transfer outputs per tx)"],
  ["GET", "/api/accounts?sort=&dir=&limit=", "Observed senders. ?sort: address|first|last|txs (legacy active|txs)"],
  ["GET", "/api/node-versions", "Peer count + pruned count by node version (latest hourly snapshot)"],
  ["GET", "/api/peers", "Latest peer network snapshot (counts, lag, staleness, divergence, tags, prefixes, GeoIP countries) + node versions"],
  ["GET", "/api/history/:metric?range=7d|30d|90d|1y|all&interval=day|week|month|year&format=json|csv", "Time-series. Metrics: txs, transfers, accounts, active-accounts, miners, hashrate, fees, fee-p90, supply, burned-supply, market-cap, miner-rev-usd, miner-revenue, side-blocks, block-time, nakamoto, gini, encrypted, block-types, price, quote-volume, mempool, chain-size, peers, peers-hidden, peers-pruned, peers-lagging, peers-stale, peers-divergent, peers-new, peer-lag, peer-view, peer-age, peer-traffic-in, peer-traffic-out"],
  ["GET", "/api/top/:kind?period=day|week|month|all&date=&limit=&sort=&dir=", "Rankings: miners, senders, burners, assets, contracts (date defaults to latest indexed day)"],
  ["GET", "/api/tx/:hash", "Transaction detail"],
  ["GET", "/ws", "Live WebSocket: new_block events + 30s ticks"],
];

docs.get("/api/docs", (c) => {
  const rows = ENDPOINTS.map(([m, path, desc]) =>
    `<tr><td><span class="badge">${m}</span></td><td><span class="mono">${path}</span></td><td style="white-space:normal">${desc}</td></tr>`).join("");
  const content = `<div class="panel"><h2>Public API</h2>
    <p style="color:var(--text-dim);margin-bottom:1rem">All endpoints are public JSON (except format=csv). No key required. Rate limits apply.</p>
    <div class="tablewrap"><table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h2 style="margin-top:2rem">Example</h2>
    <pre class="mono" style="background:hsla(0,0%,100%,.04);padding:1rem;border-radius:.6rem;overflow-x:auto">curl https://&lt;host&gt;/api/summary</pre>
  </div>`;
  return c.html(layout("API", content, ""));
});

docs.get("/status", async (c) => {
  let stats: Record<string, unknown> | null = null;
  try {
    const res = await fetch(new URL("/api/summary", c.req.url));
    stats = (await res.json()) as Record<string, unknown>;
  } catch { /* ignore */ }

  const s = stats as null | { topoheight?: number; stable_topoheight?: number; network?: string; node_version?: string };
  const lag = s?.topoheight && s?.stable_topoheight ? s.topoheight - s.stable_topoheight : null;

  const rows = [
    ["Network", s?.network ?? "—"],
    ["Node version", s?.node_version ?? "—"],
    ["Topoheight", s?.topoheight?.toLocaleString() ?? "—"],
    ["Stable topoheight", s?.stable_topoheight?.toLocaleString() ?? "—"],
    ["Stability lag", lag !== null ? `${lag} topoheights` : "—"],
    ["Indexer WS", "see live dot in header"],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");

  const content = `<div class="panel"><h2>Status</h2><table class="kv">${rows}</table></div>`;
  return c.html(layout("Status", content, ""));
});

docs.get("/favicon.svg", (c) => c.body(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><circle cx="500" cy="500" r="500" fill="#02ffcf"/><g fill="#000" transform="translate(111 128.5)"><path fill-rule="evenodd" clip-rule="evenodd" d="M388.909 742.872L777.817 353.964L424.056 0.202599L478.809 132.737L700.036 353.964L388.909 665.091L77.7817 353.964L299.507 129.121L353.964 0L0 353.964L388.909 742.872Z"/><path d="M388.909 665.091L353.964 0L299.507 129.121L388.909 665.091Z"/><path d="M424.056 0.202599L388.909 665.091L478.809 132.737L424.056 0.202599Z"/></g></svg>`,
  200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" }
));
