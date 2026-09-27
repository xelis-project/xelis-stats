// Tool pages (/tools/fee-estimator, /tools/hashrate): transaction fee
// estimator + mining hashrate / profitability. Live values come from
// /api/fee-rates (protocol base fee + constants) and /api/summary
// (difficulty, block time/reward, price). Each page loads one island and the
// panels are guarded, so the shared module powers either tool. Inputs are
// persisted per browser so a reload keeps the last scenario.

import { fmt, fmtInt, fmtXel, ago } from "./format";
import { getPref, setPref } from "./prefs";

interface FeeRates {
  ok: boolean;
  fee_per_kb: number | null;
  predicated_fee_per_kb: number | null;
  per_output: number;
  per_new_address: number;
  per_signature: number;
  min_fee_per_kb: number;
  timestamp: number;
}

interface Summary {
  network?: string;
  node_version?: string;
  difficulty?: number;
  block_time_s?: number;
  block_time_target_s?: number;
  block_reward?: number;
  miner_reward?: number;
  dev_reward?: number;
  hashprice?: number | null;
  market?: { price?: number } | null;
  timestamp?: number;
}

const FEE_KEY = "xelis:calc-fee";
const HP_KEY = "xelis:calc-hashrate";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

const numOf = (el: HTMLInputElement | null, def = 0): number => {
  const n = Number(el?.value);
  return Number.isFinite(n) && n >= 0 ? n : def;
};

let feeRates: FeeRates | null = null;
let summary: Summary | null = null;

