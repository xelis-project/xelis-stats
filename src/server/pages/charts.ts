import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { icons } from "../../client/icons";
import { logErr } from "./shared";

// metrics with special filters
const FEE_METRICS: Record<string, string> = { fees: "avg", "fees-median": "median", "fee-p90": "p90", "fees-p99": "p99" };
const MARKET_METRICS = new Set(["price", "quote-volume"]);

// curated metric -> label list shared by the charts hub
export const CHART_METRICS: Array<[string, string]> = [
  ["txs", "Transactions/day"], ["accounts", "Accounts growth"], ["active-accounts", "Active accounts"], ["miners", "Miners"],
  ["hashrate", "Hashrate"], ["difficulty", "Difficulty"], ["cum-difficulty", "Cumulative difficulty"],
  ["transfers", "Transfers"], ["fees", "Fees"], ["supply", "Supply"],
  ["burned-supply", "Burned supply"], ["chain-size", "Blockchain size"], ["market-cap", "Market Cap"], ["block-types", "Block types"],
  ["txs-transfer", "Tx: transfers"], ["txs-burn", "Tx: burns"], ["txs-invoke", "Tx: contract invokes"],
  ["txs-deploy", "Tx: contract deploys"], ["txs-multisig", "Tx: multisig"], ["tx-types", "Tx types"],
  ["contract-invokes", "Contract invokes"], ["contract-gas", "Contract gas"], ["contract-deploys", "Contract deploys"],
  ["active-contracts", "Active contracts"],
  ["price", "XEL price"], ["quote-volume", "Quote volume"],
  ["miner-revenue", "Miner revenue"], ["miner-rev-usd", "Miner revenue (USDT)"], ["hashprice", "Hashprice (USD/TH/day)"],
  ["block-time", "Block time"], ["nakamoto", "Nakamoto coefficient"], ["gini", "Production Gini"], ["encrypted", "Encrypted txs"],
  ["mempool", "Mempool"], ["peers", "Peer count"], ["peers-pruned", "Pruned peers"],
];

export const charts = new Hono<{ Bindings: Env }>();

