import uPlot from "uplot";
// uPlot CSS is inlined into every page by the server templates (layout.ts/seo.ts)
import { getNumberFormat } from "./prefs";

export interface SeriesPoint { date: string; value: number }

export interface Candle { t: string; o: number; h: number; l: number; c: number; n?: number }

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

// One uPlot instance per container: re-rendering must destroy the previous
// chart (its canvas, cursor listeners and resize observer), otherwise every
// dashboard refresh leaks a full chart.
const liveCharts = new WeakMap<HTMLElement, uPlot>();

function destroyChart(el: HTMLElement): void {
  const prev = liveCharts.get(el);
  if (!prev) return;
  liveCharts.delete(el);
  try { prev.destroy(); } catch { /* already destroyed */ }
}

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
    // dist keeps the tiniest mouse movement while hovering from starting a
    // zoom selection (the default is 0, so any drift zoomed on release)
    drag: { x: true, y: false, dist: DRAG_DIST },
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

// Drag threshold in CSS px before a press turns into a zoom selection.
const DRAG_DIST = 8;
// Wheel zoom step per notch (range multiplier).
const WHEEL_STEP = 1.25;

// Zoom affordances on top of uPlot's x-only drag selection. Stock uPlot
// starts a selection on any movement and only advertises the way back via an
// undiscoverable double-click, so this plugin adds:
//   - Shift+drag pans the zoomed window (clamped to the initial range)
//   - Ctrl/Cmd/Shift + wheel zooms around the pointer (plain wheel scrolls)
//   - a "Reset zoom" chip while the x-scale is off its initial range
//   - a live date-range label above the drag selection
function chartZoomPlugin(): uPlot.Plugin {
  let chip: HTMLButtonElement | null = null;
  let selLabel: HTMLDivElement | null = null;
  let dragCfg: uPlot.Cursor.Drag | null = null;
  let cleanup: (() => void) | null = null;
  let initial = { min: 0, max: 0 };
  let pan: { px: number; min: number; max: number } | null = null;

  const span = (): number => initial.max - initial.min;

  // Keep a window inside the initial extent without changing its width, so
  // panning and zoom-out slide against the edges instead of squashing.
  const fit = (min: number, max: number): [number, number] => {
    const full = span();
    if (!(full > 0) || max - min >= full) return [initial.min, initial.max];
    if (min < initial.min) { max += initial.min - min; min = initial.min; }
    if (max > initial.max) { min -= max - initial.max; max = initial.max; }
    return [min, max];
  };

  const isZoomed = (u: uPlot): boolean => {
    const full = span();
    const sc = u.scales.x;
    return full > 0 && sc.min != null && sc.max != null &&
      (Math.abs(sc.min - initial.min) > full * 1e-6 || Math.abs(sc.max - initial.max) > full * 1e-6);
  };

  const hideLabel = (): void => {
    if (selLabel) selLabel.style.display = "none";
  };

  return {
    hooks: {
      ready(u: uPlot) {
        const sc = u.scales.x;
        initial = { min: sc.min ?? 0, max: sc.max ?? 0 };
        dragCfg = u.cursor.drag ?? null;

        chip = document.createElement("button");
        chip.type = "button";
        chip.className = "uplot-reset";
        chip.textContent = "Reset zoom";
        chip.hidden = true;
        const swallow = (e: Event) => e.stopPropagation();
        chip.addEventListener("mousedown", swallow);
        chip.addEventListener("dblclick", swallow);
        chip.addEventListener("click", (e) => {
          e.stopPropagation();
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          u.setScale("x", { min: initial.min, max: initial.max });
        });
        u.over.appendChild(chip);

        selLabel = document.createElement("div");
        selLabel.className = "uplot-select-label";
        selLabel.style.display = "none";
        u.over.appendChild(selLabel);

        // Wheel zoom needs a modifier so a plain wheel keeps scrolling the
        // page (dashboards put many charts in the scroll path).
        const onWheel = (e: WheelEvent) => {
          if (!(e.ctrlKey || e.metaKey || e.shiftKey)) return;
          const min = u.scales.x.min;
          const max = u.scales.x.max;
          if (min == null || max == null || u.data[0].length < 2) return;
          e.preventDefault();
          const val = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x");
          const ratio = (val - min) / (max - min || 1);
          // zoom around the pointer, but never closer than ~2 buckets
          const floor = (span() / (u.data[0].length - 1)) * 2;
          const width = Math.max((max - min) * (e.deltaY < 0 ? 1 / WHEEL_STEP : WHEEL_STEP), Math.min(floor, span()));
          const [newMin, newMax] = fit(val - width * ratio, val + width * (1 - ratio));
          u.setScale("x", { min: newMin, max: newMax });
        };
        u.over.addEventListener("wheel", onWheel, { passive: false });

        // Shift+drag pans: disable the selection for this gesture (drag.x) and
        // follow raw pointer pixels, so the snapped crosshair from hoverCursor
        // can't make the window stutter between buckets.
        const onDown = (e: MouseEvent) => {
          const min = u.scales.x.min;
          const max = u.scales.x.max;
          if (!e.shiftKey || e.button !== 0 || min == null || max == null) return;
          pan = { px: e.clientX - u.over.getBoundingClientRect().left, min, max };
          if (dragCfg) dragCfg.x = false;
          u.over.classList.add("panning");
        };
        const onMove = (e: MouseEvent) => {
          if (!pan) return;
          const dx = ((e.clientX - u.over.getBoundingClientRect().left - pan.px) / Math.max(1, u.over.clientWidth)) * (pan.max - pan.min);
          const [min, max] = fit(pan.min - dx, pan.max - dx);
          u.setScale("x", { min, max });
        };
        const onUp = () => {
          if (pan) {
            pan = null;
            if (dragCfg) dragCfg.x = true;
            u.over.classList.remove("panning");
          }
          hideLabel();
        };
        u.over.addEventListener("mousedown", onDown);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);

        cleanup = () => {
          u.over.removeEventListener("wheel", onWheel);
          u.over.removeEventListener("mousedown", onDown);
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
      },
      setScale(u: uPlot) {
        if (chip) chip.hidden = !isZoomed(u);
      },
      setCursor(u: uPlot) {
        if (!selLabel) return;
        const sel = u.select;
        if (sel.width <= 0) { hideLabel(); return; }
        const a = u.posToVal(sel.left, "x");
        const b = u.posToVal(sel.left + sel.width, "x");
        const withTime = Math.abs(b - a) < 2 * 86400;
        selLabel.textContent = `${dateLabel(a, withTime)} – ${dateLabel(b, withTime)}`;
        selLabel.style.display = "block";
        const half = selLabel.offsetWidth / 2;
        const overW = u.over.clientWidth;
        const cx = Math.min(Math.max(sel.left + sel.width / 2, half + 4), Math.max(half + 4, overW - half - 4));
        selLabel.style.left = `${cx}px`;
        selLabel.style.top = "6px";
      },
      destroy() {
        cleanup?.();
        cleanup = null;
        chip = null;
        selLabel = null;
        pan = null;
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

// Bucket labels come in several shapes from /api/history and /api/candles
// depending on the interval: "YYYY-MM-DD" (day), "YYYY-MM-DDTHH:MM:SSZ"
// (hour), "YYYY-Www" (week), "YYYY-MM" (month), "YYYY" (year) and
// "YYYY-MM-DD-type" (block types). Date.parse rejects most of them, so
// normalize each shape to a UTC timestamp; unparseable values map to null and
// fall back to their index.
function bucketToMs(d: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(d)) {
    const t = Date.parse(d);
    return Number.isFinite(t) ? t : null;
  }
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

function dateLabel(ts: number, withTime = false): string {
  const d = new Date(ts * 1000);
  if (!Number.isFinite(d.getTime())) return String(ts);
  const iso = d.toISOString();
  return withTime ? iso.slice(5, 16).replace("T", " ") : iso.slice(0, 10);
}

// approx px width of "2026-07-19" at uPlot's default 10px axis font + padding
const X_LABEL_W = 76;

function dateAxis(withTime = false): uPlot.Axis {
  return {
    stroke: AXIS,
    grid: { stroke: GRID },
    ticks: { stroke: GRID },
    // uPlot draws a label for every non-null value returned here, so thin
    // labels to what fits side by side: null skips a label (grid stays full).
    values: (u: uPlot, splits: number[]) => {
      const avail = Math.max(1, (u.bbox?.width ?? 600) - 24);
      const stride = Math.max(1, Math.ceil((splits.length * X_LABEL_W) / avail));
      return splits.map((ts, i) => (i % stride === 0 ? dateLabel(ts, withTime) : null));
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
  destroyChart(el);
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
    plugins: [autoResizePlugin(el), tooltipPlugin([{ label, fmt: fmtVal }]), hoverHighlightPlugin([seriesOpts.width]), chartZoomPlugin()],
  };

  const u = new uPlot(uOpts, data, el);
  liveCharts.set(el, u);
  return u;
}

// multi-series compare chart: series = [{label, points}]
export function renderCompare(el: HTMLElement, series: Array<{ label: string; points: SeriesPoint[] }>, opts: ChartOpts = {}): uPlot | null {
  if (!series.length || !el) return null;
  destroyChart(el);
  el.innerHTML = "";

  const type = opts.type ?? "line";
  const fmt = opts.fmt ?? fmtAuto;
  const firstAccent = accentHex(opts.accent);
  const colors = [firstAccent ?? MINT, GOLD, "#7fa7ff", "#ff9d76", "#c78fff"];
  // Align every series on the union of bucket dates: series covering different
  // ranges (e.g. a metric with shorter history) must share x positions, not be
  // zipped by array index.
  const allDates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
  const xs = xValues(allDates);
  const data = [
    xs,
    ...series.map((s) => {
      const byDate = new Map(s.points.map((p) => [p.date, p.value]));
      return allDates.map((d) => (byDate.has(d) ? (byDate.get(d) as number) : null));
    }),
  ];
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
    plugins: [autoResizePlugin(el), tooltipPlugin(series.map((s) => ({ label: s.label, fmt }))), hoverHighlightPlugin(seriesOpts.map((o) => o.width)), chartZoomPlugin()],
  };

  const u = new uPlot(uOpts, data as unknown as uPlot.AlignedData, el);
  liveCharts.set(el, u);
  return u;
}

// OHLC candle chart backed by /api/candles. uPlot has no candlestick paths, so
// the first data series owns a custom path builder that draws every candle
// (wick + body) straight to the canvas and returns null to skip uPlot's own
// stroke/fill; the remaining O/H/L/C series stay visible but draw nothing, so
// their data still feeds the y-scale autoscaler and the shared x cursor.
const CANDLE_UP = "#02ffcf";
const CANDLE_DOWN = "#ff6b81";

function candlePaths(u: uPlot, _seriesIdx: number, idx0: number, idx1: number): null {
  const ctx = u.ctx;
  const xs = u.data[0] as ArrayLike<number>;
  const os = u.data[1] as ArrayLike<number>;
  const hs = u.data[2] as ArrayLike<number>;
  const ls = u.data[3] as ArrayLike<number>;
  const cs = u.data[4] as ArrayLike<number>;
  const i0 = Math.max(0, idx0);
  const i1 = Math.min(xs.length - 1, idx1);

  const gaps: number[] = [];
  for (let i = i0; i < i1; i++) {
    const d = u.valToPos(xs[i + 1], "x", true) - u.valToPos(xs[i], "x", true);
    if (d > 0) gaps.push(d);
  }
  gaps.sort((a, b) => a - b);
  const slot = gaps.length ? gaps[gaps.length >> 1] : (u.bbox?.width ?? 600) / Math.max(1, i1 - i0 + 1);
  const bodyW = Math.max(1.5, Math.min(slot * 0.7, 22));

  ctx.save();
  ctx.lineWidth = 1;
  for (let i = i0; i <= i1; i++) {
    const o = os[i], h = hs[i], l = ls[i], c = cs[i];
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    const cx = u.valToPos(xs[i], "x", true);
    const yo = u.valToPos(o, "y", true);
    const yc = u.valToPos(c, "y", true);
    const color = c >= o ? CANDLE_UP : CANDLE_DOWN;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx, u.valToPos(h, "y", true));
    ctx.lineTo(cx, u.valToPos(l, "y", true));
    ctx.stroke();
    ctx.fillRect(cx - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yc - yo)));
  }
  ctx.restore();
  return null;
}

function noopPaths(): null {
  return null;
}

function candleTimeLabel(t: string): string {
  return t.includes("T") ? `${t.slice(0, 16).replace("T", " ")} UTC` : t;
}

function candleTooltipPlugin(candles: Candle[], fmt: (v: number) => string): uPlot.Plugin {
  let el: HTMLDivElement | null = null;

  const update = (u: uPlot) => {
    if (!el) return;
    const idx = u.cursor.idx;
    const cd = idx == null ? null : candles[idx];
    if (!cd) {
      el.style.display = "none";
      return;
    }
    const chg = cd.o > 0 ? ((cd.c - cd.o) / cd.o) * 100 : 0;
    const color = cd.c >= cd.o ? CANDLE_UP : CANDLE_DOWN;
    const row = (label: string, val: string) =>
      `<div class="uplot-tooltip-row"><span class="uplot-tooltip-label">${label}</span><span class="uplot-tooltip-val">${val}</span></div>`;
    el.innerHTML =
      `<div class="uplot-tooltip-date">${escapeHtml(candleTimeLabel(cd.t))}</div>` +
      row("Open", fmt(cd.o)) +
      row("High", fmt(cd.h)) +
      row("Low", fmt(cd.l)) +
      row("Close", fmt(cd.c)) +
      `<div class="uplot-tooltip-row"><span class="uplot-tooltip-label">Change</span>` +
      `<span class="uplot-tooltip-val" style="color:${color}">${(chg >= 0 ? "+" : "") + chg.toFixed(2)}%</span></div>`;
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

export function renderCandles(el: HTMLElement, candles: Candle[], fmt: (v: number) => string = fmtPrice): uPlot | null {
  if (!candles.length || !el) return null;
  destroyChart(el);
  el.innerHTML = "";

  const data = [
    xValues(candles.map((cd) => cd.t)),
    candles.map((cd) => cd.o),
    candles.map((cd) => cd.h),
    candles.map((cd) => cd.l),
    candles.map((cd) => cd.c),
  ];

  const uOpts: uPlot.Options = {
    width: el.clientWidth || 600,
    height: el.clientHeight || 320,
    scales: { x: { time: true } },
    series: [
      {},
      { label: "XEL/USDT", paths: candlePaths, points: { show: false }, width: 0 },
      { label: "high", paths: noopPaths, points: { show: false }, width: 0 },
      { label: "low", paths: noopPaths, points: { show: false }, width: 0 },
      { label: "close", paths: noopPaths, points: { show: false }, width: 0 },
    ],
    axes: [dateAxis(true), yAxis(fmt)],
    legend: { show: false },
    cursor: { points: { show: false }, drag: { x: true, y: false, dist: DRAG_DIST } },
    focus: { alpha: 1 },
    plugins: [autoResizePlugin(el), candleTooltipPlugin(candles, fmt), chartZoomPlugin()],
  };

  const u = new uPlot(uOpts, data as unknown as uPlot.AlignedData, el);
  liveCharts.set(el, u);
  return u;
}

export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const digits = a >= 100 ? 2 : a >= 1 ? 3 : 4;
  return "$" + v.toFixed(digits);
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
