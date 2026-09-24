import { PREF_KEYS, getDensity, getPref, isLiveEnabled, setPref } from "./prefs";

// Wires the controls on /settings. Preferences persist in localStorage and are
// applied live so the page reflects changes without a reload.
export function initSettings(): void {
  const reveal = document.getElementById("pref-reveal-flags") as HTMLInputElement | null;
  const density = document.getElementById("pref-density") as HTMLSelectElement | null;
  const motion = document.getElementById("pref-reduce-motion") as HTMLInputElement | null;
  const live = document.getElementById("pref-live") as HTMLInputElement | null;
  const reset = document.getElementById("pref-reset") as HTMLButtonElement | null;
  if (!reveal && !density && !motion && !live) return;

  const root = document.documentElement;
  const syncReveal = (on: boolean): void => { root.classList.toggle("reveal-flags", on); };
  const syncMotion = (on: boolean): void => { root.classList.toggle("reduce-motion", on); };

  if (reveal) {
    reveal.checked = getPref(PREF_KEYS.revealFlags) === "1";
    reveal.addEventListener("change", () => {
      setPref(PREF_KEYS.revealFlags, reveal.checked ? "1" : "0");
      syncReveal(reveal.checked);
    });
  }

  if (density) {
    density.value = getDensity();
    density.addEventListener("change", () => {
      const value = density.value === "compact" ? "compact" : "comfortable";
      setPref(PREF_KEYS.density, value);
      root.classList.toggle("density-compact", value === "compact");
    });
  }

  if (motion) {
    motion.checked = getPref(PREF_KEYS.reduceMotion) === "1";
    motion.addEventListener("change", () => {
      setPref(PREF_KEYS.reduceMotion, motion.checked ? "1" : "0");
      syncMotion(motion.checked);
    });
  }

  if (live) {
    live.checked = isLiveEnabled();
    live.addEventListener("change", () => {
      setPref(PREF_KEYS.live, live.checked ? "1" : "0");
      window.dispatchEvent(new CustomEvent("xelis:live-change", { detail: { enabled: live.checked } }));
    });
  }

  if (reset) {
    reset.addEventListener("click", () => {
      try {
        for (const key of Object.values(PREF_KEYS)) localStorage.removeItem(key);
      } catch {
        // storage disabled
      }
      syncReveal(false);
      syncMotion(false);
      root.classList.remove("density-compact");
      if (reveal) reveal.checked = false;
      if (motion) motion.checked = false;
      if (density) density.value = "comfortable";
      if (live) {
        live.checked = true;
        window.dispatchEvent(new CustomEvent("xelis:live-change", { detail: { enabled: true } }));
      }
    });
  }
}
