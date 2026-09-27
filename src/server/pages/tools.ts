import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";

export const tools = new Hono<{ Bindings: Env }>();

// Static shell for the calculators; the client island (src/client/tools.ts)
// fetches /api/summary and /api/fee-rates and fills the result panes.
tools.get("/tools", (c) => {
  const content = `<div class="panel calc-hero">
    <h2>Calculators</h2>
    <p class="calc-intro">Estimate a Xelis transaction fee and the profitability of mining XEL. Network values are fetched live when the page loads; edit any input to recompute.</p>
  </div>
  <div class="grid-2 calc-grid">
    <div class="panel calc-panel" id="calc-fee">
      <div class="panel-head">
        <h2>Transaction fee estimator</h2>
        <button class="btn ghost calc-refresh" type="button" data-calc-refresh>Refresh</button>
      </div>
      <p class="calc-note">Fees are paid in XEL and combine a dynamic per-KiB storage fee with static per-output, per-new-address and per-signature fees. See the <a href="https://docs.xelis.io/features/transaction-fees" target="_blank" rel="noopener noreferrer">fee model</a>.</p>
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
        <div class="calc-field">
          <label for="fee-priority">Priority</label>
          <select id="fee-priority">
            <option value="low">Low (economy)</option>
            <option value="medium" selected>Medium</option>
            <option value="high">High (fast)</option>
            <option value="custom">Custom rate</option>
          </select>
          <span class="hint" id="fee-rate-hint">live rates load on page open</span>
        </div>
        <div class="calc-field" id="fee-rate-field" hidden>
          <label for="fee-rate">Custom rate (atomic/KiB)</label>
          <input type="number" id="fee-rate" min="0" step="1" value="10000" inputmode="numeric" />
          <span class="hint" id="fee-rate-custom-hint">atomic XEL per KiB</span>
        </div>
      </div>
      <div class="calc-results" id="fee-results" aria-live="polite">
        <p class="calc-status">Loading live fee rates…</p>
      </div>
    </div>

    <div class="panel calc-panel" id="calc-hashrate">
      <div class="panel-head">
        <h2>Mining hashrate / profitability</h2>
        <button class="btn ghost calc-refresh" type="button" data-calc-refresh>Refresh</button>
      </div>
      <p class="calc-note">Estimates rewards from your share of the estimated network hashrate. Actual returns vary with luck, DAG side blocks and pool rules.</p>
      <div class="calc-form">
        <div class="calc-field">
          <label for="hp-hashrate">Your hashrate</label>
          <div class="calc-inline">
            <input type="number" id="hp-hashrate" min="0" step="any" value="1" inputmode="decimal" />
            <select id="hp-unit" aria-label="Hashrate unit">
              <option value="1">H/s</option>
              <option value="1e3">kH/s</option>
              <option value="1e6">MH/s</option>
              <option value="1e9">GH/s</option>
              <option value="1e12" selected>TH/s</option>
              <option value="1e15">PH/s</option>
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

  return c.html(layout("Calculators", content, "/tools"));
});
