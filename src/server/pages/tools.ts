import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { icons } from "../../client/icons";

export const tools = new Hono<{ Bindings: Env }>();

// Tool index. Each entry maps to an SSR page below; the client island
// (src/client/tools.ts) fills the result panes on the individual tool pages.
const TOOLS = [
  {
    href: "/tools/fee-estimator",
    title: "Transaction fee estimator",
    desc: "Estimate a Xelis transaction fee from the transaction size, outputs, new addresses and multisig signatures, using live network fee rates.",
  },
  {
    href: "/tools/hashrate",
    title: "Mining hashrate / profitability",
    desc: "Estimate daily and monthly XEL mining rewards and net profit from your hashrate, power draw, electricity price and pool fee.",
  },
];

tools.get("/tools", (c) => {
  const cards = TOOLS.map((t) => `<a class="tool-card" href="${t.href}">
      <span class="tool-card-title">${t.title}</span>
      <span class="tool-card-desc">${t.desc}</span>
      <span class="tool-card-cta">Open tool ${icons.arrowRight}</span>
    </a>`).join("");

  const content = `<div class="panel calc-hero">
    <h2>Tools</h2>
    <p class="calc-intro">Calculators for Xelis fees and mining. Pick a tool below; each opens its own page with live network values.</p>
  </div>
  <div class="tool-cards">${cards}</div>`;

  return c.html(layout("Tools", content, "/tools"));
});

// Static shell for the calculators; the client island (src/client/tools.ts)
// fetches /api/summary and /api/fee-rates and fills the result panes.
tools.get("/tools/fee-estimator", (c) => {
  const content = `<p class="tool-back"><a href="/tools">${icons.arrowLeft} All tools</a></p>
  <div class="panel calc-panel" id="calc-fee">
    <div class="panel-head">
      <h2>Transaction fee estimator</h2>
      <button class="btn ghost calc-refresh" type="button" data-calc-refresh>Refresh</button>
    </div>
    <p class="calc-note">Fees are paid in XEL and combine a dynamic per-KiB storage fee with static per-output, per-new-address and per-signature fees. See the <a href="https://docs.xelis.io/features/transaction-fees" target="_blank" rel="noopener noreferrer">fee model</a>.</p>
    <div class="calc-split">
    <div class="calc-form">
      <div class="calc-field">
        <label for="fee-size">Transaction size (bytes)</label>
        <input type="number" id="fee-size" min="0" step="1" value="1500" inputmode="numeric" />
        <span class="hint">1 KiB = 1024 bytes · a simple transfer is ~1.5 KB</span>
      </div>
      <div class="calc-field">
        <label for="fee-outputs">Outputs (transfers)</label>
        <input type="number" id="fee-outputs" min="0" step="1" value="1" inputmode="numeric" />
        <span class="hint">0.00005 XEL each</span>
      </div>
      <div class="calc-field">
        <label for="fee-newaddr">New addresses</label>
        <input type="number" id="fee-newaddr" min="0" step="1" value="0" inputmode="numeric" />
        <span class="hint">0.001 XEL each</span>
      </div>
      <div class="calc-field">
        <label for="fee-sigs">Extra multisig signatures</label>
        <input type="number" id="fee-sigs" min="0" step="1" value="0" inputmode="numeric" />
        <span class="hint">0.00005 XEL each</span>
      </div>
    </div>
    <div class="calc-results" id="fee-results" aria-live="polite">
      <p class="calc-status">Loading live fee rates…</p>
    </div>
    </div>
  </div>`;

  return c.html(layout("Transaction fee estimator", content, "/tools/fee-estimator"));
});

tools.get("/tools/hashrate", (c) => {
  const content = `<p class="tool-back"><a href="/tools">${icons.arrowLeft} All tools</a></p>
  <div class="panel calc-panel" id="calc-hashrate">
    <div class="panel-head">
      <h2>Mining hashrate / profitability</h2>
      <button class="btn ghost calc-refresh" type="button" data-calc-refresh>Refresh</button>
    </div>
    <p class="calc-note">Estimates rewards from your share of the estimated network hashrate. Actual returns vary with luck, DAG side blocks and pool rules.</p>
    <div class="calc-split">
    <div class="calc-form">
      <div class="calc-field">
        <label for="hp-hashrate">Your hashrate</label>
        <div class="calc-inline">
          <input type="number" id="hp-hashrate" min="0" step="any" value="1" inputmode="decimal" />
          <select id="hp-unit" aria-label="Hashrate unit">
            <option value="1">H/s</option>
            <option value="1e3">kH/s</option>
            <option value="1e6" selected>MH/s</option>
          </select>
        </div>
      </div>
      <div class="calc-field">
        <label for="hp-power">Power draw (W)</label>
        <input type="number" id="hp-power" min="0" step="any" value="0" inputmode="decimal" />
      </div>
      <div class="calc-field">
        <label for="hp-elec">Electricity ($/kWh)</label>
        <input type="number" id="hp-elec" min="0" step="any" value="0.10" inputmode="decimal" />
      </div>
      <div class="calc-field">
        <label for="hp-pool">Pool fee (%)</label>
        <input type="number" id="hp-pool" min="0" max="100" step="any" value="1" inputmode="decimal" />
      </div>
    </div>
    <div class="calc-results" id="hp-results" aria-live="polite">
      <p class="calc-status">Loading network data…</p>
    </div>
    </div>
  </div>`;

  return c.html(layout("Mining hashrate / profitability", content, "/tools/hashrate"));
});
