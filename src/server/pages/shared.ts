import { fmtInt } from "../../client/format";
import { knownEntity } from "../entities";

export const PAGE_SIZE = 25;

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
    ${page > 1 ? `<a class="btn ghost" href="${href(1)}">« First</a>` : dim("« First")}
    ${page > 1 ? `<a class="btn ghost" href="${href(page - 1)}">‹ Prev</a>` : dim("‹ Prev")}
    ${nums.map((p) => p === "…"
      ? `<span class="pager-dots">…</span>`
      : p === page
        ? `<span class="btn mint" aria-current="page">${p}</span>`
        : `<a class="btn ghost" href="${href(p)}">${p}</a>`).join("")}
    ${page < totalPages ? `<a class="btn ghost" href="${href(page + 1)}">Next ›</a>` : dim("Next ›")}
    ${page < totalPages ? `<a class="btn ghost" href="${href(totalPages)}">Last »</a>` : dim("Last »")}
    <span class="pager-info">Page ${fmtInt(page)} of ${fmtInt(totalPages)}</span>
  </div>`;
}

export const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

export const entityTag = (address: string): string => {
  const e = knownEntity(address);
  return e ? ` <span class="badge entity ${esc(e.kind)}">${esc(e.label)}</span>` : "";
};

// result is NULL for rows backfilled before the column existed
export const resultBadge = (result: unknown): string =>
  `<span class="badge ${result === "ok" ? "ok" : result ? "fail" : ""}">${esc(result ?? "unknown")}</span>`;

export const blkCopyScript = `function blkCopy(txt,btn){var flip=function(){var t=btn.textContent;btn.textContent="copied";btn.classList.add("done");setTimeout(function(){btn.textContent=t;btn.classList.remove("done");},1200);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(flip);}else{var i=document.createElement("textarea");i.value=txt;document.body.appendChild(i);i.select();try{document.execCommand("copy");}catch(e){}document.body.removeChild(i);flip();}}`;

export const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
