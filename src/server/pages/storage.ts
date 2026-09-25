/**
 * Contract storage panel rendering (Xelis contract data entries).
 *
 * The node RPC `get_contract_data_entries` returns DataEntry { key, value }
 * where both sides are DataValue JSONs:
 *   { type: "primitive", value: { type: "u8"|"u64"|"u128"|"string"|"bool"|"null"|…, value } }
 *   { type: "opaque",    value: { type: "Address"|"Hash", value } }
 *   { type: "object",    value: DataValue[] }   (tuple)
 *   { type: "map",       value: [key, value][] }
 * dv() unwraps these into an interactive tree with type chips; storageEntry()
 * renders one compact row (collapsed) whose body holds the decoded tree, a raw
 * JSON view and copy actions. storageBatchHtml() renders a load-more batch.
 * Search/filter/toggle behaviour lives in src/client/storage.ts.
 */
import { esc, num } from "./shared";
import { fmtInt } from "../../client/format";
import { rpc } from "../xelis";

export const STORAGE_PAGE = 20;

type Dv = {
  kind: string;
  html: string;
  plain: string;
  preview: string;
  container: boolean;
};

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + "…" : s);

const safeJson = (v: unknown, pretty = false): string => {
  try {
    return JSON.stringify(v, null, pretty ? 2 : 0) ?? String(v);
  } catch {
    return String(v);
  }
};

const dvBool = (b: boolean): Dv => ({
  kind: "BOOL",
  html: `<span class="stg-bool${b ? "" : " false"}">${b}</span>`,
  plain: String(b),
  preview: String(b),
  container: false,
});

const dvNull = (): Dv => ({ kind: "NULL", html: '<span class="stg-null">null</span>', plain: "null", preview: "null", container: false });

const dvStr = (s: string): Dv => ({
  kind: "STRING",
  html: `<span class="stg-str">${esc(s)}</span>`,
  plain: s,
  preview: clip(oneLine(s), 140),
  container: false,
});

// 1234567 → "1,234,567"; falls back to the raw value when already lossy or fractional
const fmtNum = (n: number): string =>
  Number.isInteger(n) && Math.abs(n) < 1e15 ? n.toLocaleString("en-US") : String(n);

