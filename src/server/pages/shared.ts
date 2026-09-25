import { fmtInt } from "../../client/format";
import { icons } from "../../client/icons";
import { escHtml } from "../../client/layout";
import { containsBadWord } from "../../client/badwords";
import { knownEntity } from "../entities";

export const PAGE_SIZE = 25;

// Bound a numeric query param: finite, integer, within [1, max]; falls back to
// the default for garbage input (NaN, negatives, floats, Infinity).
export const clampInt = (value: string | undefined, def: number, max: number): number => {
  const n = Number(value ?? def);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

// Log swallowed page errors with a scope tag so observability can distinguish
// "empty data" from a failing query.
export const logErr = (scope: string, err: unknown): void => {
  console.error(`${scope}:`, err instanceof Error ? err.message : String(err));
};

export function pager(base: string, page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const href = (p: number) => `${base}${base.includes("?") ? "&" : "?"}page=${p}`;
  const nums: (number | "…")[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const dim = (label: string) => `<span class="btn ghost disabled" aria-disabled="true">${label}</span>`;
  return `<div class="pager">
    ${page > 1 ? `<a class="btn ghost" href="${href(1)}">${icons.chevronsLeft} First</a>` : dim(`${icons.chevronsLeft} First`)}
    ${page > 1 ? `<a class="btn ghost" href="${href(page - 1)}">${icons.chevronLeft} Prev</a>` : dim(`${icons.chevronLeft} Prev`)}
    ${nums.map((p) => p === "…"
      ? `<span class="pager-dots">…</span>`
      : p === page
        ? `<span class="btn mint" aria-current="page">${p}</span>`
        : `<a class="btn ghost" href="${href(p)}">${p}</a>`).join("")}
    ${page < totalPages ? `<a class="btn ghost" href="${href(page + 1)}">Next ${icons.chevronRight}</a>` : dim(`Next ${icons.chevronRight}`)}
    ${page < totalPages ? `<a class="btn ghost" href="${href(totalPages)}">Last ${icons.chevronsRight}</a>` : dim(`Last ${icons.chevronsRight}`)}
    <span class="pager-info">Page ${fmtInt(page)} of ${fmtInt(totalPages)}</span>
  </div>`;
}

// Cursor-based pager for keyset pagination: any depth is an index seek, so
// there are no page numbers, only First/Prev/Next/Last by cursor.
export function cursorPager(opts: {
  first?: string | null;
  prev?: string | null;
  next?: string | null;
  last?: string | null;
  info: string;
}): string {
  const dim = (label: string) => `<span class="btn ghost disabled" aria-disabled="true">${label}</span>`;
  const nav = (href: string | null | undefined, label: string) =>
    href ? `<a class="btn ghost" href="${href}">${label}</a>` : dim(label);
  return `<div class="pager">
    ${nav(opts.first, `${icons.chevronsLeft} First`)}
    ${nav(opts.prev, `${icons.chevronLeft} Prev`)}
    ${nav(opts.next, `Next ${icons.chevronRight}`)}
    ${nav(opts.last, `Last ${icons.chevronsRight}`)}
    <span class="pager-info">${opts.info}</span>
  </div>`;
}

// Single source of truth for HTML escaping (defined next to the layout).
export const esc = escHtml;

// Safe interpolation into a single-quoted JS string inside a double-quoted HTML
// attribute (inline handlers such as onclick). HTML-escapes first, then
// neutralises backslashes, quotes and newlines so the value cannot break out of
// the JS string once the HTML parser decodes the attribute.
export const jsq = (v: unknown): string =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\x27")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");

export const entityTag = (address: string): string => {
  const e = knownEntity(address);
  return e ? ` <span class="badge entity ${esc(e.kind)}">${esc(e.label)}</span>` : "";
};

// User-supplied text (asset names/symbols, peer tags) that trips the bad-word
// check is hidden by default; the header eye toggle (html.reveal-flags)
// reveals it. Both variants are emitted, so the switch works without a reload.
export const flaggedText = (value: unknown): string => {
  const text = String(value ?? "");
  if (!containsBadWord(text)) return esc(text);
  return `<span class="flagwrap"><span class="flag-hid" title="Filtered content · enable it in Settings to reveal">${icons.eyeOff} filtered</span><span class="flag-shown">${esc(text)}</span></span>`;
};

// executed is 1 (executed ok), 0 (not executed) or NULL (not recorded, legacy rows)
export const resultBadge = (executed: unknown): string =>
  `<span class="badge ${executed === 1 ? "ok" : executed === 0 ? "fail" : ""}">${executed === 1 ? "executed" : executed === 0 ? "unexecuted" : "unknown"}</span>`;

export const blkCopyScript = `function blkCopy(txt,btn){var flip=function(){var t=btn.textContent;btn.textContent="copied";btn.classList.add("done");setTimeout(function(){btn.textContent=t;btn.classList.remove("done");},1200);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(flip);}else{var i=document.createElement("textarea");i.value=txt;document.body.appendChild(i);i.select();try{document.execCommand("copy");}catch(e){}document.body.removeChild(i);flip();}}`;

export const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
