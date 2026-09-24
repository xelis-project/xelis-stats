import { renderChart, renderCompare, cumulativePoints, fmtAuto, type ChartOpts, type SeriesPoint } from "./charts";
import { metricFormatter, FEE_METRICS } from "./format";
import { refreshSort } from "./sortable";
import { attachDatePickers, setDatePickerValue } from "./datepicker";

// ---------- charts hub page ----------

function initChartsHub(): void {
  const $ = (id: string): HTMLElement | null => document.getElementById(id);
  const selMetric = $("sel-metric") as HTMLSelectElement | null;
  const selFeestat = $("sel-feestat") as HTMLSelectElement | null;
  const selRange = $("sel-range") as HTMLSelectElement | null;
  const inpFrom = $("inp-from") as HTMLInputElement | null;
  const inpTo = $("inp-to") as HTMLInputElement | null;
  const selInterval = $("sel-interval") as HTMLSelectElement | null;
  const selExchange = $("sel-exchange") as HTMLSelectElement | null;
  const selCompare = $("sel-compare") as HTMLSelectElement | null;
  const chkCum = $("chk-cum") as HTMLInputElement | null;
  const chkLog = $("chk-log") as HTMLInputElement | null;
  const selType = $("sel-type") as HTMLSelectElement | null;
  const csvBtn = $("btn-csv");
  const chartEl = $("u-chart");
  if (!selMetric || !selRange || !selInterval || !chartEl) return;
  attachDatePickers(document);

  const chartTarget = chartEl;
  const MARKET_METRICS = new Set(["price", "quote-volume"]);

  // cached series for client-side re-renders (cum/log/type toggles)
  let data1: SeriesPoint[] = [];
  let data2: SeriesPoint[] | null = null;

  function renderOpts(): ChartOpts {
    return { type: selType?.value === "bar" ? "bar" : "line", log: !!chkLog?.checked };
  }

  function showEmpty(): void {
    chartTarget.innerHTML = '<p style="color:var(--text-dim)">No data for this range yet.</p>';
  }

  function draw(): void {
    const m = selMetric!.value;
    const o = renderOpts();
    const useCum = !!chkCum?.checked;
    const m2 = selCompare?.value ?? "";
    const s1 = useCum ? cumulativePoints(data1) : data1;
    if (m2 && m2 !== m && data2) {
      const s2 = useCum ? cumulativePoints(data2) : data2;
      if (!s1.length && !s2.length) { showEmpty(); return; }
      renderCompare(chartTarget, [
        { label: m, points: s1 },
        { label: m2, points: s2 },
      ], { ...o, fmt: metricFormatter(m) });
    } else {
      if (!s1.length) { showEmpty(); return; }
      renderChart(chartTarget, s1, m, metricFormatter(m), o);
    }
  }

  // relative range, or custom from/to period (+ exchange filter on market metrics)
  function apiParams(): URLSearchParams {
    const p = new URLSearchParams();
    if (selRange!.value === "custom") {
      const f = inpFrom?.value ?? "", t = inpTo?.value ?? "";
      if (f) p.set("from", f);
      if (t) p.set("to", t);
      if (!f && !t) p.set("range", "90d");
    } else {
      p.set("range", selRange!.value);
    }
    if (MARKET_METRICS.has(selMetric!.value) && selExchange?.value) p.set("exchange", selExchange.value);
    return p;
  }

  // show/hide metric-specific filters; prefill custom dates
  function syncControls(): void {
    if (selFeestat) {
      const isFee = FEE_METRICS.has(selMetric!.value);
      selFeestat.hidden = !isFee;
      if (isFee) selFeestat.value = selMetric!.value;
    }
    if (selExchange) selExchange.hidden = !MARKET_METRICS.has(selMetric!.value);
    const custom = selRange!.value === "custom";
    if (inpFrom && inpTo) {
      inpFrom.hidden = !custom;
      inpTo.hidden = !custom;
      const sep = $("period-sep");
      if (sep) sep.hidden = !custom;
      if (custom && !inpFrom.value && !inpTo.value) {
        const now = new Date();
        const to = now.toISOString().slice(0, 10);
        const from = new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10);
        setDatePickerValue(inpTo, to);
        setDatePickerValue(inpFrom, from);
      }
    }
  }

  function syncCompareOptions(): void {
    if (!selCompare) return;
    let cur = selCompare.value;
    if (cur === selMetric!.value) cur = "";
    selCompare.innerHTML = [
      '<option value="">no compare</option>',
      ...Array.from(selMetric!.options).filter((o) => o.value !== selMetric!.value)
        .map((o) => `<option value="${o.value}" ${cur === o.value ? "selected" : ""}>${o.text}</option>`),
    ].join("");
    selCompare.value = cur;
  }

  function syncUrl(): void {
    const q = new URLSearchParams();
    if (selMetric!.value !== "txs") q.set("metric", selMetric!.value);
    if (selRange!.value !== "90d") q.set("range", selRange!.value);
    if (selRange!.value === "custom") {
      if (inpFrom?.value) q.set("from", inpFrom.value);
      if (inpTo?.value) q.set("to", inpTo.value);
    }
    if (selInterval!.value !== "day") q.set("interval", selInterval!.value);
    if (MARKET_METRICS.has(selMetric!.value) && selExchange?.value) q.set("exchange", selExchange.value);
    if (selCompare?.value) q.set("compare", selCompare.value);
    if (chkCum?.checked) q.set("cum", "1");
    if (chkLog?.checked) q.set("log", "1");
    if (selType?.value === "bar") q.set("type", "bar");
    const qs = q.toString();
    history.replaceState(null, "", qs ? `/charts?${qs}` : "/charts");
  }

  async function load(): Promise<void> {
    syncControls();
    syncCompareOptions();
    const m = selMetric!.value;
    const qs = apiParams();
    qs.set("interval", selInterval!.value);
    const query = qs.toString();
    if (csvBtn) csvBtn.setAttribute("href", `/api/history/${m}?${query}&format=csv`);
    syncUrl();
    try {
      const res = await fetch(`/api/history/${m}?${query}`);
      const json = (await res.json()) as { points: SeriesPoint[] };
      data1 = json.points ?? [];
      const m2 = selCompare?.value ?? "";
      if (m2 && m2 !== m) {
        const res2 = await fetch(`/api/history/${m2}?${query}`);
        const json2 = (await res2.json()) as { points: SeriesPoint[] };
        data2 = json2.points ?? [];
      } else {
        data2 = null;
      }
      draw();
    } catch {
      chartTarget.innerHTML = '<p style="color:var(--text-dim)">Failed to load series.</p>';
    }
  }

  selMetric.addEventListener("change", load);
  selRange.addEventListener("change", load);
  selInterval.addEventListener("change", load);
  inpFrom?.addEventListener("change", load);
  inpTo?.addEventListener("change", load);
  selExchange?.addEventListener("change", load);
  selCompare?.addEventListener("change", load);
  if (selFeestat) {
    selFeestat.addEventListener("change", () => {
      selMetric!.value = selFeestat.value;
      load();
    });
  }
  // rendering-only toggles: redraw from cached series without refetching
  for (const el of [chkCum, chkLog, selType]) {
    el?.addEventListener("change", () => { syncUrl(); draw(); });
  }
  load();
}

