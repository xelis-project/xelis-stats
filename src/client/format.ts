export const XEL_LOGO = `<svg width="778" height="743" viewBox="0 0 778 743" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M388.909 742.872L777.817 353.964L424.056 0.202599L478.809 132.737L700.036 353.964L388.909 665.091L77.7817 353.964L299.507 129.121L353.964 0L0 353.964L388.909 742.872Z" fill="currentColor"></path><path d="M388.909 665.091L353.964 0L299.507 129.121L388.909 665.091Z" fill="currentColor"></path><path d="M424.056 0.202599L388.909 665.091L478.809 132.737L424.056 0.202599Z" fill="currentColor"></path></svg>`;

export function fmt(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
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

// daemon/collector timestamps are milliseconds; legacy rows may be seconds
function toMs(ts: number): number {
  return ts >= 1e11 ? ts : ts * 1000;
}

export function fmtTime(ts: number | string | null | undefined): string {
  if (!ts) return "—";
  const d = typeof ts === "string" ? new Date(ts) : new Date(toMs(ts));
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - toMs(ts)) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
