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
} as const;

export type Density = "comfortable" | "compact";

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

export function applyPrefs(root: HTMLElement = document.documentElement): void {
  root.classList.toggle("reveal-flags", getPref(PREF_KEYS.revealFlags) === "1");
  root.classList.toggle("density-compact", getDensity() === "compact");
  root.classList.toggle("reduce-motion", getPref(PREF_KEYS.reduceMotion) === "1");
}
