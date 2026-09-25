import { ago, formatStamp } from "./format";
import { getHashStyle, getTimeFormat, getTimezone, getTimeStyle, type HashStyle, type TimeFormat, type TimeStyle, type Timezone } from "./prefs";

// Server-rendered pages emit timestamps as "YYYY-MM-DD HH:MM:SS UTC". The time
// zone and time style preferences are browser-local, so when either is set to a
// non-default value this upgrades those timestamps in place to local time
// and/or a 12-hour clock. Runs on every page; the defaults are a no-op.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)? UTC$/;

// Relative ages go stale, so re-render them on a slow tick.
const TICK_MS = 30000;

// shortHash() renders "HEAD…TAIL". The hash style preference may keep only one
// side, so those are rewritten in place; the canonical form is remembered per
// text node so switching back restores the full hash without a reload.
const HASH_SEP = "\u2026";
const HASH_FULL = /[0-9A-Za-z]+\u2026[0-9A-Za-z]+/;
const HASH_FULL_G = /[0-9A-Za-z]+\u2026[0-9A-Za-z]+/g;
const HASH_ANY = /[0-9A-Za-z]+\u2026(?:[0-9A-Za-z]+)?|\u2026[0-9A-Za-z]+/;
const canonicalHash = new WeakMap<Text, string>();

export function initFormatDisplay(): void {
  if (typeof document === "undefined") return;
  rewriteAll();
  window.addEventListener("xelis:format-change", rewriteAll);
  window.setInterval(tickAges, TICK_MS);
  observeHashes();
}

// Hashes inside client-rendered widgets (dashboard tables) appear after load,
// so apply the style as their subtrees are inserted.
function observeHashes(): void {
  if (typeof MutationObserver === "undefined") return;
  new MutationObserver((mutations) => {
    const style = getHashStyle();
    for (const m of mutations) {
      for (const node of Array.from(m.addedNodes)) {
        if (node.nodeType === Node.TEXT_NODE) renderHash(node as Text, style);
        else if (node.nodeType === Node.ELEMENT_NODE) rewriteHashes(node as Element, style);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function styleHash(match: string, style: HashStyle): string {
  const i = match.indexOf(HASH_SEP);
  if (i < 0) return match;
  if (style === "head") return match.slice(0, i) + HASH_SEP;
  if (style === "tail") return HASH_SEP + match.slice(i + 1);
  return match;
}

function renderHash(node: Text, style: HashStyle): void {
  const stored = canonicalHash.get(node);
  if (stored !== undefined) {
    node.nodeValue = stored.replace(HASH_FULL_G, (m) => styleHash(m, style));
    return;
  }
  const raw = node.nodeValue ?? "";
  if (!HASH_FULL.test(raw)) return;
  canonicalHash.set(node, raw);
  const next = raw.replace(HASH_FULL_G, (m) => styleHash(m, style));
  if (node.nodeValue !== next) node.nodeValue = next;
}

function rewriteHashes(root: ParentNode, style: HashStyle): void {
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const tag = (node.parentNode as Element | null)?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
      return HASH_ANY.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) renderHash(node, style);
}

// The time format preference only changes the clock at render time, so the
// cheaper per-tick path skips the STAMP walker.
function tickAges(): void {
  const format = getTimeFormat();
  if (format === "absolute") return;
  const tz = getTimezone();
  const style = getTimeStyle();
  for (const el of timeElements()) renderTime(el, tz, style, format);
}

function timeElements(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".time[data-ts]"));
}

function renderTime(el: HTMLElement, tz: Timezone, style: TimeStyle, format: TimeFormat): void {
  const ms = Number(el.dataset.ts);
  if (!Number.isFinite(ms)) return;
  const abs = formatStamp(new Date(ms), tz, style);
  if (format === "absolute") {
    el.textContent = abs;
    el.title = ago(ms);
    return;
  }
  const rel = ago(ms);
  el.textContent = format === "both" ? `${rel} · ${abs}` : rel;
  el.title = abs;
}

function rewriteAll(): void {
  const tz = getTimezone();
  const style = getTimeStyle();
  const format = getTimeFormat();
  for (const el of timeElements()) renderTime(el, tz, style, format);
  rewriteHashes(document.body, getHashStyle());
  if (tz === "utc" && style === "24") return;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const tag = (node.parentNode as Element | null)?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
      return STAMP.test(node.nodeValue?.trim() ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  for (const node of nodes) {
    const raw = node.nodeValue ?? "";
    const trimmed = raw.trim();
    const m = STAMP.exec(trimmed);
    if (!m) continue;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    if (!Number.isFinite(d.getTime())) continue;
    const at = raw.indexOf(trimmed);
    node.nodeValue = raw.slice(0, at) + formatStamp(d, tz, style) + raw.slice(at + trimmed.length);
  }
}