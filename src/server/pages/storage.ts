/**
 * Contract storage panel rendering (Xelis contract data entries).
 *
 * The node RPC `get_contract_data_entries` returns DataEntry { key, value }
 * where both sides are DataValue JSONs:
 *   { type: "primitive", value: { type: "u8"|"u64"|"u128"|"string"|"bool"|"null"|…, value } }
 *   { type: "opaque",    value: { type: "Address"|"Hash", value } }
 *   { type: "object",    value: DataValue[] }   (tuple)
 *   { type: "map",       value: [key, value][] }
 * dv() unwraps these into readable HTML with a type badge; storageCard()
 * renders one entry; storageBatchHtml() renders a whole load-more batch
 * (used by both the detail page and the fragment endpoint).
 */
import { esc, num } from "./shared";
import { fmtInt } from "../../client/format";
import { rpc } from "../xelis";

export const STORAGE_PAGE = 20;

type Dv = { kind: string; html: string; plain: string };

const dvBool = (b: boolean): Dv => ({
  kind: "BOOL",
  html: `<span class="stg-bool${b ? "" : " false"}">${b}</span>`,
  plain: String(b),
});

const dvNull = (): Dv => ({ kind: "NULL", html: '<span class="stg-null">null</span>', plain: "null" });

const dvStr = (s: string): Dv => ({ kind: "STRING", html: `<span class="stg-str">${esc(s)}</span>`, plain: s });

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

const dvNum = (kind: string, n: number): Dv => ({ kind, html: `<span class="stg-num">${esc(fmtNum(n))}</span>`, plain: String(n) });

const dvBig = (kind: string, s: string): Dv =>
  ({ kind, html: `<span class="stg-num" title="${esc(s)}">${fmtBig(s)}</span>`, plain: s });

const dvHash = (h: string): Dv => ({ kind: "HASH", html: `<span class="stg-hash">${esc(h)}</span>`, plain: h });

function dvObj(items: unknown[]): Dv {
  const rows = items.map((v) => {
    const d = dv(v);
    return `<div class="stg-kv">${d.html}</div>`;
  });
  return {
    kind: "OBJECT",
    html: `<div class="stg-obj">${rows.join("")}</div>`,
    plain: JSON.stringify(items),
  };
}

function dvMap(pairs: unknown[]): Dv {
  const rows = (Array.isArray(pairs) ? pairs : []).map((pair) => {
    const kv = Array.isArray(pair) ? pair : [pair, null];
    const k = dv(kv[0]);
    const v = dv(kv[1]);
    return `<div class="stg-kv"><span class="stg-k">${k.html}:</span> ${v.html}</div>`;
  });
  return {
    kind: "MAP",
    html: `<div class="stg-obj">${rows.join("")}</div>`,
    plain: JSON.stringify(pairs),
  };
}

// node wire format: { type: "primitive"|"opaque"|"object"|"map", value: … }
// primitive → { type: "u8".."u64"|"u128"|"i8".."i64"|"i128"|"f32"|"f64"|"string"|"bool"|"null", value }
// opaque    → { type: "Address"|"Hash", value }
// object    → DataValue[] (tuple), map → [key, value][] pairs
export function dv(v: unknown): Dv {
  if (v === null || v === undefined) return dvNull();
  if (typeof v === "boolean") return dvBool(v);
  if (typeof v === "number") return dvNum("NUM", v);
  if (typeof v === "string") return dvStr(v);
  if (Array.isArray(v)) return dvObj(v);
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
        return t === "opaque" || t === "object" || t === "map" ? dv(p) : dv(inner);
    }
  }
  if (kind === "opaque") {
    const o = (rec.value ?? {}) as Record<string, unknown>;
    const t = String(o.type ?? "");
    const inner = o.value;
    if (t === "Address") return { kind: "ADDRESS", html: `<span class="stg-hash">${esc(String(inner ?? ""))}</span>`, plain: String(inner ?? "") };
    if (t === "Hash") return dvHash(String(inner ?? ""));
    return dv(inner);
  }
  if (kind === "object") {
    return Array.isArray(rec.value) ? dvObj(rec.value) : dv(rec.value);
  }
  if (kind === "map") {
    return Array.isArray(rec.value) ? dvMap(rec.value) : dv(rec.value);
  }
  // unknown wrapper shape: render raw JSON instead of recursing forever
  return { kind: "RAW", html: `<span class="stg-hash">${esc(JSON.stringify(rec))}</span>`, plain: JSON.stringify(rec) };
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

const copyAttr = (v: unknown): string => esc(JSON.stringify(v ?? null));

export function storageCard(key: unknown, value: unknown): string {
  const k = dv(key);
  const v = dv(value);
  const collapse = v.plain.length > 300;
  const valHtml = collapse
    ? `<details class="stg-details"><summary>${esc(v.plain.slice(0, 240))}…</summary>${v.html}</details>`
    : v.html;
  return `<div class="stg-item">
    <div class="stg-row">
      <span class="stg-lab">Key</span>
      <span class="stg-chip mono">${k.html}</span>
      <span class="badge stg-type">${esc(k.kind)}</span>
      <button class="copybtn stg-copy" type="button" data-copy="${copyAttr(key)}" title="Copy raw key JSON">copy</button>
    </div>
    <div class="stg-row">
      <span class="stg-lab">Value</span>
      <div class="stg-val">${valHtml}</div>
      <span class="badge stg-type">${esc(v.kind)}</span>
      <button class="copybtn stg-copy" type="button" data-copy="${copyAttr(value)}" title="Copy raw value JSON">copy</button>
    </div>
  </div>`;
}

// fragment returned by /contracts/:id/storage and appended by the load-more script
export function storageBatchHtml(entries: { key: unknown; value: unknown }[], more: boolean): string {
  return `<div class="stg-batch" data-stg-batch data-more="${more ? 1 : 0}" data-count="${entries.length}">${entries.map((e) => storageCard(e.key, e.value)).join("")}</div>`;
}

export function storageHeadText(count: number, more: boolean): string {
  if (!count) return "no entries";
  return more ? `${fmtInt(count)} loaded` : `all ${fmtInt(count)} entries`;
}

// inline script for the storage panel: load-more fetch + copy delegation
export const storageScript = (contractId: string, initialCount: number): string => `<script>
(function(){
  var list = document.getElementById("stg-list");
  var btn = document.getElementById("stg-more");
  if (!list || !btn) return;
  var id = ${JSON.stringify(contractId)};
  var skip = ${initialCount};
  document.addEventListener("click", function(e){
    var t = e.target;
    if (t && t.closest && t.closest("[data-copy]") && typeof blkCopy === "function") {
      blkCopy(t.closest("[data-copy]").getAttribute("data-copy"), t.closest("[data-copy]"));
    }
  });
  btn.addEventListener("click", function(){
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "loading…";
    fetch("/contracts/" + encodeURIComponent(id) + "/storage?skip=" + skip)
      .then(function(r){ if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function(html){
        var tpl = document.createElement("template");
        tpl.innerHTML = html.trim();
        var batch = tpl.content.firstElementChild;
        if (!batch || !batch.hasAttribute("data-stg-batch")) throw new Error("bad batch");
        list.appendChild(batch);
        skip += Number(batch.getAttribute("data-count")) || 0;
        if (batch.getAttribute("data-more") !== "1") btn.remove();
        else { btn.disabled = false; btn.textContent = "Load more entries"; }
      })
      .catch(function(){
        btn.disabled = false;
        btn.textContent = "load failed — retry";
      });
  });
})();
</script>`;