import { getNumberFormat, getTimezone, getTimeStyle, type TimeStyle, type Timezone } from "./prefs";

export const XEL_LOGO = `<svg width="778" height="743" viewBox="0 0 778 743" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M388.909 742.872L777.817 353.964L424.056 0.202599L478.809 132.737L700.036 353.964L388.909 665.091L77.7817 353.964L299.507 129.121L353.964 0L0 353.964L388.909 742.872Z" fill="currentColor"></path><path d="M388.909 665.091L353.964 0L299.507 129.121L388.909 665.091Z" fill="currentColor"></path><path d="M424.056 0.202599L388.909 665.091L478.809 132.737L424.056 0.202599Z" fill="currentColor"></path></svg>`;

export function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (getNumberFormat() === "plain") {
    return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
  }
  if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
  return n.toFixed(decimals);
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("en-US");
}

// XEL atomic units precision (verify via get_asset at runtime)
export const XEL_PRECISION = 1e8;
export function atomic(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return fmt(n / XEL_PRECISION, decimals);
}

// precise XEL formatting for tiny amounts (fees): 3 significant digits, no exponent
export function atomicPrecise(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const v = n / XEL_PRECISION;
  if (v === 0) return "0.00";
  if (v >= 0.01) return fmt(v, 2);
  return v.toFixed(Math.min(10, 2 - Math.floor(Math.log10(v))));
}

// metrics whose history is reported in whole XEL, as tiny fractions
export const FEE_METRICS = new Set(["fees", "fees-median", "fee-p90", "fees-p99"]);

// whole-XEL amounts with 3 significant digits in fixed notation (no exponent),
// so an average fee like 0.00129 XEL is not rounded away to "0.00".
export function fmtXel(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "0.00";
  const a = Math.abs(n);
  if (a >= 0.01) return fmt(n, 2);
  return n.toFixed(Math.min(10, 2 - Math.floor(Math.log10(a))));
}

// axis/tooltip formatter for a history metric, matching the units the API
// reports it in (whole XEL for fees, bytes for chain size, plain numbers else)
export function metricFormatter(metric: string): (n: number) => string {
  if (metric === "chain-size") return fmtBytes;
  if (FEE_METRICS.has(metric)) return fmtXel;
  if (metric === "hashprice") return (n) => `$${fmt(n, 2)}`;
  return (n) => fmt(n, 2);
}

// binary byte sizes: 9.6 GiB-style, for on-disk chain size
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 || v >= 100 ? v.toFixed(0) : v.toFixed(2)} ${units[i]}`;
}

export function shortHash(h: string | null | undefined, size = 6): string {
  if (!h) return "—";
  if (h.length <= size * 2 + 3) return h;
  return `${h.slice(0, size)}…${h.slice(-size)}`;
}

// daemon/collector timestamps are milliseconds; legacy rows may be seconds;
// ISO strings are parsed directly.
export function toMs(ts: number | string | null | undefined): number {
  if (ts === null || ts === undefined || ts === "" || ts === 0) return NaN;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  if (!Number.isFinite(ts)) return NaN;
  return ts >= 1e11 ? ts : ts * 1000;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// short zone label for local time (e.g. "GMT+2"), falling back to "local"
function zoneLabel(d: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(d);
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

// "YYYY-MM-DD HH:MM:SS ZONE" in UTC or local time, 24h or 12h
export function formatStamp(d: Date, tz: Timezone, style: TimeStyle): string {
  const h12 = (h: number): [number, string] => (h < 12 ? [h % 12 || 12, "AM"] : [h % 12 || 12, "PM"]);
  if (tz === "utc") {
    const date = d.toISOString().slice(0, 10);
    const [h, m, s] = d.toISOString().slice(11, 19).split(":").map(Number);
    const [hh, ap] = style === "12" ? h12(h) : [h, ""];
    return `${date} ${pad(hh)}:${pad(m)}:${pad(s)}${ap ? ` ${ap}` : ""} UTC`;
  }
  const [hh, ap] = style === "12" ? h12(d.getHours()) : [d.getHours(), ""];
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hh)}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ap ? ` ${ap}` : ""} ${zoneLabel(d)}`;
}

export function fmtTime(ts: number | string | null | undefined): string {
  const d = new Date(toMs(ts));
  if (!Number.isFinite(d.getTime())) return "—";
  return formatStamp(d, getTimezone(), getTimeStyle());
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

// Compact relative age ("2m ago", "3mo ago", "in 4h") for scanning tables.
// sortable.ts parses the same units, so keep the two in sync when adding one.
export function ago(ts: number | string | null | undefined): string {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return "—";
  const future = ms > Date.now();
  const s = Math.floor(Math.abs(Date.now() - ms) / 1000);
  const stamp = (n: number, u: string): string => (future ? `in ${n}${u}` : `${n}${u} ago`);
  if (s < 45) return future ? "in a moment" : "just now";
  if (s < 90) return stamp(s, "s");
  if (s < 3600) return stamp(Math.round(s / 60), "m");
  if (s < 86400) return stamp(Math.round(s / 3600), "h");
  if (s < 604800) return stamp(Math.round(s / 86400), "d");
  if (s < 2629800) return stamp(Math.round(s / 604800), "w");
  if (s < 31557600) return stamp(Math.round(s / 2629800), "mo");
  return stamp(Math.round(s / 31557600), "y");
}

// Server-rendered time cell: relative age with the exact timestamp in the
// tooltip. format-display.ts rewrites it in place when the browser's time
// format, zone or clock preference differs.
export function timeCell(ts: number | string | null | undefined): string {
  const ms = toMs(ts);
  if (!Number.isFinite(ms)) return `<span class="time">—</span>`;
  const abs = formatStamp(new Date(ms), getTimezone(), getTimeStyle());
  return `<span class="time" data-ts="${ms}" title="${abs}">${ago(ms)}</span>`;
}
