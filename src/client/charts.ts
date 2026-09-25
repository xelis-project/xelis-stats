import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { getNumberFormat } from "./prefs";

export interface SeriesPoint { date: string; value: number }

export type LineWidth = "thin" | "normal" | "thick";

export interface ChartOpts {
  type?: "line" | "bar";
  log?: boolean;
  accent?: string;
  fill?: boolean;
  points?: boolean;
  lineWidth?: LineWidth;
  // y-axis/tooltip value formatter for multi-series compare charts
  fmt?: (v: number) => string;
}

const LINE_WIDTHS: Record<LineWidth, number> = { thin: 1, normal: 1.6, thick: 2.6 };

// Bar width as a fraction of the x-slot, mirroring the thin/normal/thick steps.
const BAR_WIDTHS: Record<LineWidth, number> = { thin: 0.45, normal: 0.7, thick: 0.95 };

// Marker sizes scale with line width so dots stay proportional to the stroke:
// normal (1.6px) keeps the original 3px data dot and 6px hover ring. Bars have
// width 0, so they fall back to those defaults instead of vanishing.
function markerSize(width: number): number {
  return width > 0 ? Math.max(2, width * 1.875) : 3;
}

function hoverMarkerSize(width: number): number {
  return width > 0 ? Math.max(4, width * 3.75) : 6;
}

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

// Metrics like block-types and tx-types key each point "<bucket>-<type>" (e.g.
// "2026-09-20-Sync", "2026-W38-transfer"). Drawn as a single series, every type
// of a bucket collapses onto the same x and uPlot connects the counts into a
// zig-zag, so split them into one series per type instead.
export function splitByType(points: SeriesPoint[]): Array<{ label: string; points: SeriesPoint[] }> {
  const groups = new Map<string, SeriesPoint[]>();
  for (const p of points) {
    // the type never contains a dash, so the last one separates it from the bucket
    const i = p.date.lastIndexOf("-");
    const type = i > 0 ? p.date.slice(i + 1) : "";
    const date = i > 0 ? p.date.slice(0, i) : p.date;
    const list = groups.get(type) ?? [];
    list.push({ date, value: p.value });
    groups.set(type, list);
  }
  return [...groups.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((t) => ({ label: t, points: groups.get(t)! }));
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
const RING = "#020708";

// Nearest-x binary search, shared by the cursor snap line.
function closestXIdx(xs: ArrayLike<number>, val: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < val) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - val) < Math.abs(xs[lo] - val)) lo--;
  return lo;
}

// Hover: the series nearest to the cursor is focused (others dim via focus
// alpha) and a single ringed dot marks the point on that line. prox is large
// so there is always a nearest series to highlight while inside the chart.
// move() snaps the vertical crosshair to the hovered point's x so the guide
// line meets the dot; the horizontal line keeps tracking the mouse.
function hoverCursor(lineWidth: number): uPlot.Cursor {
  return {
    focus: { prox: 1e6 },
    points: { one: true, size: hoverMarkerSize(lineWidth), width: 1.5, stroke: () => RING },
    move: (u: uPlot, left: number, top: number): [number, number] => {
      if (left < 0) return [left, top];
      const xs = u.data[0];
      if (!xs || xs.length < 2) return [left, top];
      return [u.valToPos(xs[closestXIdx(xs, u.posToVal(left, "x"))], "x"), top];
    },
  };
}

// Thicken the focused line on hover (setSeries fires only on focus changes),
// restore on leave. Bars have width 0, so this is a no-op for them.
function hoverHighlightPlugin(bases: number[]): uPlot.Plugin {
  return {
    hooks: {
      setSeries(u: uPlot, seriesIdx: number | null, opts: uPlot.Series) {
        if ((opts as { focus?: boolean } | undefined)?.focus == null) return;
        let dirty = false;
        bases.forEach((base, i) => {
          const s = u.series[i + 1];
          const w = seriesIdx === i + 1 ? base * 1.6 : base;
          if (s.width !== w) { s.width = w; dirty = true; }
        });
        if (dirty) u.redraw(false);
      },
    },
  };
}

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
      paths: uPlot.paths.bars({ size: [BAR_WIDTHS[opts.lineWidth ?? "normal"] ?? 0.7, 100] }),
      points: { show: false },
      value: (_u: uPlot, v: number) => fmtVal(v),
    };
  }
  return {
    label,
    stroke,
    width,
    fill: showFill ? hexToRgba(stroke, 0.08) : undefined,
    points: { show: showPoints, size: markerSize(width) },
    value: (_u: uPlot, v: number) => fmtVal(v),
  };
}