function row(k: string, v: string, cls = ""): string {
  return `<div class="calc-row ${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function fmtUsd(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtHash(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units: Array<[number, string]> = [
    [1e15, "PH/s"], [1e12, "TH/s"], [1e9, "GH/s"], [1e6, "MH/s"], [1e3, "kH/s"], [1, "H/s"],
  ];
  for (const [d, u] of units) if (n >= d) return `${fmt(n / d, 2)} ${u}`;
  return `${fmt(n, 2)} H/s`;
}

// Percent that stays readable for very small shares (a single GPU on a big net).
function fmtSharePct(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0%";
  if (p >= 1) return `${p.toFixed(2)}%`;
  return `${p.toPrecision(3)}%`;
}

// ---------- fee calculator ----------

function renderFee(): void {
  const box = $("fee-results");
  if (!box) return;
  if (!feeRates) {
    box.innerHTML = '<p class="calc-status err">Fee rates unavailable — the node could not be reached. Try refresh.</p>';
    return;
  }
  const size = numOf($<HTMLInputElement>("fee-size"));
  const outputs = numOf($<HTMLInputElement>("fee-outputs"));
  const newAddr = numOf($<HTMLInputElement>("fee-newaddr"));
  const sigs = numOf($<HTMLInputElement>("fee-sigs"));
  const rate = feeRates.fee_per_kb ?? feeRates.min_fee_per_kb;

  const storage = (size / 1024) * rate;
  const outputsFee = outputs * feeRates.per_output;
  const newAddrFee = newAddr * feeRates.per_new_address;
  const sigFee = sigs * feeRates.per_signature;
  const total = storage + outputsFee + newAddrFee + sigFee;

  const price = summary?.market?.price ?? 0;
  const usd = price > 0 ? `≈ ${fmtUsd((total / 1e8) * price, 4)} at current price` : "";

  const pred = feeRates.predicated_fee_per_kb !== null && feeRates.predicated_fee_per_kb !== rate
    ? ` · projected ${fmt(feeRates.predicated_fee_per_kb, 0)}`
    : "";

  box.innerHTML = `
    <div class="calc-total">
      <span class="calc-total-label">Estimated fee</span>
      <span class="calc-total-value">${fmtXel(total / 1e8)} XEL</span>
      ${usd ? `<span class="calc-total-sub">${usd}</span>` : ""}
    </div>
    <div class="calc-rows">
      ${row(`Storage (${fmt(size / 1024, 3)} KiB × ${fmt(rate, 0)}/KiB)`, `${fmtXel(storage / 1e8)} XEL`)}
      ${row(`Outputs (${fmtInt(outputs)} × 0.00005)`, `${fmtXel(outputsFee / 1e8)} XEL`)}
      ${row(`New addresses (${fmtInt(newAddr)} × 0.001)`, `${fmtXel(newAddrFee / 1e8)} XEL`)}
      ${row(`Signatures (${fmtInt(sigs)} × 0.00005)`, `${fmtXel(sigFee / 1e8)} XEL`)}
      ${row("Total", `${fmtXel(total / 1e8)} XEL`, "net")}
    </div>
    <p class="calc-status">Base rate ${fmt(rate, 0)} atomic/KiB (${fmtXel(rate / 1e8)} XEL/KiB)${pred} · updated ${ago(feeRates.timestamp)}</p>`;
}

// ---------- hashrate / profitability calculator ----------

function renderHashrate(): void {
  const box = $("hp-results");
  if (!box) return;
  if (!summary) {
    box.innerHTML = '<p class="calc-status err">Network data unavailable — the node could not be reached. Try refresh.</p>';
    return;
  }
  const unit = Number($<HTMLSelectElement>("hp-unit")?.value ?? 1) || 1;
  const hashrate = numOf($<HTMLInputElement>("hp-hashrate")) * unit;
  const power = numOf($<HTMLInputElement>("hp-power"));
  const elec = numOf($<HTMLInputElement>("hp-elec"));
  const pool = Math.min(100, numOf($<HTMLInputElement>("hp-pool")));

  const blockTime = summary.block_time_s ?? 0;
  const difficulty = summary.difficulty ?? 0;
  const networkHashrate = blockTime > 0 ? difficulty / blockTime : 0;
  const share = networkHashrate > 0 ? hashrate / networkHashrate : 0;
  const rewardXel = (summary.miner_reward ?? 0) / 1e8;
  const blocksPerDay = blockTime > 0 ? 86400 / blockTime : 0;

  const grossXelDay = share * rewardXel * blocksPerDay;
  const xelDay = grossXelDay * (1 - pool / 100);
  const xelMonth = xelDay * 30;

  const price = summary.market?.price ?? 0;
  const revDay = price > 0 ? xelDay * price : null;
  const costDay = (power / 1000) * 24 * elec;
  const netDay = revDay === null ? null : revDay - costDay;
  const netMonth = netDay === null ? null : netDay * 30;

  const hashprice = summary.hashprice ?? (price > 0 && hashrate > 0 ? (grossXelDay * price) / (hashrate / 1e12) : null);
  const netCls = netDay === null ? "" : netDay >= 0 ? "net pos" : "net neg";
  const netValue = netDay === null ? "—" : `${netDay < 0 ? "-" : ""}${fmtUsd(Math.abs(netDay))}`;

  box.innerHTML = `
    <div class="calc-total">
      <span class="calc-total-label">Estimated mining revenue</span>
      <span class="calc-total-value">${fmtXel(xelDay)} XEL/day</span>
      <span class="calc-total-sub">${revDay === null ? "market price unavailable" : `${fmtUsd(revDay)}/day · net ${netValue}/day`}</span>
    </div>
    <div class="calc-rows">
      ${row("Network hashrate", fmtHash(networkHashrate))}
      ${row("Your share", fmtSharePct(share * 100))}
      ${row("Miner reward", `${fmtXel(rewardXel)} XEL/block`)}
      ${row("Blocks / day", fmt(blocksPerDay, 1))}
      ${row("Pool fee", `${fmt(pool, 2)}%`)}
      ${row("Gross XEL / day", `${fmtXel(grossXelDay)} XEL`)}
      ${row("Revenue / day", fmtUsd(revDay))}
      ${row("XEL / month", `${fmtXel(xelMonth)} XEL`)}
      ${row("Power cost / day", fmtUsd(costDay))}
      ${row("Net / day", netValue, netCls)}
      ${row("Net / month", netMonth === null ? "—" : `${netMonth < 0 ? "-" : ""}${fmtUsd(Math.abs(netMonth))}`)}
      ${row("Hashprice", hashprice === null ? "—" : `${fmtUsd(hashprice)} /TH/day`)}
    </div>
    <p class="calc-status">Network ${summary.network ?? "—"} · difficulty ${fmt(difficulty, 0)} · block time ${fmt(blockTime, 2)}s · updated ${ago(summary.timestamp ?? 0)}</p>`;
}

// ---------- persistence ----------

function saveInputs(): void {
  setPref(FEE_KEY, JSON.stringify({
    size: $<HTMLInputElement>("fee-size")?.value ?? "",
    outputs: $<HTMLInputElement>("fee-outputs")?.value ?? "",
    newaddr: $<HTMLInputElement>("fee-newaddr")?.value ?? "",
    sigs: $<HTMLInputElement>("fee-sigs")?.value ?? "",
  }));
  setPref(HP_KEY, JSON.stringify({
    hashrate: $<HTMLInputElement>("hp-hashrate")?.value ?? "",
    unit: $<HTMLSelectElement>("hp-unit")?.value ?? "",
    power: $<HTMLInputElement>("hp-power")?.value ?? "",
    elec: $<HTMLInputElement>("hp-elec")?.value ?? "",
    pool: $<HTMLInputElement>("hp-pool")?.value ?? "",
  }));
}

function restoreInputs(): void {
  const restore = (key: string, map: Record<string, string>): void => {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(getPref(key, "")) as Record<string, unknown> | null;
    } catch { /* no saved state */ }
    if (!parsed) return;
    for (const [id, field] of Object.entries(map)) {
      const el = $<HTMLInputElement>(id);
      const v = parsed[field];
      if (el && typeof v === "string" && v !== "") el.value = v;
    }
  };
  restore(FEE_KEY, { "fee-size": "size", "fee-outputs": "outputs", "fee-newaddr": "newaddr", "fee-sigs": "sigs" });
  restore(HP_KEY, { "hp-hashrate": "hashrate", "hp-power": "power", "hp-elec": "elec", "hp-pool": "pool" });
  const hpUnit = $<HTMLSelectElement>("hp-unit");
  try {
    const h = JSON.parse(getPref(HP_KEY, "")) as { unit?: unknown } | null;
    if (hpUnit && h && typeof h.unit === "string" && hpUnit.querySelector(`option[value="${h.unit}"]`)) {
      hpUnit.value = h.unit;
    }
  } catch { /* ignore */ }
}

// ---------- boot ----------

async function load(): Promise<void> {
  const feeBox = $("fee-results");
  const hpBox = $("hp-results");
  if (feeBox && !feeRates) feeBox.innerHTML = '<p class="calc-status">Loading live fee rates…</p>';
  if (hpBox && !summary) hpBox.innerHTML = '<p class="calc-status">Loading network data…</p>';
  const [fr, sm] = await Promise.all([
    fetch("/api/fee-rates").then((r) => r.json() as Promise<FeeRates>).catch(() => null),
    fetch("/api/summary").then((r) => r.json() as Promise<Summary>).catch(() => null),
  ]);
  feeRates = fr && fr.ok ? fr : null;
  summary = sm && Number.isFinite(sm.difficulty) ? sm : null;
  renderFee();
  renderHashrate();
}

export function initTools(): void {
  const feePanel = $("calc-fee");
  const hpPanel = $("calc-hashrate");
  if (!feePanel && !hpPanel) return;

  restoreInputs();

  const recompute = (): void => {
    renderFee();
    renderHashrate();
    saveInputs();
  };

  for (const el of feePanel?.querySelectorAll("input, select") ?? []) {
    el.addEventListener("input", recompute);
    el.addEventListener("change", recompute);
  }
  for (const el of hpPanel?.querySelectorAll("input, select") ?? []) {
    el.addEventListener("input", recompute);
    el.addEventListener("change", recompute);
  }

  for (const btn of document.querySelectorAll("[data-calc-refresh]")) {
    btn.addEventListener("click", () => void load());
  }

  void load();
}
