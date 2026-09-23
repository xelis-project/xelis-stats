import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface SeriesPoint { date: string; value: number }

export type LineWidth = "thin" | "normal" | "thick";

export interface ChartOpts {
  type?: "line" | "bar";
  log?: boolean;
  accent?: string;
  fill?: boolean;
  points?: boolean;
  lineWidth?: LineWidth;
}

const LINE_WIDTHS: Record<LineWidth, number> = { thin: 1, normal: 1.6, thick: 2.6 };

export const ACCENTS: Record<string, string> = {
  mint: "#02ffcf",
  gold: "#f5d95f",
  blue: "#7fa7ff",
  orange: "#ff9d76",
  purple: "#c78fff",
  red: "#ff6b81",
};

export function accentHex(name: string | undefined): string | undefined {
  return name ? ACCENTS[name] : undefined;
}

export function cumulativePoints(points: SeriesPoint[]): SeriesPoint[] {
  let sum = 0;
  return points.map((p) => ({ date: p.date, value: (sum += p.value) }));
}

function hexToRgba(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return `rgba(2,255,207,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const MINT = "#02ffcf";
const GOLD = "#f5d95f";
const GRID = "rgba(255,255,255,0.06)";
const AXIS = "#9bb3b2";

function seriesStyle(stroke: string, type: "line" | "bar", label: string, pointsCount: number, fmtVal: (v: number) => string, opts: ChartOpts = {}) {
  const width = LINE_WIDTHS[opts.lineWidth ?? "normal"] ?? 1.6;
  const showFill = opts.fill !== false;
  const showPoints = opts.points === true ? true : pointsCount < 60;
  if (type === "bar" && uPlot.paths.bars) {
    return {
      label,
      stroke,
      width: 0,
      fill: stroke,
      paths: uPlot.paths.bars({ size: [0.7, 100] }),
      points: { show: false },
      value: (_u: uPlot, v: number) => fmtVal(v),
    };
  }
  return {
    label,
    stroke,
    width,
    fill: showFill ? hexToRgba(stroke, 0.08) : undefined,
    points: { show: showPoints, size: 3 },
    value: (_u: uPlot, v: number) => fmtVal(v),
  };
}

function baseScales(log: boolean): uPlot.Options["scales"] {
  return log ? { x: { time: true }, y: { distr: 3, log: 10 } } : { x: { time: true } };
}

// uPlot needs numeric x values: ISO date strings would coerce to NaN and the
// series silently never draws (axes render, line doesn't). Feed unix seconds
// and format tick labels as dates instead.
function xValues(dates: string[]): number[] {
  return dates.map((d, i) => {
    const t = Date.parse(d.length === 10 ? `${d}T00:00:00Z` : d);
    return Number.isFinite(t) ? Math.round(t / 1000) : i;
  });
}

function dateLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(ts);
}

// approx px width of "2026-07-19" at uPlot's default 10px axis font + padding
const X_LABEL_W = 76;

function dateAxis(): uPlot.Axis {
  return {
    stroke: AXIS,
    grid: { stroke: GRID },
    ticks: { stroke: GRID },
    // uPlot draws a label for every non-null value returned here, so thin
    // labels to what fits side by side: null skips a label (grid stays full).
    values: (u: uPlot, splits: number[]) => {
      const avail = Math.max(1, (u.bbox?.width ?? 600) - 24);
      const stride = Math.max(1, Math.ceil((splits.length * X_LABEL_W) / avail));
      return splits.map((ts, i) => (i % stride === 0 ? dateLabel(ts) : null));
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Hover tooltip plugin: renders date + per-series values near the cursor.
// Appended to u.over so it clips inside the chart and moves with it.
function tooltipPlugin(tooltipSeries: Array<{ label: string; fmt: (v: number) => string }>): uPlot.Plugin {
  let el: HTMLDivElement | null = null;

  const update = (u: uPlot) => {
    if (!el) return;
    const idx = u.cursor.idx;
    if (idx == null) {
      el.style.display = "none";
      return;
    }
    const rows: string[] = [`<div class="uplot-tooltip-date">${escapeHtml(dateLabel(u.data[0][idx] as number))}</div>`];
    u.series.forEach((s, si) => {
      if (si === 0 || !s.show) return;
      const v = u.data[si]?.[idx];
      if (v == null || !Number.isFinite(v)) return;
      const info = tooltipSeries[si - 1];
      rows.push(
        `<div class="uplot-tooltip-row">` +
        `<span class="uplot-tooltip-dot" style="background:${s.stroke as string}"></span>` +
        `<span class="uplot-tooltip-label">${escapeHtml(info?.label ?? s.label ?? "")}</span>` +
        `<span class="uplot-tooltip-val">${(info?.fmt ?? fmtAuto)(v as number)}</span>` +
        `</div>`,
      );
    });
    el.innerHTML = rows.join("");
    el.style.display = "block";

    const ttW = el.offsetWidth;
    const ttH = el.offsetHeight;
    const overW = u.over.clientWidth;
    const overH = u.over.clientHeight;
    const cx = u.cursor.left ?? 0;
    const cy = u.cursor.top ?? 0;
    let x = cx + 14;
    if (x + ttW > overW - 6) x = cx - ttW - 14;
    if (x < 6) x = 6;
    let y = cy - ttH - 12;
    if (y < 6) y = cy + 14;
    if (y + ttH > overH - 6) y = overH - ttH - 6;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  };

  return {
    hooks: {
      ready(u: uPlot) {
        el = document.createElement("div");
        el.className = "uplot-tooltip";
        el.style.display = "none";
        u.over.appendChild(el);
      },
      setCursor(u: uPlot) { update(u); },
      destroy() { el = null; },
    },
  };
}

export function renderChart(el: HTMLElement, points: SeriesPoint[], label = "", fmtVal = fmtAuto, opts: ChartOpts = {}): uPlot | null {
  if (!points.length || !el) return null;
  el.innerHTML = "";

  const type = opts.type ?? "line";
  const accent = accentHex(opts.accent) ?? MINT;
  const dates = points.map((p) => p.date);
  const xs = xValues(dates);
  const values = Float64Array.from(points.map((p) => p.value));
  const data = [xs, values] as unknown as uPlot.AlignedData;

  const width = el.clientWidth || 600;
  const uOpts: uPlot.Options = {
    width,
    height: el.clientHeight || 280,
    title: undefined,
    scales: baseScales(!!opts.log),
    series: [
      {},
      seriesStyle(accent, type, label, points.length, fmtVal, opts),
    ],
    axes: [
      dateAxis(),
      { stroke: AXIS, grid: { stroke: GRID }, ticks: { stroke: GRID }, values: (u: uPlot, splits: number[]) => splits.map((v) => fmtAuto(v)) },
    ],
    legend: { show: false },
    plugins: [tooltipPlugin([{ label, fmt: fmtVal }])],
  };

  return new uPlot(uOpts, data, el);
}

// multi-series compare chart: series = [{label, points}]
export function renderCompare(el: HTMLElement, series: Array<{ label: string; points: SeriesPoint[] }>, opts: ChartOpts = {}): uPlot | null {
  if (!series.length || !el) return null;
  el.innerHTML = "";

  const type = opts.type ?? "line";
  const firstAccent = accentHex(opts.accent);
  const colors = [firstAccent ?? MINT, GOLD, "#7fa7ff", "#ff9d76", "#c78fff"];
  const xs = xValues(series[0].points.map((p) => p.date));
  const data = [xs, ...series.map((s) => Float64Array.from(s.points.map((p) => p.value)))];

  const uOpts: uPlot.Options = {
    width: el.clientWidth || 600,
    height: el.clientHeight || 300,
    scales: baseScales(!!opts.log),
    series: [
      {},
      ...series.map((s, i) => ({
        ...seriesStyle(colors[i % colors.length], type, s.label, s.points.length, fmtAuto, opts),
        fill: type === "bar" ? colors[i % colors.length] : undefined,
      })),
    ],
    axes: [
      dateAxis(),
      { stroke: AXIS, grid: { stroke: GRID }, ticks: { stroke: GRID }, values: (u: uPlot, splits: number[]) => splits.map((v) => fmtAuto(v)) },
    ],
    legend: { show: series.length > 1 },
    plugins: [tooltipPlugin(series.map((s) => ({ label: s.label, fmt: fmtAuto })))],
  };

  return new uPlot(uOpts, data as unknown as uPlot.AlignedData, el);
}

export function fmtAuto(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toFixed(2);
}