// ---------- market page ----------

function initMarket(): void {
  const table = document.querySelector("#market-table tbody");
  if (!table) return;

  interface Ticker {
    exchange: string; url?: string; market: string; last: number; bid: number | null; ask: number | null;
    high24h: number | null; low24h: number | null; changePct24h: number | null;
    baseVolume: number; quoteVolume: number; timestamp: number;
  }

  let loaded = false;
  let histLoaded = false;

  function marketError(): void {
    if (loaded) return;
    const cards = document.getElementById("market-cards");
    if (cards) cards.innerHTML = '<div class="card"><div class="label">Market data unavailable</div><div class="sub">retrying…</div></div>';
    table!.innerHTML = '<tr><td colspan="11" style="color:var(--text-dim)">Market data unavailable, retrying…</td></tr>';
    const hist = document.getElementById("u-price-history");
    if (hist && !histLoaded) hist.innerHTML = '<p class="w-empty">Failed to load series.</p>';
  }

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/market");
      const agg = (await res.json()) as {
        price?: number; changePct24h?: number | null; totalQuoteVolume?: number;
        bestBid?: { exchange: string; price: number } | null; bestAsk?: { exchange: string; price: number } | null;
        spreadPct?: number | null; divergencePct?: number; tickers?: Ticker[]; timestamp?: number;
      };
      const cards = document.getElementById("market-cards");
      if (cards && agg.price) {
        const chg = agg.changePct24h;
        const bb = agg.bestBid, ba = agg.bestAsk, spread = agg.spreadPct;
        const div = agg.divergencePct;
        cards.innerHTML = `
          <div class="card"><div class="label">XEL Price</div><div class="value">$${agg.price.toFixed(4)}</div><div class="sub">aggregate across exchanges</div></div>
          <div class="card"><div class="label">24h Change</div><div class="value" style="color:${(chg ?? 0) >= 0 ? "var(--mint)" : "var(--danger)"}">${chg !== null && chg !== undefined ? (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%" : "—"}</div><div class="sub">volume-weighted</div></div>
          <div class="card"><div class="label">24h Volume</div><div class="value">$${fmtAuto(agg.totalQuoteVolume ?? 0)}</div><div class="sub">all tracked markets</div></div>
          <div class="card"><div class="label">Best Bid / Ask</div><div class="value small">$${bb ? bb.price.toFixed(4) : "—"} / $${ba ? ba.price.toFixed(4) : "—"}</div><div class="sub">${bb && ba ? `${bb.exchange} → ${ba.exchange} · spread ${spread !== null && spread !== undefined ? spread.toFixed(2) + "%" : "—"}` : "no quotes"}</div></div>
          <div class="card"><div class="label">Price Divergence</div><div class="value" style="color:${(div ?? 0) > 5 ? "var(--danger)" : "var(--mint)"}">${div != null && Number.isFinite(div) ? div.toFixed(2) + "%" : "—"}</div><div class="sub">max-min across exchanges</div></div>`;
      }
      if (!agg.tickers) return;
      loaded = true;
      table!.innerHTML = agg.tickers.map((t) => `<tr>
        <td>${t.url ? `<a href="${t.url}" target="_blank" rel="noopener">${t.exchange}</a>` : t.exchange}</td><td>${t.market}</td>
        <td class="num">$${t.last.toFixed(4)}</td>
        <td class="num" style="color:${(t.changePct24h ?? 0) >= 0 ? "var(--mint)" : "var(--danger)"}">${t.changePct24h !== null ? (t.changePct24h >= 0 ? "+" : "") + t.changePct24h.toFixed(2) + "%" : "—"}</td>
        <td class="num">${t.high24h?.toFixed(4) ?? "—"}</td>
        <td class="num">${t.low24h?.toFixed(4) ?? "—"}</td>
        <td class="num">${t.bid?.toFixed(4) ?? "—"}</td>
        <td class="num">${t.ask?.toFixed(4) ?? "—"}</td>
        <td class="num">${fmtAuto(t.baseVolume)}</td>
        <td class="num">${fmtAuto(t.quoteVolume)}</td>
        <td>${new Date(t.timestamp).toISOString().slice(11, 19)} UTC</td>
      </tr>`).join("");
      const tbl = table!.closest("table");
      if (tbl) refreshSort(tbl);

      // volume share bar across exchanges (by quote volume)
      const share = document.getElementById("market-volshare");
      const legend = document.getElementById("market-volshare-legend");
      if (share && legend) {
        const COLORS = ["#02ffcf", "#f5d95f", "#7fa7ff", "#ff9d76", "#c78fff", "#ff6b81"];
        const byEx = new Map<string, number>();
        for (const t of agg.tickers) byEx.set(t.exchange, (byEx.get(t.exchange) ?? 0) + t.quoteVolume);
        const rows = [...byEx.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const total = rows.reduce((s, [, v]) => s + v, 0);
        if (total > 0) {
          share.innerHTML = rows.map(([ex, v], i) => {
            const pct = (v / total) * 100;
            return `<div class="volshare-seg" style="width:${pct}%;background:${COLORS[i % COLORS.length]}" title="${ex}: ${pct.toFixed(1)}%"></div>`;
          }).join("");
          legend.innerHTML = rows.map(([ex, v], i) =>
            `<span class="volshare-item"><span class="volshare-dot" style="background:${COLORS[i % COLORS.length]}"></span>${ex} <span class="volshare-pct">${((v / total) * 100).toFixed(1)}%</span> · $${fmtAuto(v)}</span>`,
          ).join("");
        } else {
          share.innerHTML = "";
          legend.innerHTML = '<span class="volshare-item">no volume data</span>';
        }
      }

      // price history chart
      const hist = await fetch("/api/history/price?range=30d&interval=day").then((r) => r.json()) as { points: SeriesPoint[] };
      const el = document.getElementById("u-price-history");
      if (el && hist.points.length) { histLoaded = true; renderChart(el, hist.points, "XEL/USDT"); }
    } catch {
      marketError();
    }
  }

  load();
  setInterval(load, 60_000);
}

