import { Hono } from "hono";
import type { Env } from "./app";
import { layout, escHtml } from "../client/layout";
import { getStatsCached } from "./cache";

export const docs = new Hono<{ Bindings: Env }>();

const ENDPOINTS: Array<[string, string, string]> = [
  ["GET", "/api/stats", "Aggregated chain overview (KV-cached 60s)"],
  ["GET", "/api/summary", "Compact full-state JSON — AI/agent friendly"],
  ["GET", "/api/market", "Aggregated XEL market data + per-exchange tickers"],
  ["GET", "/api/live", "Live unstable node data (unindexed, uncached): info, DAG window, mempool, fee rates"],
  ["GET", "/api/blocks?before=&type=&limit=&sort=&dir=", "Blocks (D1). ?type filters block_type (Normal|Side|Sync). ?sort runs over the full dataset: topo|hash|time|txs|difficulty|reward|type"],
  ["GET", "/api/transactions?before=&type=&limit=&sort=&dir=", "Transactions (D1). ?sort over the full dataset: block|time|type|sender|transfers|fee|executed. Responses include transfer_count (transfer outputs per tx)"],
  ["GET", "/api/accounts?sort=&dir=&limit=", "Observed senders. ?sort: address|first|last|txs|transfers (legacy active|txs). Responses include transfer_count (transfer outputs summed per sender)"],
  ["GET", "/api/node-versions", "Peer count + pruned count by node version (latest hourly snapshot)"],
  ["GET", "/api/peers", "Latest peer network snapshot (counts, lag, staleness, divergence, tags, prefixes, GeoIP countries) + node versions"],
  ["GET", "/api/cron", "Scheduled-job health: latest outcome per job + 7-day run history (mounted at /status)"],
  ["GET", "/api/history/:metric?range=7d|30d|90d|1y|all&interval=day|week|month|year&format=json|csv", "Time-series. Metrics: txs, transfers, accounts, active-accounts, miners, hashrate, difficulty, cum-difficulty, hashprice, fees, fee-p90, supply, burned-supply, market-cap, miner-rev-usd, miner-revenue, side-blocks, block-time, nakamoto, gini, encrypted, block-types, txs-transfer, txs-burn, txs-invoke, txs-deploy, txs-multisig, tx-types, contract-invokes, contract-gas, contract-deploys, active-contracts, price, quote-volume, mempool, chain-size, peers, peers-hidden, peers-pruned, peers-lagging, peers-stale, peers-divergent, peers-new, peer-lag, peer-view, peer-age, peer-traffic-in, peer-traffic-out"],
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
  // read the cached stats directly instead of making a subrequest to /api/summary
  let s: { topoheight?: number; stable_topoheight?: number; network?: string; node_version?: string } | null = null;
  try {
    const stats = await getStatsCached(c.env);
    s = {
      topoheight: stats.info.topoheight,
      stable_topoheight: stats.info.stable_topoheight,
      network: stats.info.network,
      node_version: stats.info.version,
    };
  } catch { /* node unreachable */ }
  const lag = s?.topoheight && s?.stable_topoheight ? s.topoheight - s.stable_topoheight : null;

  // indexing checkpoints written by the cron-driven collector
  const sync = await c.env.DB.prepare("SELECT stage, cursor, updated_at FROM sync_state").all<{ stage: string; cursor: number; updated_at: number }>().catch(() => null);
  const syncRows = sync?.results ?? [];
  const byStage = new Map(syncRows.map((r) => [r.stage, r]));
  const stable = s?.stable_topoheight ?? 0;
  const age = (ts?: number) => ts ? `${Math.max(0, Math.round((Date.now() - ts) / 1000))}s ago` : "—";
  const cursorRow = (stage: string) => {
    const r = byStage.get(stage);
    if (!r) return "—";
    const behind = stable ? stable - r.cursor : null;
    return `${r.cursor.toLocaleString()}${behind !== null && behind > 0 ? ` (${behind} behind stable)` : " (up to date)"}`;
  };

  const kv = (k: string, v: string) => `<tr><td>${escHtml(k)}</td><td>${escHtml(v)}</td></tr>`;

  const nodeRows = [
    ["Network", s?.network ?? "—"],
    ["Node version", s?.node_version ?? "—"],
    ["Topoheight", s?.topoheight?.toLocaleString() ?? "—"],
    ["Stable topoheight", s?.stable_topoheight?.toLocaleString() ?? "—"],
    ["Stability lag", lag !== null ? `${lag} topoheights` : "—"],
  ].map(([k, v]) => kv(k, v)).join("");

  const indexerRows = [
    ["Blocks cursor", cursorRow("live_blocks")],
    ["Blocks checkpoint", age(byStage.get("live_blocks")?.updated_at)],
    ["Tx enrichment cursor", cursorRow("live_txs")],
    ["Tx checkpoint", age(byStage.get("live_txs")?.updated_at)],
    ["Indexer WS", "see live dot in header"],
  ].map(([k, v]) => kv(k, v)).join("");

  // scheduled-job health written by handleCron after every invocation
  const cron = await c.env.DB.prepare(
    "SELECT job, last_ts, last_ok, last_ms, last_error, fail_streak FROM cron_jobs ORDER BY job"
  ).all<{ job: string; last_ts: number; last_ok: number; last_ms: number; last_error: string | null; fail_streak: number }>().catch(() => null);
  const cronJobs = cron?.results ?? [];
  const newest = cronJobs.reduce((m, r) => Math.max(m, Number(r.last_ts)), 0);
  const stalled = newest > 0 && Date.now() - newest > 10 * 60_000;
  const failing = cronJobs.filter((r) => !Number(r.last_ok)).length;
  const cronHealth = !cronJobs.length
    ? '<span class="badge">no data</span>'
    : stalled
      ? '<span class="badge fail">stalled</span>'
      : failing
        ? `<span class="badge fail">${failing} failing</span>`
        : '<span class="badge ok">healthy</span>';
  const ago = (ts: number) => `${Math.max(0, Math.round((Date.now() - Number(ts)) / 1000))}s ago`;
  const cronRows = cronJobs.length
    ? cronJobs.map((r) => `<tr>
        <td class="mono">${escHtml(r.job)}</td>
        <td><span class="badge ${Number(r.last_ok) ? "ok" : "fail"}">${Number(r.last_ok) ? "ok" : "failed"}</span></td>
        <td>${ago(r.last_ts)}</td>
        <td>${Number(r.last_ms).toLocaleString()} ms</td>
        <td>${Number(r.fail_streak) > 0 ? `<span style="color:var(--danger)">${r.fail_streak}</span>` : "0"}</td>
        <td style="white-space:normal;color:var(--text-dim)">${r.last_error ? escHtml(r.last_error) : ""}</td>
      </tr>`).join("")
    : '<tr><td colspan="6" style="color:var(--text-dim)">No cron runs recorded yet.</td></tr>';
  const cronPanel = `<div class="panel" style="margin-top:1rem"><h2>Scheduled jobs ${cronHealth}</h2>
    <div class="tablewrap"><table><thead><tr><th>Job</th><th>Status</th><th>Last run</th><th>Duration</th><th>Fail streak</th><th>Last error</th></tr></thead><tbody>${cronRows}</tbody></table></div>
    <p style="color:var(--text-dim);margin-top:.75rem">Latest invocation ${newest ? ago(newest) : "—"} · 7-day run history at <span class="mono">/api/cron</span></p>
  </div>`;

  const content = `<div class="grid-2">
    <div class="panel"><h2>Node</h2><table class="kv">${nodeRows}</table></div>
    <div class="panel"><h2>Indexing</h2><table class="kv">${indexerRows}</table></div>
  </div>
  ${cronPanel}`;
  return c.html(layout("Status", content, ""));
});

docs.get("/favicon.svg", (c) => c.body(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><circle cx="500" cy="500" r="500" fill="#02ffcf"/><g fill="#000" transform="translate(111 128.5)"><path fill-rule="evenodd" clip-rule="evenodd" d="M388.909 742.872L777.817 353.964L424.056 0.202599L478.809 132.737L700.036 353.964L388.909 665.091L77.7817 353.964L299.507 129.121L353.964 0L0 353.964L388.909 742.872Z"/><path d="M388.909 665.091L353.964 0L299.507 129.121L388.909 665.091Z"/><path d="M424.056 0.202599L388.909 665.091L478.809 132.737L424.056 0.202599Z"/></g></svg>`,
  200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600" }
));