charts.get("/charts", async (c) => {
  const metrics = CHART_METRICS;
  // whitelist every selector param before it reaches links/attributes
  const metricParam = c.req.query("metric") ?? "txs";
  const metric = metrics.some(([m]) => m === metricParam) ? metricParam : "txs";
  const rangeParam = c.req.query("range") ?? "90d";
  const range = ["7d", "30d", "90d", "1y", "all", "custom"].includes(rangeParam) ? rangeParam : "90d";
  const intervalParam = c.req.query("interval") ?? "day";
  const interval = ["day", "week", "month", "year"].includes(intervalParam) ? intervalParam : "day";
  // strict YYYY-MM-DD validation doubles as HTML-attribute sanitization
  const isDate = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDate(c.req.query("from")) ? c.req.query("from")! : "";
  const to = isDate(c.req.query("to")) ? c.req.query("to")! : "";
  const custom = range === "custom";
  const cum = c.req.query("cum") === "1";
  const log = c.req.query("log") === "1";
  const chartType = c.req.query("type") === "bar" ? "bar" : "line";

  const metricOpts = metrics.map(([m, name]) => `<option value="${m}" ${metric === m ? "selected" : ""}>${name}</option>`).join("");
  const rangeOpts = ["7d", "30d", "90d", "1y", "all", "custom"].map((r) => `<option value="${r}" ${range === r ? "selected" : ""}>${r === "custom" ? "custom period" : r}</option>`).join("");
  const intervalOpts = ["day", "week", "month", "year"].map((i) => `<option value="${i}" ${interval === i ? "selected" : ""}>${i}</option>`).join("");

  const feeStatOpts = ["fees", "fees-median", "fee-p90", "fees-p99"].map((m) => `<option value="${m}" ${metric === m ? "selected" : ""}>${FEE_METRICS[m]}</option>`).join("");

  const exchangeParam = (c.req.query("exchange") ?? "").replace(/[^\w .-]/g, "").slice(0, 64);
  let exchanges: string[] = [];
  try {
    // registry first (curated order, active feeds ahead of retired ones), with a
    // fallback to whatever the snapshots contain if it hasn't been seeded
    const rows = await c.env.DB.prepare("SELECT name FROM exchanges ORDER BY (status = 'active') DESC, name").all<{ name: string }>();
    exchanges = (rows.results ?? []).map((r) => r.name).filter((e) => e && e.length <= 64);
    if (!exchanges.length) {
      const distinct = await c.env.DB.prepare("SELECT DISTINCT exchange FROM market_snapshots ORDER BY exchange").all<{ exchange: string }>();
      exchanges = (distinct.results ?? []).map((r) => r.exchange).filter((e) => e && e.length <= 64);
    }
  } catch (err) { logErr("page/charts", err); }
  const exchange = exchanges.includes(exchangeParam) ? exchangeParam : "";
  const exchangeOpts = ['<option value="">all exchanges</option>', ...exchanges.map((e) => `<option value="${e}" ${exchange === e ? "selected" : ""}>${e}</option>`)].join("");

  const compareParam = c.req.query("compare") ?? "";
  const compare = metrics.some(([m]) => m === compareParam) && compareParam !== metric ? compareParam : "";
  const compareOpts = ['<option value="">no compare</option>', ...metrics.filter(([m]) => m !== metric).map(([m, name]) => `<option value="${m}" ${compare === m ? "selected" : ""}>${name}</option>`)].join("");

  const periodQuery = custom
    ? new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()
    : `range=${range}`;
  const csvQuery = new URLSearchParams(periodQuery);
  csvQuery.set("interval", interval);
  csvQuery.set("format", "csv");
  if (MARKET_METRICS.has(metric) && exchange) csvQuery.set("exchange", exchange);
  const csvHref = `/api/history/${metric}?${csvQuery.toString()}`;

  const content = `
    <div class="panel">
      <div style="display:flex;gap:0.8rem;margin-bottom:1rem;align-items:center;flex-wrap:wrap">
        <select id="sel-metric" title="Metric">${metricOpts}</select>
        <select id="sel-feestat" title="Fee statistic" ${FEE_METRICS[metric] ? "" : "hidden"}>${feeStatOpts}</select>
        <select id="sel-range" title="Period">${rangeOpts}</select>
        <input type="text" class="period" data-datepicker id="inp-from" value="${from}" aria-label="Period start" ${custom ? "" : "hidden"} />
        <span id="period-sep" aria-hidden="true" style="color:var(--text-dim)" ${custom ? "" : "hidden"}>${icons.arrowRight}</span>
        <input type="text" class="period" data-datepicker id="inp-to" value="${to}" aria-label="Period end" ${custom ? "" : "hidden"} />
        <select id="sel-interval" title="Bucket interval">${intervalOpts}</select>
        <select id="sel-exchange" title="Exchange" ${MARKET_METRICS.has(metric) ? "" : "hidden"}>${exchangeOpts}</select>
        <select id="sel-compare" title="Overlay a second metric">${compareOpts}</select>
        <label class="chk" title="Show running total instead of per-bucket value"><input type="checkbox" id="chk-cum" ${cum ? "checked" : ""}/> cum</label>
        <label class="chk" title="Logarithmic Y axis"><input type="checkbox" id="chk-log" ${log ? "checked" : ""}/> log</label>
        <select id="sel-type" title="Chart type">
          <option value="line" ${chartType === "line" ? "selected" : ""}>line</option>
          <option value="bar" ${chartType === "bar" ? "selected" : ""}>bar</option>
        </select>
        <a class="btn ghost" id="btn-csv" href="${csvHref}">CSV</a>
      </div>
      <div id="u-chart" style="height:320px"></div>
    </div>`;
  return c.html(layout("Charts", content, "/charts"));
});