function baseScales(log: boolean): uPlot.Options["scales"] {
  return log ? { x: { time: true }, y: { distr: 3, log: 10 } } : { x: { time: true } };
}

// Bucket labels come in several shapes from /api/history depending on the
// interval: "YYYY-MM-DD" (day), "YYYY-Www" (week), "YYYY-MM" (month),
// "YYYY" (year) and "YYYY-MM-DD-type" (block types). Date.parse rejects most
// of them, so normalize each shape to a UTC timestamp; unparseable values map
// to null and fall back to their index.
function bucketToMs(d: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  if (/^\d{4}-\d{2}$/.test(d)) return Date.parse(`${d}-01T00:00:00Z`);
  if (/^\d{4}$/.test(d)) return Date.parse(`${d}-01-01T00:00:00Z`);
  const w = /^(\d{4})-W(\d{2})$/.exec(d);
  if (w) {
    // Mirror the server's Monday-based week index: week N starts N*7 days
    // after Jan 1 (± a few days when Jan 1 precedes the first Monday).
    const jan1 = Date.UTC(Number(w[1]), 0, 1);
    return jan1 + Number(w[2]) * 7 * 86400_000;
  }
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

function xValues(dates: string[]): number[] {
  const ts: (number | null)[] = dates.map((d) => {
    const t = bucketToMs(d);
    return t === null ? null : Math.round(t / 1000);
  });
  // Back/forward-fill buckets that can't be parsed instead of falling back to
  // the array index: an index is a ~1970 timestamp, which would break the time
  // axis and make uPlot connect it to real points with long stray segments.
  let next: number | null = null;
  for (let i = ts.length - 1; i >= 0; i--) {
    if (ts[i] === null) ts[i] = next;
    else next = ts[i];
  }
  let prev: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    if (ts[i] === null) ts[i] = prev ?? 0;
    else prev = ts[i];
  }
  return ts as number[];
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

// uPlot sizes the y-axis gutter at a fixed 50px, but labels are right-aligned
// inside it, so anything longer ("100,000") overflows the canvas' left edge
// and gets clipped. Measure the real labels instead: the gutter fits whatever
// the axis shows, and exact fmtAuto labels are kept only while they fit the
// default gutter or ~25% of the chart width — on narrow widgets the axis falls
// back to compact K/M/B labels (tooltips still show exact values).
const GUTTER_DEFAULT = 50;
const GUTTER_MAX_FRAC = 0.25;

let measureCtx: CanvasRenderingContext2D | null = null;

// Widest label in CSS px. Axis fonts carry devicePixelRatio-scaled sizes, so
// measure with the device font and convert back via uPlot.pxRatio.
function widestLabel(font: string, labels: Array<string | null>): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return 0;
  measureCtx.font = font;
  let w = 0;
  for (const l of labels) {
    if (l != null) w = Math.max(w, measureCtx.measureText(l).width);
  }
  return w / (uPlot.pxRatio || 1);
}

// Same tiers as fmtAuto, but always short enough for a narrow gutter.
function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const c = (n: number, suf: string) => String(Number(n.toFixed(1))) + suf;
  if (a >= 1e9) return c(v / 1e9, "B");
  if (a >= 1e6) return c(v / 1e6, "M");
  if (a >= 1e3) return c(v / 1e3, "K");
  return v.toFixed(2);
}

// ticks + gap sit between the gutter edge and the label text
function yPad(axis: uPlot.Axis): number {
  const t = axis.ticks;
  return (t && t.show !== false ? t.size ?? 10 : 0) + (axis.gap ?? 5);
}

