// User preferences, persisted in localStorage and applied as classes on
// <html> so plain CSS can react to them. Keys are namespaced with `xelis:`.
//
// The layout head runs a tiny inline copy of applyPrefs() before first paint so
// stored preferences do not flash; keep the two in sync when adding keys.

export const PREF_KEYS = {
  revealFlags: "xelis:reveal-flags",
  density: "xelis:density",
  reduceMotion: "xelis:reduce-motion",
  live: "xelis:live",
  numberFormat: "xelis:number-format",
  timezone: "xelis:timezone",
  timeStyle: "xelis:time-style",
} as const;

export type Density = "comfortable" | "compact";
export type NumberFormat = "compact" | "plain";
export type Timezone = "utc" | "local";
export type TimeStyle = "24" | "12";

export function getPref(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode / storage disabled — preferences are best-effort
  }
}

export function getDensity(): Density {
  return getPref(PREF_KEYS.density, "comfortable") === "compact" ? "compact" : "comfortable";
}

export function isLiveEnabled(): boolean {
  return getPref(PREF_KEYS.live, "1") !== "0";
}

export function getNumberFormat(): NumberFormat {
  return getPref(PREF_KEYS.numberFormat, "compact") === "plain" ? "plain" : "compact";
}

export function getTimezone(): Timezone {
  return getPref(PREF_KEYS.timezone, "utc") === "local" ? "local" : "utc";
}

export function getTimeStyle(): TimeStyle {
  return getPref(PREF_KEYS.timeStyle, "12") === "12" ? "12" : "24";
}

// Minimal structural type so this module stays importable from the Worker
// build (no DOM lib). The caller passes <html>; absent one, look it up.
type ClassRoot = { classList: { toggle(token: string, force?: boolean): void } };

export function applyPrefs(root?: ClassRoot): void {
  const el = root ?? (globalThis as { document?: { documentElement: ClassRoot } }).document?.documentElement;
  if (!el) return;
  el.classList.toggle("reveal-flags", getPref(PREF_KEYS.revealFlags) === "1");
  el.classList.toggle("density-compact", getDensity() === "compact");
  el.classList.toggle("reduce-motion", getPref(PREF_KEYS.reduceMotion) === "1");
}