// u128/i128 arrive as decimal strings; group digits for display
const fmtBig = (s: string): string => {
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  if (!/^\d+$/.test(digits)) return esc(s);
  return (neg ? "-" : "") + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const dvNum = (kind: string, n: number): Dv => ({
  kind,
  html: `<span class="stg-num">${esc(fmtNum(n))}</span>`,
  plain: String(n),
  preview: String(n),
  container: false,
});

const dvBig = (kind: string, s: string): Dv =>
  ({ kind, html: `<span class="stg-num" title="${esc(s)}">${fmtBig(s)}</span>`, plain: s, preview: s, container: false });

// addresses/hashes tease more explorer context, so link them out
const dvAddr = (a: string): Dv => ({
  kind: "ADDRESS",
  html: `<a class="mono stg-link" href="/account/${encodeURIComponent(a)}" title="${esc(a)}">${esc(a)}</a>`,
  plain: a,
  preview: a,
  container: false,
});

const dvHash = (h: string): Dv => ({
  kind: "HASH",
  html: `<a class="mono stg-link" href="/search/${encodeURIComponent(h)}" title="${esc(h)}">${esc(h)}</a>`,
  plain: h,
  preview: h,
  container: false,
});

// a collapsible tree node; shallow nodes start expanded, deep ones stay folded
function treeNode(label: string, count: number, unit: string, children: string[], depth: number): string {
  const open = depth < 1 || (depth < 2 && count <= 12);
  const label2 = count === 1 ? unit : `${unit}s`;
  return `<details class="stg-node"${open ? " open" : ""}>
    <summary class="stg-node-sum"><span class="stg-tag">${label}</span> <span class="stg-count">${fmtInt(count)} ${label2}</span></summary>
    <div class="stg-children">${children.join("")}</div>
  </details>`;
}

function dvObj(items: unknown[], depth: number): Dv {
  const children = items.map((v, i) => {
    const d = dv(v, depth + 1);
    return `<div class="stg-child"><span class="stg-idx">${i}</span><span class="stg-child-val">${d.html}</span></div>`;
  });
  return {
    kind: "OBJECT",
    html: treeNode("OBJECT", items.length, "item", children, depth),
    plain: safeJson(items),
    preview: `${fmtInt(items.length)} item${items.length === 1 ? "" : "s"}`,
    container: true,
  };
}

function dvMap(pairs: unknown[], depth: number): Dv {
  const rows = (Array.isArray(pairs) ? pairs : []).map((pair) => {
    const kv = Array.isArray(pair) ? pair : [pair, null];
    const k = dv(kv[0], depth + 1);
    const v = dv(kv[1], depth + 1);
    return `<div class="stg-child"><span class="stg-map-k">${k.html}</span><span class="stg-arrow">→</span><span class="stg-child-val">${v.html}</span></div>`;
  });
  const n = Array.isArray(pairs) ? pairs.length : 0;
  return {
    kind: "MAP",
    html: treeNode("MAP", n, "pair", rows, depth),
    plain: safeJson(pairs),
    preview: `${fmtInt(n)} pair${n === 1 ? "" : "s"}`,
    container: true,
  };
}

// node wire format: { type: "primitive"|"opaque"|"object"|"map", value: … }
// primitive → { type: "u8".."u64"|"u128"|"i8".."i64"|"i128"|"f32"|"f64"|"string"|"bool"|"null", value }
// opaque    → { type: "Address"|"Hash", value }
// object    → DataValue[] (tuple), map → [key, value][] pairs
export function dv(v: unknown, depth = 0): Dv {
  if (v === null || v === undefined) return dvNull();
  if (typeof v === "boolean") return dvBool(v);
  if (typeof v === "number") return dvNum("NUM", v);
  if (typeof v === "string") return dvStr(v);
  if (Array.isArray(v)) return dvObj(v, depth);
  if (typeof v !== "object") return dvStr(String(v));

  const rec = v as Record<string, unknown>;
  const kind = rec.type;
  if (kind === "primitive") {
    const p = (rec.value ?? {}) as Record<string, unknown>;
    const t = String(p.type ?? "");
    const inner = p.value;
    switch (t) {
      case "string":
        return dvStr(String(inner ?? ""));
      case "bool":
        return dvBool(inner === true || inner === "True" || inner === "true");
      case "null":
        return dvNull();
      case "u128": case "i128":
        return dvBig(t.toUpperCase(), typeof inner === "string" ? inner : String(inner ?? 0));
      case "f32": case "f64": {
        const n = typeof inner === "string" ? Number(inner) : num(inner);
        return dvNum(t.toUpperCase(), n);
      }
      case "u8": case "u16": case "u32": case "u64":
      case "i8": case "i16": case "i32": case "i64": {
        const label = t.toUpperCase();
        if (typeof inner === "string") {
          const n = Number(inner);
          return Number.isInteger(n) && Math.abs(n) < 1e15 ? dvNum(label, n) : dvBig(label, inner);
        }
        return dvNum(label, num(inner));
      }
      default:
        // opaque / object / map can also nest inside a primitive wrapper
        return t === "opaque" || t === "object" || t === "map" ? dv(p, depth) : dv(inner, depth);
    }
  }
  if (kind === "opaque") {
    const o = (rec.value ?? {}) as Record<string, unknown>;
    const t = String(o.type ?? "");
    const inner = o.value;
    if (t === "Address") return dvAddr(String(inner ?? ""));
    if (t === "Hash") return dvHash(String(inner ?? ""));
    return dv(inner, depth);
  }
  if (kind === "object") {
    return Array.isArray(rec.value) ? dvObj(rec.value, depth) : dv(rec.value, depth);
  }
  if (kind === "map") {
    return Array.isArray(rec.value) ? dvMap(rec.value, depth) : dv(rec.value, depth);
  }
  // unknown wrapper shape: render raw JSON instead of recursing forever
  return { kind: "RAW", html: `<span class="stg-rawtxt">${esc(safeJson(rec))}</span>`, plain: safeJson(rec), preview: clip(safeJson(rec), 140), container: false };
}

export interface StorageBatch {
  entries: { key: unknown; value: unknown }[];
  more: boolean;
}

// one extra probed entry beyond the page tells us whether a following page exists
export async function fetchStorage(id: string, skip: number): Promise<StorageBatch> {
  try {
    const res = await rpc<{ key: unknown; value: unknown }[]>("get_contract_data_entries", {
      contract: id, skip, maximum: STORAGE_PAGE,
    });
    const arr = Array.isArray(res) ? res : [];
    if (arr.length < STORAGE_PAGE) return { entries: arr, more: false };
    const probe = await rpc<{ key: unknown; value: unknown }[]>("get_contract_data_entries", {
      contract: id, skip: skip + STORAGE_PAGE, maximum: 1,
    });
    return { entries: arr, more: Array.isArray(probe) && probe.length > 0 };
  } catch {
    return { entries: [], more: false };
  }
}

// one compact row: summary shows key + value preview, the details body holds the
// decoded tree, the pretty-printed raw JSON and copy actions
export function storageEntry(key: unknown, value: unknown): string {
  const k = dv(key);
  const v = dv(value);
  const preview = v.container ? v.preview : clip(oneLine(v.plain), 140);
  const rawKey = safeJson(key, true);
  const rawVal = safeJson(value, true);
  return `<details class="stg-entry" data-kk="${esc(k.kind)}" data-vk="${esc(v.kind)}">
    <summary class="stg-head">
      <span class="stg-key" title="${esc(clip(k.plain, 300))}">${k.html}</span>
      <span class="badge stg-type">${esc(k.kind)}</span>
      <span class="stg-prev" title="${esc(preview)}">${esc(preview)}</span>
      <span class="badge stg-type">${esc(v.kind)}</span>
      <span class="stg-caret" aria-hidden="true"></span>
    </summary>
    <div class="stg-detail">
      <div class="stg-detail-bar">
        <span class="badge stg-type">${esc(v.kind)}</span>
        <span class="stg-size">${fmtInt(v.plain.length)} chars</span>
        <span class="stg-flex"></span>
        <button class="btn ghost stg-act" type="button" data-stg-copy="key">Copy key</button>
        <button class="btn ghost stg-act" type="button" data-stg-copy="value">Copy value</button>
        <button class="btn ghost stg-act on" type="button" data-stg-mode="decoded">Decoded</button>
        <button class="btn ghost stg-act" type="button" data-stg-mode="raw">Raw JSON</button>
      </div>
      <div class="stg-decoded">${v.html}</div>
      <pre class="stg-raw json-pre" hidden>${esc(rawVal)}</pre>
      <pre class="stg-rawkey" hidden>${esc(rawKey)}</pre>
    </div>
  </details>`;
}

// fragment returned by /contracts/:id/storage and appended by the load-more client
export function storageBatchHtml(entries: { key: unknown; value: unknown }[], more: boolean): string {
  return `<div class="stg-batch" data-stg-batch data-more="${more ? 1 : 0}" data-count="${entries.length}">${entries.map((e) => storageEntry(e.key, e.value)).join("")}</div>`;
}

export function storageHeadText(count: number, more: boolean): string {
  if (!count) return "no entries";
  return more ? `${fmtInt(count)} loaded` : `all ${fmtInt(count)} entries`;
}
