// /embeds builder: keeps the preview iframe, copyable snippet and "open chart"
// link in sync with the metric/range/interval/size controls, and wires the
// per-metric "customize" buttons in the metrics table.

import { copyText } from "./storage";

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 220;
const MIN_WIDTH = 200;
const MAX_WIDTH = 1600;
const MIN_HEIGHT = 140;
const MAX_HEIGHT = 900;

function initEmbedBuilder(): void {
  const $ = (id: string): HTMLElement | null => document.getElementById(id);
  const selMetric = $("emb-metric") as HTMLSelectElement | null;
  const selRange = $("emb-range") as HTMLSelectElement | null;
  const selInterval = $("emb-interval") as HTMLSelectElement | null;
  const inpWidth = $("emb-width") as HTMLInputElement | null;
  const inpHeight = $("emb-height") as HTMLInputElement | null;
  const frame = $("emb-preview") as HTMLIFrameElement | null;
  const pre = $("emb-snippet");
  const copyBtn = $("emb-copy");
  const openLink = $("emb-open") as HTMLAnchorElement | null;
  if (!selMetric || !selRange || !selInterval || !inpWidth || !inpHeight || !frame || !pre) return;

  const clamp = (v: string, lo: number, hi: number, fallback: number): number => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };

  function update(): void {
    const metric = selMetric!.value;
    const range = selRange!.value;
    const interval = selInterval!.value;
    const width = clamp(inpWidth!.value, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH);
    const height = clamp(inpHeight!.value, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT);
    const label = selMetric!.options[selMetric!.selectedIndex]?.text ?? metric;
    // same-origin absolute URL so the snippet works when pasted anywhere
    const src = `${location.origin}/embed/${encodeURIComponent(metric)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    frame!.src = src;
    frame!.width = String(width);
    frame!.height = String(height);
    frame!.title = `Xelis Stats — ${label}`;
    pre!.textContent = `<iframe src="${src}" width="${width}" height="${height}" style="border:0;border-radius:12px" title="Xelis Stats — ${label}" loading="lazy"></iframe>`;
    if (openLink) openLink.href = src;
  }

  // size inputs reload the preview iframe, so wait for a pause in typing and
  // snap the field back to the clamped value once editing ends
  let sizeTimer = 0;
  const updateSoon = (): void => {
    window.clearTimeout(sizeTimer);
    sizeTimer = window.setTimeout(update, 300);
  };
  const commitSize = (inp: HTMLInputElement, lo: number, hi: number, fallback: number): void => {
    inp.value = String(clamp(inp.value, lo, hi, fallback));
    update();
  };

  selMetric.addEventListener("change", update);
  selRange.addEventListener("change", update);
  selInterval.addEventListener("change", update);
  inpWidth.addEventListener("input", updateSoon);
  inpHeight.addEventListener("input", updateSoon);
  inpWidth.addEventListener("change", () => commitSize(inpWidth, MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH));
  inpHeight.addEventListener("change", () => commitSize(inpHeight, MIN_HEIGHT, MAX_HEIGHT, DEFAULT_HEIGHT));
  copyBtn?.addEventListener("click", () => copyText(pre.textContent ?? "", copyBtn));

  // "customize" buttons: load that metric into the builder and jump to it
  const builder = $("emb-builder");
  document.querySelectorAll<HTMLButtonElement>("[data-emb-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const metric = btn.dataset.embMetric;
      if (!metric) return;
      selMetric.value = metric;
      update();
      const smooth = !document.documentElement.classList.contains("reduce-motion");
      builder?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    });
  });

  update();
}

initEmbedBuilder();