function yAxis(fmt: (v: number) => string = fmtAuto): uPlot.Axis {
  return {
    stroke: AXIS,
    grid: { stroke: GRID },
    ticks: { stroke: GRID },
    values: (u: uPlot, splits: Array<number | null>, axisIdx: number) => {
      const font = (u.axes[axisIdx].font as unknown as [string, number, number])[0];
      // On log axes uPlot's default filter nulls out splits that are too tightly
      // spaced before values() runs. Keep those nulls: formatting them would
      // render a "—" at every skipped tick and make the axis unreadable.
      const full = splits.map((v) => (v == null ? null : fmt(v)));
      const gutterFull = widestLabel(font, full) + yPad(u.axes[axisIdx]);
      const budget = Math.max(GUTTER_DEFAULT, u.width * GUTTER_MAX_FRAC);
      return gutterFull > budget ? splits.map((v) => (v == null ? null : fmtCompact(v))) : full;
    },
    size: (u: uPlot, values: string[] | null, axisIdx: number): number => {
      if (values == null) return GUTTER_DEFAULT;
      const axis = u.axes[axisIdx];
      const font = (axis.font as unknown as [string, number, number])[0];
      return Math.ceil(widestLabel(font, values) + yPad(axis) + 1);
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Keep the chart sized to its container: uPlot renders at a fixed pixel
// size, so without this the canvas goes stale (or overflows) on resize.
function autoResizePlugin(el: HTMLElement): uPlot.Plugin {
  let ro: ResizeObserver | null = null;
  return {
    hooks: {
      ready(u: uPlot) {
        if (typeof ResizeObserver === "undefined") return;
        ro = new ResizeObserver(() => {
          try {
            const w = el.clientWidth || 600;
            const h = el.clientHeight || 280;
            if (w !== u.width || h !== u.height) u.setSize({ width: w, height: h });
          } catch { /* detached */ }
        });
        ro.observe(el);
      },
      destroy() { ro?.disconnect(); ro = null; },
    },
  };
}

// Hover tooltip plugin: renders date + per-series values near the cursor.
// Appended to u.over so it clips inside the chart and moves with it.
function tooltipPlugin(tooltipSeries: Array<{ label: string; fmt: (v: number) => string }>): uPlot.Plugin {
  let el: HTMLDivElement | null = null;
  let focusSi: number | null = null;

  const rowCls = (si: number) => (focusSi == null ? "" : si === focusSi ? " focus" : " dim");

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
        `<div class="uplot-tooltip-row${rowCls(si)}">` +
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
      setSeries(u: uPlot, seriesIdx: number | null, opts: uPlot.Series) {
        if ((opts as { focus?: boolean } | undefined)?.focus == null) return;
        focusSi = seriesIdx;
        update(u);
      },
      destroy() { el = null; focusSi = null; },
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
  const seriesOpts = seriesStyle(accent, type, label, points.length, fmtVal, opts);
  const uOpts: uPlot.Options = {
    width,
    height: el.clientHeight || 280,
    title: undefined,
    scales: baseScales(!!opts.log),
    series: [
      {},
      seriesOpts,
    ],
    axes: [
      dateAxis(),
      yAxis(fmtVal),
    ],
    legend: { show: false },
    cursor: hoverCursor(seriesOpts.width),
    focus: { alpha: 0.22 },
    plugins: [autoResizePlugin(el), tooltipPlugin([{ label, fmt: fmtVal }]), hoverHighlightPlugin([seriesOpts.width])],
  };

  return new uPlot(uOpts, data, el);
}

// multi-series compare chart: series = [{label, points}]
export function renderCompare(el: HTMLElement, series: Array<{ label: string; points: SeriesPoint[] }>, opts: ChartOpts = {}): uPlot | null {
  if (!series.length || !el) return null;
  el.innerHTML = "";

  const type = opts.type ?? "line";
  const fmt = opts.fmt ?? fmtAuto;
  const firstAccent = accentHex(opts.accent);
  const colors = [firstAccent ?? MINT, GOLD, "#7fa7ff", "#ff9d76", "#c78fff"];
  const xs = xValues(series[0].points.map((p) => p.date));
  const data = [xs, ...series.map((s) => Float64Array.from(s.points.map((p) => p.value)))];
  const seriesOpts = series.map((s, i) => {
    const base = seriesStyle(colors[i % colors.length], type, s.label, s.points.length, fmt, opts);
    return {
      ...base,
      fill: type === "bar" ? colors[i % colors.length] : base.fill,
    };
  });

  const uOpts: uPlot.Options = {
    width: el.clientWidth || 600,
    height: el.clientHeight || 300,
    scales: baseScales(!!opts.log),
    series: [
      {},
      ...seriesOpts,
    ],
    axes: [
      dateAxis(),
      yAxis(fmt),
    ],
    legend: { show: series.length > 1 },
    cursor: hoverCursor(seriesOpts[0].width),
    focus: { alpha: 0.22 },
    plugins: [autoResizePlugin(el), tooltipPlugin(series.map((s) => ({ label: s.label, fmt }))), hoverHighlightPlugin(seriesOpts.map((o) => o.width))],
  };

  return new uPlot(uOpts, data as unknown as uPlot.AlignedData, el);
}

export function fmtAuto(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (getNumberFormat() === "plain") return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return v.toFixed(2);
}
