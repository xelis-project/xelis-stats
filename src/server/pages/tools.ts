import { Hono } from "hono";
import type { Env } from "../app";
import { layout } from "../../client/layout";
import { icons } from "../../client/icons";
import { rpc } from "../xelis";
import { logErr } from "./shared";

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
  {
    href: "/tools/address",
    title: "Address tools",
    desc: "Validate addresses, split integrated addresses, extract a public key from an address, convert a key back to an address, and build integrated addresses.",
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

// Address utilities backed by the node's address RPC methods. The browser
// cannot call the node directly (CORS), so this thin proxy normalises the
// responses that the client island (src/client/tools.ts) renders.
tools.get("/api/address", async (c) => {
  const node = c.env.XELIS_NODE;
  const op = (c.req.query("op") ?? "resolve").toLowerCase();
  const input = (c.req.query("input") ?? "").trim();
  const data = c.req.query("data") ?? "";
  try {
    if (op === "key") {
      if (!/^[0-9a-f]{64}$/i.test(input)) {
        return c.json({ ok: false, op, error: "Public key must be 64 hexadecimal characters." }, 400);
      }
      const address = await rpc<string>("key_to_address", { hex: input }, node);
      return c.json({ ok: true, op, address });
    }
    if (!input) return c.json({ ok: false, op, error: "Enter an address." }, 400);
    if (op === "integrate") {
      if (!data) return c.json({ ok: false, op, error: "Enter integrated data to encode." }, 400);
      const address = await rpc<string>("make_integrated_address", { address: input, integrated_data: data }, node);
      return c.json({ ok: true, op, address });
    }
    const valid = await rpc<{ is_valid: boolean; is_integrated: boolean }>(
      "validate_address", { address: input, allow_integrated: true }, node
    );
    if (!valid.is_valid) return c.json({ ok: true, op: "resolve", valid: false, isIntegrated: valid.is_integrated });

    let split: { address: string; integrated_data: unknown; size: number } | null = null;
    let key: string | null = null;
    if (valid.is_integrated) {
      split = await rpc<{ address: string; integrated_data: unknown; size: number }>(
        "split_address", { address: input }, node
      ).catch(() => null);
    } else {
      const k = await rpc<{ hex?: string }>("extract_key_from_address", { address: input, as_hex: true }, node).catch(() => null);
      key = k?.hex ?? null;
    }
    let integrated: string | null = null;
    if (data && !valid.is_integrated) {
      integrated = await rpc<string>("make_integrated_address", { address: input, integrated_data: data }, node).catch(() => null);
    }
    return c.json({ ok: true, op: "resolve", valid: true, isIntegrated: valid.is_integrated, split, key, integrated });
  } catch (err) {
    logErr("api/address", err);
    const msg = err instanceof Error ? err.message : "address tool failed";
    return c.json({ ok: false, op, error: msg.replace(/^RPC [a-z_]+: /, "") }, 400);
  }
});

// Static shell for the address tools; the client island fills the result pane.
tools.get("/tools/address", (c) => {
  const content = `<p class="tool-back"><a href="/tools">${icons.arrowLeft} All tools</a></p>
  <div class="panel calc-panel" id="calc-address">
    <div class="panel-head">
      <h2>Address tools</h2>
      <button class="btn ghost calc-refresh" type="button" data-addr-clear>Clear</button>
    </div>
    <p class="calc-note">Validate a Xelis address, split an integrated address into its base address and data, extract the public key from an address, convert a public key back to an address, or build an integrated address. Everything is resolved live through the node's address RPC methods.</p>
    <div class="calc-split">
    <div class="calc-form">
      <div class="calc-field">
        <label for="addr-input">Address or public key</label>
        <input type="text" id="addr-input" placeholder="xel:… or 64-char hex key" autocomplete="off" spellcheck="false" />
        <span class="hint">Normal or integrated address, or a 64-character hexadecimal public key.</span>
      </div>
      <div class="calc-field">
        <label for="addr-data">Integrated data (optional)</label>
        <input type="text" id="addr-data" placeholder="e.g. order-1234" autocomplete="off" />
        <span class="hint">When set, a normal address is also encoded into an integrated address.</span>
      </div>
      <div class="calc-inline">
        <button class="btn" type="button" id="addr-resolve">Resolve</button>
        <button class="btn ghost" type="button" id="addr-from-key">Key → address</button>
        <button class="btn ghost" type="button" id="addr-integrate">Build integrated</button>
      </div>
    </div>
    <div class="calc-results" id="addr-results" aria-live="polite">
      <p class="calc-status">Enter an address to begin.</p>
    </div>
    </div>
  </div>`;

  return c.html(layout("Address tools", content, "/tools/address"));
});
