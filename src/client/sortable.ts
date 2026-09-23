// Click-to-sort table headers. Sorting is client-side over the rows currently
// loaded in each table (server pages are paginated, so this sorts the visible
// page). Widget and market tables refresh their rows periodically; sort state
// lives on the stable container and is re-applied after each refresh via
// refreshSort().

type Dir = 1 | -1;

interface SortState {
  col: number;
  dir: Dir;
}

interface Cell {
  // null num + empty str = placeholder ("—"), sorts last
  num: number | null;
  str: string;
  kind: "num" | "ago" | "str" | "empty";
}

const state = new WeakMap<HTMLElement, SortState>();
const MULTIPLIERS: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };
const AGO_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const NUM_RE = /^(-?\d+(?:\.\d+)?)([a-z%]*)$/;
const AGO_RE = /^(\d+(?:\.\d+)?)\s*([dhms])\s*ago$/;

function cellOf(td: HTMLTableCellElement | undefined): Cell {
  const raw = (td?.textContent ?? "").trim().replace(/\s+/g, " ");
  if (!raw || raw === "—" || raw === "-") return { num: null, str: "", kind: "empty" };
  const low = raw.toLowerCase();
  if (low === "just now") return { num: 0, str: low, kind: "ago" };
  const ago = AGO_RE.exec(low);
  if (ago) return { num: Number(ago[1]) * AGO_UNITS[ago[2]], str: low, kind: "ago" };
  // "$1,234.56", "+2.35%", "0.59 XEL" -> plain number; suffix kept as text tiebreak
  const compact = low.replace(/[$,+\s]/g, "");
  const m = NUM_RE.exec(compact);
  if (m) {
    let num = Number(m[1]);
    const suffix = m[2];
    // "1.23B" is an abbreviation (fmt), "1,234 B" is a unit (bytes) — the
    // space before the suffix is the tell
    const spaced = /\s[a-z%]+$/i.test(raw);
    if (!spaced && suffix.length === 1 && suffix in MULTIPLIERS) num *= MULTIPLIERS[suffix];
    return { num, str: low, kind: "num" };
  }
  return { num: null, str: low, kind: "str" };
}

// The stable element sort state is keyed on: the table itself, except widget
// tables whose whole <table> is replaced on refresh — there the .w-table
// container survives, so state keys on it.
function scopeOf(table: HTMLTableElement): HTMLElement {
  const parent = table.parentElement;
  return parent && parent.classList.contains("w-table") ? parent : table;
}

function sortTable(table: HTMLTableElement, col: number, dir: Dir): void {
  const tbody = table.tBodies[0];
  if (!tbody) return;
  const rows = Array.from(tbody.rows);
  const cells = rows.map((tr) => ({ tr, c: cellOf(tr.cells[col] as HTMLTableCellElement | undefined) }));
  const numeric = cells.every((x) => x.c.kind === "num" || x.c.kind === "ago" || x.c.kind === "empty");
  cells.sort((a, b) => {
    if (a.c.kind === "empty" && b.c.kind === "empty") return 0;
    if (a.c.kind === "empty") return 1;
    if (b.c.kind === "empty") return -1;
    if (numeric) return (a.c.num! - b.c.num!) * dir;
    return a.c.str.localeCompare(b.c.str) * dir;
  });
  for (const { tr } of cells) tbody.appendChild(tr);
}

// Default direction: numbers biggest-first, ages newest-first, text A→Z.
function defaultDir(table: HTMLTableElement, col: number): Dir {
  const cells = Array.from(table.tBodies[0]?.rows ?? []).map((tr) => cellOf(tr.cells[col] as HTMLTableCellElement | undefined));
  if (cells.some((c) => c.kind === "ago") && cells.every((c) => c.kind !== "num")) return 1;
  return cells.some((c) => c.kind === "num") ? -1 : 1;
}

function paint(table: HTMLTableElement, active: SortState | null): void {
  for (const th of Array.from(table.tHead?.rows[0]?.cells ?? [])) {
    if (!th.classList.contains("sortable")) continue;
    const on = active && th.cellIndex === active.col;
    th.dataset.dir = on ? (active.dir === 1 ? "asc" : "desc") : "";
    th.setAttribute("aria-sort", on ? (active.dir === 1 ? "ascending" : "descending") : "none");
    if (!on) delete th.dataset.dir;
  }
}

function apply(table: HTMLTableElement, col: number, dir: Dir): void {
  const s: SortState = { col, dir };
  state.set(scopeOf(table), s);
  sortTable(table, col, dir);
  paint(table, s);
}

function enhance(table: HTMLTableElement): void {
  // server-sorted tables navigate instead — never client-sort or re-mark them
  if (table.dataset.srvsort) return;
  if (table.dataset.sortable) return;
  table.dataset.sortable = "1";
  const head = table.tHead;
  if (!head?.rows.length) return;
  for (const th of Array.from(head.rows[0].cells)) {
    if (th.tagName !== "TH" || th.hasAttribute("colspan")) continue;
    th.classList.add("sortable");
    th.tabIndex = 0;
    th.setAttribute("aria-sort", "none");
  }
  table.addEventListener("click", (ev) => {
    const th = (ev.target as HTMLElement).closest("th");
    if (!th || !th.classList.contains("sortable")) return;
    const prev = state.get(scopeOf(table));
    const col = th.cellIndex;
    const dir: Dir = prev && prev.col === col ? ((prev.dir * -1) as Dir) : defaultDir(table, col);
    apply(table, col, dir);
  });
  table.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const th = (ev.target as HTMLElement).closest("th");
    if (!th || !th.classList.contains("sortable")) return;
    ev.preventDefault();
    th.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function tableIn(scope: HTMLElement): HTMLTableElement | null {
  if (scope.tagName === "TABLE") return scope as HTMLTableElement;
  return scope.querySelector("table");
}

// Re-bind sort state after a table's rows have been re-rendered. Call with the
// stable container (.w-table for widgets, the table element elsewhere).
export function refreshSort(scope: HTMLElement): void {
  const table = tableIn(scope);
  if (!table) return;
  enhance(table);
  const s = state.get(scopeOf(table));
  if (s && table.tBodies.length) {
    sortTable(table, s.col, s.dir);
    paint(table, s);
  }
}

export function initSortableTables(): void {
  for (const el of Array.from(document.querySelectorAll("table"))) {
    const table = el as HTMLTableElement;
    // key–value detail tables have no sortable columns; server-sorted tables
    // sort in SQL and their headers are links, not click handlers
    if (table.classList.contains("kv") || table.dataset.srvsort) continue;
    if (!table.tHead?.rows.length || !table.tBodies.length) continue;
    enhance(table);
  }
}
