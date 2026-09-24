// Shared "Filter" button + popup for server-rendered table pages. The popup is
// a plain GET <form>, so applying filters navigates with query params and works
// without JavaScript; the client bundle (src/client/filters.ts) only toggles
// visibility and drops empty params before submit. Sorting (sort/dir) is kept
// through hidden inputs; ?page is intentionally dropped so applying starts at
// page 1 of the filtered set.

import { icons } from "../client/icons";

const escA = (v: string): string =>
  v.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

// Filter toggle button for the panel head; `active` marks applied filters.
// `current` surfaces the active scope (e.g. the default period) so a filtered
// default view isn't mistaken for an unfiltered one.
export function filterButton(id: string, active: boolean, current?: string): string {
  const cur = current ? ` <span class="f-cur">${escA(current)}</span>` : "";
  return `<button type="button" class="btn ghost filter-toggle${active ? " on" : ""}" data-filter="${escA(id)}" aria-expanded="false" aria-haspopup="dialog" aria-controls="${escA(id)}" title="Filter this table">${icons.filter} Filter${cur}${active ? ' <span class="fdot" aria-hidden="true"></span>' : ""}</button>`;
}

export interface FilterPopOpts {
  // extra params carried through the form (e.g. current sort)
  hidden?: Record<string, string>;
  // reset link target; defaults to the bare action path
  reset?: string;
}

export function filterPop(id: string, action: string, fields: string, opts: FilterPopOpts = {}): string {
  const hid = Object.entries(opts.hidden ?? {})
    .filter(([k, v]) => k && v)
    .map(([k, v]) => `<input type="hidden" name="${escA(k)}" value="${escA(v)}"/>`)
    .join("");
  return `<div class="filter-pop" id="${escA(id)}" hidden role="dialog" aria-label="Table filters">
    <form method="get" action="${escA(action)}">
      ${hid}
      ${fields}
      <div class="f-actions">
        <a class="btn ghost" href="${escA(opts.reset ?? action)}" title="Clear all filters">Reset</a>
        <button type="submit" class="btn">Apply</button>
      </div>
    </form>
  </div>`;
}

// Label + control pair inside the popup.
export function filterField(label: string, control: string): string {
  return `<label class="f-row"><span class="f-lab">${label}</span>${control}</label>`;
}

// <option> list with an optional "all/any" empty entry; `cur` gets selected.
export function selectOpts(values: string[], cur: string, allLabel?: string, labels?: (v: string) => string): string {
  const opts: string[] = [];
  if (allLabel !== undefined) opts.push(`<option value=""${cur === "" ? " selected" : ""}>${escA(allLabel)}</option>`);
  for (const v of values) opts.push(`<option value="${escA(v)}"${cur === v ? " selected" : ""}>${escA(labels ? labels(v) : v)}</option>`);
  return opts.join("");
}
