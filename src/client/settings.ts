import { PREF_KEYS, getDensity, getHashStyle, getNumberFormat, getPref, getTimeFormat, getTimezone, getTimeStyle, isLiveEnabled, setPref } from "./prefs";

// Wires the controls on /settings. Preferences persist in localStorage and are
// applied live so the page reflects changes without a reload.
export function initSettings(): void {
  const reveal = document.getElementById("pref-reveal-flags") as HTMLInputElement | null;
  const density = document.getElementById("pref-density") as HTMLSelectElement | null;
  const numberFormat = document.getElementById("pref-number-format") as HTMLSelectElement | null;
  const timezone = document.getElementById("pref-timezone") as HTMLSelectElement | null;
  const timeStyle = document.getElementById("pref-time-style") as HTMLSelectElement | null;
  const timeFormat = document.getElementById("pref-time-format") as HTMLSelectElement | null;
  const hashStyle = document.getElementById("pref-hash-style") as HTMLSelectElement | null;
  const motion = document.getElementById("pref-reduce-motion") as HTMLInputElement | null;
  const live = document.getElementById("pref-live") as HTMLInputElement | null;
  const reset = document.getElementById("pref-reset") as HTMLButtonElement | null;
  if (!reveal && !density && !numberFormat && !timezone && !timeStyle && !timeFormat && !hashStyle && !motion && !live) return;

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

  const syncFormat = (): void => {
    window.dispatchEvent(new CustomEvent("xelis:format-change"));
  };

  if (numberFormat) {
    numberFormat.value = getNumberFormat();
    numberFormat.addEventListener("change", () => {
      setPref(PREF_KEYS.numberFormat, numberFormat.value === "plain" ? "plain" : "compact");
      syncFormat();
    });
  }

  if (timezone) {
    timezone.value = getTimezone();
    timezone.addEventListener("change", () => {
      setPref(PREF_KEYS.timezone, timezone.value === "local" ? "local" : "utc");
      syncFormat();
    });
  }

  if (timeStyle) {
    timeStyle.value = getTimeStyle();
    timeStyle.addEventListener("change", () => {
      setPref(PREF_KEYS.timeStyle, timeStyle.value === "12" ? "12" : "24");
      syncFormat();
    });
  }

  if (timeFormat) {
    timeFormat.value = getTimeFormat();
    timeFormat.addEventListener("change", () => {
      const value = timeFormat.value;
      setPref(PREF_KEYS.timeFormat, value === "absolute" || value === "both" ? value : "relative");
      syncFormat();
    });
  }

  if (hashStyle) {
    hashStyle.value = getHashStyle();
    hashStyle.addEventListener("change", () => {
      const value = hashStyle.value;
      setPref(PREF_KEYS.hashStyle, value === "head" || value === "tail" ? value : "both");
      syncFormat();
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
      if (numberFormat) numberFormat.value = "compact";
      if (timezone) timezone.value = "utc";
      if (timeStyle) timeStyle.value = "12"; // matches the getTimeStyle() default
      if (timeFormat) timeFormat.value = "relative";
      if (hashStyle) hashStyle.value = "both";
      syncFormat();
      if (live) {
        live.checked = true;
        window.dispatchEvent(new CustomEvent("xelis:live-change", { detail: { enabled: true } }));
      }
    });
  }
}