// ---------- miner profile ----------

function initMinerProfile(): void {
  const el = document.getElementById("miner-series");
  if (!el) return;
  let data: { blocks?: SeriesPoint[]; rewards?: SeriesPoint[] };
  try {
    data = JSON.parse(el.textContent ?? "{}") as typeof data;
  } catch {
    return;
  }
  const blocksEl = document.getElementById("u-miner-blocks");
  if (blocksEl && data.blocks?.length) renderChart(blocksEl, data.blocks, "blocks", fmtAuto, { type: "bar" });
  const rewardsEl = document.getElementById("u-miner-rewards");
  if (rewardsEl && data.rewards?.length) renderChart(rewardsEl, data.rewards, "XEL", fmtAuto, { type: "bar", accent: "gold" });
}

// ---------- boot ----------

// date pickers used by page filter popups (e.g. the miners anchor date)
attachDatePickers(document);

const path = location.pathname;
if (path.startsWith("/embed/")) {
  // embeddable mini-chart
  const el = document.getElementById("u-embed");
  if (el) {
    const metric = (window as unknown as { EMBED_METRIC: string }).EMBED_METRIC;
    const range = (window as unknown as { EMBED_RANGE: string }).EMBED_RANGE;
    const interval = (window as unknown as { EMBED_INTERVAL: string }).EMBED_INTERVAL;
    void fetch(`/api/history/${metric}?range=${range}&interval=${interval}`)
      .then((r) => r.json())
      .then((j: unknown) => renderChart(el, (j as { points: SeriesPoint[] }).points, metric, metricFormatter(metric)))
      .catch(() => { el.innerHTML = ""; });
  }
}
if (path === "/charts") initChartsHub();
if (path === "/market") initMarket();
if (path.startsWith("/miner/")) initMinerProfile();
