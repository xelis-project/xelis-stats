import { renderChart, renderCompare, cumulativePoints, ACCENTS, accentHex, type SeriesPoint, type LineWidth } from "./charts";
import { fmt, fmtInt, fmtPct, shortHash, atomic, ago } from "./format";
import { refreshSort } from "./sortable";
import { attachDatePickers } from "./datepicker";
import type uPlot from "uplot";

type Kind = "stat" | "chart" | "compare" | "rank" | "list";

interface CatalogItem {
  key: string;
  kind: Kind;
  label: string;
  desc: string;
  metric?: string;
  metrics?: string[];
  log?: boolean;
  field?: string;
  range?: string;
  interval?: string;
  src?: string;
  period?: string;
  limit?: number;
  w: number;
  h: number;
}

// Per-widget user settings, persisted with the layout. Filter fields only
// apply to matching kinds: range/interval/type/log/cum/fill/points/lineWidth ->
// chart, period/limit -> rank and list, valueSize/hideSub -> stat,
// sort/dir -> table widgets backed by a sortable API (src/server/sort.ts),
// txType -> txs list, blockType -> blocks list,
// hiddenCols -> table widgets (per-column show/hide),
// title/accent -> everything.
interface WidgetOpts {
  title?: string;
  accent?: string;
  range?: string;
  from?: string;
  to?: string;
  interval?: string;
  period?: string;
  limit?: number;
  type?: "line" | "bar";
  log?: boolean;
  cum?: boolean;
  fill?: boolean;
  points?: boolean;
  lineWidth?: LineWidth;
  valueSize?: "small" | "normal" | "large";
  hideSub?: boolean;
  sort?: string;
  dir?: "asc" | "desc";
  txType?: string;
  blockType?: string;
  hiddenCols?: string[];
}

interface Widget {
  id: string;
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  opts?: WidgetOpts;
}

// On-screen geometry, derived from the canonical layout for the current
// viewport. Never persisted, never edited directly.
interface Slot {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// A named dashboard page with its own widget layout.
interface Tab {
  id: string;
  name: string;
  widgets: Widget[];
}

interface Persisted {
  version: 4;
  tabs: Tab[];
  active: string;
}

interface Summary {
  network?: string;
  node_version?: string;
  height?: number;
  topoheight?: number;
  stable_topoheight?: number;
  difficulty?: number;
  block_time_s?: number;
  block_time_target_s?: number;
  block_reward?: number;
  mempool?: number;
  peers?: number;
  counts?: { transactions?: number; accounts?: number; assets?: number };
  supply?: { circulating?: number; emitted?: number; burned?: number; max?: number };
  market?: { price?: number; change_pct_24h?: number | null; quote_volume_24h?: number; exchanges?: number } | null;
}

const STORAGE_KEY = "xelis-dashboard-v4";
const LEGACY_KEY = "xelis-dashboard"; // pre-tabs single-layout storage
const OLDEST_KEY = "xelis-stats-layout";
const CANON_COLS = 12;

const CATALOG: CatalogItem[] = [
  { key: "stat-topoheight", kind: "stat", field: "topoheight", label: "Topoheight", desc: "Chain tip + stable boundary", w: 3, h: 2 },
  { key: "stat-price", kind: "stat", field: "price", label: "XEL price", desc: "Median USDT quote + 24h change", w: 3, h: 2 },
  { key: "stat-hashrate", kind: "stat", field: "hashrate", label: "Estimated hashrate", desc: "Difficulty / block time", w: 3, h: 2 },
  { key: "stat-marketcap", kind: "stat", field: "marketcap", label: "Market cap", desc: "Circulating supply x price", w: 3, h: 2 },
  { key: "stat-mempool", kind: "stat", field: "mempool", label: "Mempool", desc: "Pending transaction count", w: 3, h: 2 },
  { key: "stat-supply", kind: "stat", field: "supply", label: "Circulating supply", desc: "XEL in circulation", w: 3, h: 2 },
  { key: "stat-burned", kind: "stat", field: "burned", label: "Burned supply", desc: "Publicly burned XEL", w: 3, h: 2 },
  { key: "stat-blocktime", kind: "stat", field: "blocktime", label: "Block time", desc: "Average vs target", w: 3, h: 2 },
  { key: "stat-transactions", kind: "stat", field: "transactions", label: "Transactions", desc: "Total chain transaction count", w: 3, h: 2 },
  { key: "stat-accounts", kind: "stat", field: "accounts", label: "Accounts", desc: "Total registered accounts", w: 3, h: 2 },
  { key: "stat-assets", kind: "stat", field: "assets", label: "Assets", desc: "Registered assets", w: 3, h: 2 },
  { key: "stat-node", kind: "stat", field: "node", label: "Node", desc: "Node version and network", w: 3, h: 2 },
  { key: "stat-height", kind: "stat", field: "height", label: "Block height", desc: "Linear chain height", w: 3, h: 2 },
  { key: "stat-stable", kind: "stat", field: "stable", label: "Stable boundary", desc: "Stable topoheight vs tip", w: 3, h: 2 },
  { key: "stat-difficulty", kind: "stat", field: "difficulty", label: "Difficulty", desc: "Current block difficulty", w: 3, h: 2 },
  { key: "stat-emitted", kind: "stat", field: "emitted", label: "Emitted supply", desc: "Total XEL emitted so far", w: 3, h: 2 },
  { key: "stat-max", kind: "stat", field: "max", label: "Max supply", desc: "Emission cap and % minted", w: 3, h: 2 },
  { key: "stat-quote-vol", kind: "stat", field: "quotevol", label: "24h volume", desc: "USDT quote volume, all exchanges", w: 3, h: 2 },
  { key: "stat-exchanges", kind: "stat", field: "exchanges", label: "Exchanges", desc: "Active market feeds", w: 3, h: 2 },
  { key: "stat-reward", kind: "stat", field: "reward", label: "Block reward", desc: "Miner + dev reward per block", w: 3, h: 2 },
  { key: "stat-target", kind: "stat", field: "target", label: "Target block time", desc: "Node emission target", w: 3, h: 2 },
  { key: "stat-peers", kind: "stat", field: "peers", label: "Peers", desc: "Connected peers (2-min snapshot)", w: 3, h: 2 },

  { key: "chart-txs", kind: "chart", metric: "txs", label: "Transactions / day", desc: "Daily transaction count", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-price", kind: "chart", metric: "price", label: "XEL price", desc: "Median USDT quote over time", range: "30d", interval: "day", w: 6, h: 5 },
  { key: "chart-active-accounts", kind: "chart", metric: "active-accounts", label: "Active accounts", desc: "Distinct senders per bucket", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-hashrate", kind: "chart", metric: "hashrate", label: "Hashrate", desc: "Difficulty-based estimate", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-miners", kind: "chart", metric: "miners", label: "Unique miners", desc: "Distinct mining addresses", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-fees", kind: "chart", metric: "fees", label: "Average fee", desc: "Mean fee per transaction", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-supply", kind: "chart", metric: "supply", label: "Supply", desc: "Circulating supply", range: "1y", interval: "week", w: 6, h: 5 },
  { key: "chart-market-cap", kind: "chart", metric: "market-cap", label: "Market cap", desc: "Supply x price where covered", range: "1y", interval: "week", w: 6, h: 5 },
  { key: "chart-transfers", kind: "chart", metric: "transfers", label: "Transfers", desc: "Transfer outputs per bucket", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-orphans", kind: "chart", metric: "orphans", label: "Non-Normal blocks", desc: "Side/Sync block counts", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-new-accounts", kind: "chart", metric: "accounts", label: "New accounts", desc: "Newly observed senders per day", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-miner-revenue", kind: "chart", metric: "miner-revenue", label: "Miner revenue", desc: "Rewards emitted per day (XEL)", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-quote-volume", kind: "chart", metric: "quote-volume", label: "Quote volume", desc: "USDT volume across exchanges", range: "30d", interval: "day", w: 6, h: 5 },
  { key: "chart-fee-p90", kind: "chart", metric: "fee-p90", label: "Fee P90", desc: "90th percentile fee per bucket", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-fees-median", kind: "chart", metric: "fees-median", label: "Median fee", desc: "Median fee per transaction", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-fees-p99", kind: "chart", metric: "fees-p99", label: "Fee P99", desc: "99th percentile fee per bucket", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-block-time", kind: "chart", metric: "block-time", label: "Block time", desc: "Average block interval per day", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-gini", kind: "chart", metric: "gini", label: "Production Gini", desc: "Block production concentration", range: "1y", interval: "week", w: 6, h: 5 },
  { key: "chart-nakamoto", kind: "chart", metric: "nakamoto", label: "Nakamoto coefficient", desc: "Miner decentralization estimate", range: "1y", interval: "week", w: 6, h: 5 },
  { key: "chart-encrypted", kind: "chart", metric: "encrypted", label: "Encrypted txs", desc: "Share of encrypted transactions", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-miner-rev-usd", kind: "chart", metric: "miner-rev-usd", label: "Miner revenue (USDT)", desc: "Rewards valued where price covered", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "chart-burned", kind: "chart", metric: "burned-supply", label: "Burned supply", desc: "Cumulative publicly burned XEL", range: "1y", interval: "week", w: 6, h: 5 },
  { key: "chart-block-types", kind: "chart", metric: "block-types", label: "Block types", desc: "Normal/Side/Sync counts per day", range: "30d", interval: "day", w: 6, h: 5 },
  { key: "chart-mempool", kind: "chart", metric: "mempool", label: "Mempool", desc: "Pending tx count over time", range: "3d", interval: "day", w: 6, h: 5 },
  { key: "chart-peers", kind: "chart", metric: "peers", label: "Peer count", desc: "Connected peers over time", range: "7d", interval: "day", w: 6, h: 5 },
  { key: "chart-peers-pruned", kind: "chart", metric: "peers-pruned", label: "Pruned peers", desc: "Pruned nodes over time", range: "7d", interval: "day", w: 6, h: 5 },
  { key: "chart-peer-lag", kind: "chart", metric: "peer-lag", label: "Peer sync lag", desc: "Average topoheight lag vs our tip", range: "7d", interval: "day", w: 6, h: 5 },
  { key: "chart-peers-stale", kind: "chart", metric: "peers-stale", label: "Stale peers", desc: "No ping for over an hour", range: "7d", interval: "day", w: 6, h: 5 },
  { key: "chart-peer-age", kind: "chart", metric: "peer-age", label: "Connection age", desc: "Average peer connection age (s)", range: "7d", interval: "day", w: 6, h: 5 },
  { key: "compare-peers-divergent", kind: "compare", metrics: ["peers", "peers-divergent"], label: "Peers vs divergent", desc: "Connected peers against divergent tips", range: "7d", interval: "day", w: 6, h: 5 },

  { key: "compare-price-volume", kind: "compare", metrics: ["price", "quote-volume"], log: true, label: "Price vs volume", desc: "Median price against USDT volume", range: "30d", interval: "day", w: 6, h: 5 },
  { key: "compare-txs-accounts", kind: "compare", metrics: ["txs", "active-accounts"], label: "Txs vs senders", desc: "Transactions against active senders", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "compare-hashrate-miners", kind: "compare", metrics: ["hashrate", "miners"], log: true, label: "Hashrate vs miners", desc: "Hashrate against unique miners", range: "90d", interval: "day", w: 6, h: 5 },
  { key: "compare-fee-p90-txs", kind: "compare", metrics: ["fees", "fee-p90"], label: "Fee avg vs P90", desc: "Mean fee against 90th percentile", range: "90d", interval: "day", w: 6, h: 5 },

  { key: "rank-miners", kind: "rank", src: "miners", period: "week", limit: 10, label: "Top miners", desc: "Weekly blocks found by address", w: 6, h: 5 },
  { key: "rank-miners-month", kind: "rank", src: "miners", period: "month", limit: 10, label: "Top miners (month)", desc: "Monthly blocks found by address", w: 6, h: 5 },
  { key: "rank-senders", kind: "rank", src: "senders", period: "week", limit: 10, label: "Top senders", desc: "Weekly most-active senders", w: 6, h: 5 },
  { key: "rank-senders-month", kind: "rank", src: "senders", period: "month", limit: 10, label: "Top senders (month)", desc: "Monthly most-active senders", w: 6, h: 5 },
  { key: "rank-burners", kind: "rank", src: "burners", period: "week", limit: 10, label: "Top burners", desc: "Weekly XEL burned by address", w: 6, h: 5 },
  { key: "rank-assets", kind: "rank", src: "assets", period: "week", limit: 10, label: "Top assets", desc: "Weekly most-used assets", w: 6, h: 5 },
  { key: "rank-contracts", kind: "rank", src: "contracts", period: "week", limit: 10, label: "Top contracts", desc: "Weekly most-invoked contracts", w: 6, h: 5 },
  { key: "list-blocks", kind: "list", src: "blocks", limit: 12, label: "Latest blocks", desc: "Recently produced blocks", w: 6, h: 5 },
  { key: "list-txs", kind: "list", src: "txs", limit: 12, label: "Latest transactions", desc: "Recently indexed transactions", w: 6, h: 5 },
  { key: "list-accounts", kind: "list", src: "accounts", limit: 12, label: "Active senders", desc: "Recently observed sender addresses", w: 6, h: 5 },
  { key: "list-accounts-top", kind: "list", src: "accounts-top", limit: 12, label: "Top senders (all-time)", desc: "Most active senders since indexing", w: 6, h: 5 },
  { key: "list-exchanges", kind: "list", src: "exchanges", limit: 10, label: "Exchanges", desc: "Per-exchange price, spread and volume", w: 6, h: 5 },
  { key: "list-peers", kind: "list", src: "peers", limit: 10, label: "Node versions", desc: "Peer count by node version", w: 6, h: 5 },
  { key: "list-peer-tags", kind: "list", src: "peer-tags", limit: 10, label: "Peer tags", desc: "Tagged peers by tag", w: 6, h: 5 },
];

const byKey = new Map(CATALOG.map((c) => [c.key, c]));

// Default tabs: overview (network + chain), mining, and market. Each groups
// widgets that read naturally together.
const DEFAULT_TABS: Array<{ name: string; widgets: Array<[string, number, number, number, number]> }> = [
  {
    name: "Overview",
    widgets: [
      ["stat-topoheight", 0, 0, 3, 2],
      ["stat-price", 3, 0, 3, 2],
      ["stat-hashrate", 6, 0, 3, 2],
      ["stat-mempool", 9, 0, 3, 2],
      ["chart-txs", 0, 2, 6, 5],
      ["chart-price", 6, 2, 6, 5],
      ["list-blocks", 0, 7, 6, 5],
      ["list-txs", 6, 7, 6, 5],
      ["chart-supply", 0, 12, 6, 5],
      ["chart-market-cap", 6, 12, 6, 5],
      ["chart-nakamoto", 0, 17, 6, 5],
      ["chart-gini", 6, 17, 6, 5],
    ],
  },
  {
    name: "Mining",
    widgets: [
      ["chart-hashrate", 0, 0, 6, 5],
      ["chart-miners", 6, 0, 6, 5],
      ["compare-hashrate-miners", 0, 5, 6, 5],
      ["chart-miner-revenue", 6, 5, 6, 5],
      ["rank-miners", 0, 10, 6, 5],
      ["rank-miners-month", 6, 10, 6, 5],
    ],
  },
  {
    name: "Market",
    widgets: [
      ["stat-marketcap", 0, 0, 3, 2],
      ["stat-quote-vol", 3, 0, 3, 2],
      ["stat-exchanges", 6, 0, 3, 2],
      ["chart-quote-volume", 0, 2, 6, 5],
      ["compare-price-volume", 6, 2, 6, 5],
      ["list-exchanges", 0, 7, 6, 5],
    ],
  },
  {
    name: "Network",
    widgets: [
      ["stat-peers", 0, 0, 3, 2],
      ["stat-node", 3, 0, 3, 2],
      ["chart-peers", 0, 2, 6, 5],
      ["chart-peer-lag", 6, 2, 6, 5],
      ["list-peers", 0, 7, 6, 5],
      ["list-peer-tags", 6, 7, 6, 5],
    ],
  },
];

function defaultTabs(): Tab[] {
  return DEFAULT_TABS.map((t) => ({
    id: nid(),
    name: t.name,
    widgets: t.widgets.map(([key, x, y, w, h]) => ({ id: nid(), key, x, y, w, h })),
  }));
}

let tabs: Tab[] = [];
let activeTab = "";
let widgets: Widget[] = [];
let view: Slot[] = [];
let canvas: HTMLElement | null = null;
let cols = CANON_COLS;
let colW = 80;
let rowH = 44;
let gap = 12;
let uid = 0;
const charts = new Map<string, uPlot>();
let summary: Summary | null = null;
let summaryAt = 0;

function nid(): string {
  uid += 1;
  return `w${Date.now().toString(36)}${uid}`;
}

function colsFor(width: number): number {
  if (width <= 620) return 2;
  if (width <= 1000) return 6;
  return 12;
}

function stepX(): number {
  return colW + gap;
}

function stepY(): number {
  return rowH + gap;
}

const RANGES = ["7d", "30d", "90d", "1y", "all", "custom"];
const INTERVALS = ["day", "week", "month", "year"];
const RANK_PERIODS = ["day", "week", "month", "all"];
const LIMITS = [5, 10, 25, 50];
// Values the /api/transactions and /api/blocks ?type= filters accept
const TX_TYPES = ["transfer", "burn", "invoke_contract", "deploy_contract", "multisig"];
const BLOCK_TYPES = ["Normal", "Side", "Sync"];

function sanitizeOpts(raw: unknown, item?: CatalogItem): WidgetOpts {
  const out: WidgetOpts = {};
  if (!raw || typeof raw !== "object") return out;
  const v = raw as Record<string, unknown>;
  if (typeof v.title === "string") out.title = v.title.slice(0, 60);
  if (typeof v.accent === "string" && v.accent in ACCENTS) out.accent = v.accent;
  if (typeof v.range === "string" && RANGES.includes(v.range)) out.range = v.range;
  if (typeof v.from === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.from)) out.from = v.from;
  if (typeof v.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.to)) out.to = v.to;
  if (typeof v.interval === "string" && INTERVALS.includes(v.interval)) out.interval = v.interval;
  if (typeof v.period === "string" && RANK_PERIODS.includes(v.period)) out.period = v.period;
  if (typeof v.limit === "number" && LIMITS.includes(v.limit)) out.limit = v.limit;
  if (v.type === "bar" || v.type === "line") out.type = v.type;
  if (v.log === true) out.log = true;
  if (v.cum === true) out.cum = true;
  if (typeof v.fill === "boolean") out.fill = v.fill;
  if (v.points === true) out.points = true;
  if (v.lineWidth === "thin" || v.lineWidth === "normal" || v.lineWidth === "thick") out.lineWidth = v.lineWidth;
  if (v.valueSize === "small" || v.valueSize === "normal" || v.valueSize === "large") out.valueSize = v.valueSize;
  if (v.hideSub === true) out.hideSub = true;
  const sortCols = item ? WIDGET_COLS[item.src ?? ""] : undefined;
  if (typeof v.sort === "string" && sortCols?.cols.some((c) => c.key === v.sort)) out.sort = v.sort;
  if (v.dir === "asc" || v.dir === "desc") out.dir = v.dir;
  if (typeof v.txType === "string" && TX_TYPES.includes(v.txType)) out.txType = v.txType;
  if (typeof v.blockType === "string" && BLOCK_TYPES.some((b) => b.toLowerCase() === v.blockType?.toLowerCase())) out.blockType = v.blockType;
  if (Array.isArray(v.hiddenCols)) {
    const allowed = item ? tableCols(item).map((c) => c.key) : [];
    const hid = v.hiddenCols.filter((k) => typeof k === "string" && allowed.includes(k));
    if (hid.length) out.hiddenCols = hid;
  }
  return out;
}

// Validates a serialized widget list (v2 or v3 layout files) and returns clean
// widgets, or null when the payload is not a usable layout. An empty list is
// valid.
function parseWidgets(list: unknown[]): Widget[] | null {
  const clean: Widget[] = [];
  for (const raw of list) {
    const w = raw as Widget;
    if (!w || typeof w.key !== "string" || !byKey.has(w.key)) continue;
    if (![w.x, w.y, w.w, w.h].every((n) => Number.isFinite(n))) continue;
    clean.push({ id: nid(), key: w.key, x: w.x, y: w.y, w: w.w, h: w.h, opts: sanitizeOpts(w.opts, byKey.get(w.key)) });
  }
  return clean;
}

function parseLayout(text: string): Widget[] | null {
  let parsed: { version?: number; widgets?: unknown[] } | null = null;
  try {
    parsed = JSON.parse(text) as { version?: number; widgets?: unknown[] };
  } catch { /* not JSON */ }
  if (!parsed || (parsed.version !== 2 && parsed.version !== 3) || !Array.isArray(parsed.widgets)) return null;
  const clean = parseWidgets(parsed.widgets);
  if (clean && (clean.length || !parsed.widgets.length)) return clean;
  return null;
}

// Validate a full multi-tab payload. Accepts v4 (tabs) plus v2/v3 (single
// layout, wrapped into one tab). Returns null when unusable.
function parsePersisted(text: string): { tabs: Tab[]; active: string } | null {
  interface ParsedState { version?: number; tabs?: unknown[]; active?: unknown; widgets?: unknown[] }
  let parsed: ParsedState | null = null;
  try {
    parsed = JSON.parse(text) as ParsedState | null;
  } catch { /* not JSON */ }
  if (!parsed || typeof parsed !== "object") return null;
  if (!parsed) return null;

  if (parsed.version === 4 && Array.isArray(parsed.tabs)) {
    const clean: Tab[] = [];
    for (const raw of parsed.tabs) {
      const t = raw as Tab;
      if (!t || typeof t.name !== "string" || !Array.isArray(t.widgets)) continue;
      clean.push({ id: nid(), name: t.name.slice(0, 40) || "Tab", widgets: parseWidgets(t.widgets) ?? [] });
    }
    if (clean.length) {
      const ids = new Set(clean.map((t) => t.id));
      const active = typeof parsed.active === "string" && ids.has(parsed.active) ? parsed.active : clean[0].id;
      return { tabs: clean, active };
    }
    return null;
  }

  const single = parseLayout(text);
  if (single) return { tabs: [{ id: nid(), name: "Overview", widgets: single }], active: "" };
  return null;
}

function loadState(): { tabs: Tab[]; active: string } {
  try {
    const clean = parsePersisted(localStorage.getItem(STORAGE_KEY) ?? "");
    if (clean) return clean;
  } catch { /* blocked storage — fall through to default */ }

  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? "") as { version?: number; widgets?: unknown[] } | null;
    if (legacy && (legacy.version === 3 || legacy.version === 2) && Array.isArray(legacy.widgets)) {
      const clean = parseWidgets(legacy.widgets);
      if (clean) return { tabs: [{ id: nid(), name: "Overview", widgets: clean }], active: "" };
    }
  } catch { /* ignore legacy */ }

  try {
    const oldest = JSON.parse(localStorage.getItem(OLDEST_KEY) ?? "[]") as Array<{ id: string; metric?: string; range?: string; interval?: string }>;
    if (Array.isArray(oldest) && oldest.length) {
      const migrated: Widget[] = [];
      let x = 0;
      let y = 0;
      for (const old of oldest) {
        const key = `chart-${old.metric}`;
        if (!byKey.has(key)) continue;
        const item = byKey.get(key)!;
        if (x + item.w > 12) { x = 0; y += item.h; }
        migrated.push({ id: nid(), key, x, y, w: item.w, h: item.h });
        x += item.w;
      }
      if (migrated.length) return { tabs: [{ id: nid(), name: "Overview", widgets: migrated }], active: "" };
    }
  } catch { /* ignore legacy */ }

  const defs = defaultTabs();
  return { tabs: defs, active: defs[0].id };
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 4, tabs, active: activeTab } satisfies Persisted));
  } catch { /* storage full or blocked */ }
}

function measure(): void {
  if (!canvas) return;
  // Widget text and paddings are rem-based and the large-screen media query
  // raises the root font size, so the pixel geometry of the grid must scale
  // by the same factor or widgets get vertically cramped at 1x row heights.
  const k = Math.max(1, parseFloat(getComputedStyle(document.documentElement).fontSize) / 10);
  cols = colsFor(window.innerWidth);
  gap = window.innerWidth <= 620 ? 8 : Math.round(12 * k);
  rowH = Math.round(44 * k);
  const inner = canvas.clientWidth - gap * 2;
  colW = Math.max(24, Math.floor((inner - (cols - 1) * gap) / cols));
  canvas.style.gridTemplateColumns = `repeat(${cols}, ${colW}px)`;
  canvas.style.gridAutoRows = `${rowH}px`;
  canvas.style.gap = `${gap}px`;
  canvas.style.padding = `${gap}px`;
  canvas.style.backgroundSize = `${stepX()}px ${stepY()}px`;
  canvas.style.backgroundPosition = "0 0";
  canvas.style.setProperty("--dash-step-x", `${stepX()}px`);
  canvas.style.setProperty("--dash-step-y", `${stepY()}px`);
}

function clampPos(w: Widget, limit = CANON_COLS): void {
  w.w = Math.min(Math.max(w.w, 2), limit);
  w.h = Math.max(w.h, 2);
  w.x = Math.min(Math.max(w.x, 0), Math.max(limit - w.w, 0));
  w.y = Math.max(w.y, 0);
}

function overlaps(a: Widget, list: Widget[], skipId: string): boolean {
  return list.some((b) => b.id !== skipId && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y);
}

function findFree(list: Widget[], target: Widget, skipId: string, limit = CANON_COLS): { x: number; y: number } {
  const baseX = Math.min(Math.max(target.x, 0), Math.max(limit - target.w, 0));
  const baseY = Math.max(target.y, 0);
  for (let r = 0; r < 80; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const cand: Widget = { ...target, x: Math.min(Math.max(baseX + dx, 0), Math.max(limit - target.w, 0)), y: Math.max(baseY + dy, 0) };
        if (!overlaps(cand, list, skipId)) return { x: cand.x, y: cand.y };
      }
    }
  }
  return { x: baseX, y: baseY };
}

function firstFree(item: CatalogItem): { x: number; y: number } {
  const probe: Widget = { id: "probe", key: item.key, x: 0, y: 0, w: Math.min(item.w, CANON_COLS), h: item.h };
  return findFree(widgets, probe, "probe");
}

function statValue(field: string | undefined, s: Summary): { value: string; sub: string } {
  switch (field) {
    case "topoheight": return { value: fmtInt(s.topoheight ?? NaN), sub: `height ${fmtInt(s.height ?? NaN)} · stable ${fmtInt(s.stable_topoheight ?? NaN)}` };
    case "price": return { value: s.market?.price ? `$${fmt(s.market.price, 4)}` : "—", sub: s.market ? `${fmtPct(s.market.change_pct_24h ?? null)} 24h` : "market unavailable" };
    case "hashrate": {
      const hr = s.difficulty && s.block_time_s ? s.difficulty / s.block_time_s : NaN;
      return { value: Number.isFinite(hr) ? `${fmt(hr)} H/s` : "—", sub: `difficulty ${fmt(s.difficulty ?? NaN)}` };
    }
    case "marketcap": {
      const circ = (s.supply?.circulating ?? 0) / 1e8;
      const mc = s.market?.price ? circ * s.market.price : NaN;
      return { value: Number.isFinite(mc) ? `$${fmt(mc)}` : "—", sub: `${fmt(circ)} XEL circulating` };
    }
    case "mempool": return { value: fmtInt(s.mempool ?? NaN), sub: "pending transactions" };
    case "peers": return { value: fmtInt(s.peers ?? NaN), sub: `${fmtInt(s.peers ?? 0)} connected peers` };
    case "supply": {
      const circ = (s.supply?.circulating ?? 0) / 1e8;
      const max = (s.supply?.max ?? 0) / 1e8;
      return { value: `${fmt(circ)} XEL`, sub: max ? `${((circ / max) * 100).toFixed(1)}% of max` : "max unknown" };
    }
    case "burned": return { value: `${fmt((s.supply?.burned ?? 0) / 1e8)} XEL`, sub: "publicly burned" };
    case "blocktime": return { value: s.block_time_s ? `${s.block_time_s.toFixed(1)}s` : "—", sub: "averaged by node" };
    case "transactions": return { value: fmtInt(s.counts?.transactions ?? NaN), sub: "chain total" };
    case "accounts": return { value: fmtInt(s.counts?.accounts ?? NaN), sub: "registered accounts" };
    case "assets": return { value: fmtInt(s.counts?.assets ?? NaN), sub: "registered assets" };
    case "node": return { value: s.node_version ?? "—", sub: s.network ?? "network unknown" };
    case "height": return { value: fmtInt(s.height ?? NaN), sub: `topoheight ${fmtInt(s.topoheight ?? NaN)}` };
    case "stable": {
      const gap = s.topoheight !== undefined && s.stable_topoheight !== undefined ? s.topoheight - s.stable_topoheight : NaN;
      return { value: fmtInt(s.stable_topoheight ?? NaN), sub: Number.isFinite(gap) ? `${fmtInt(gap)} blocks behind tip` : "" };
    }
    case "difficulty": return { value: fmt(s.difficulty ?? NaN), sub: s.difficulty && s.block_time_s ? `≈ ${fmt(s.difficulty / s.block_time_s)} H/s` : "estimated hashrate unavailable" };
    case "emitted": {
      const em = (s.supply?.emitted ?? 0) / 1e8;
      const max = (s.supply?.max ?? 0) / 1e8;
      return { value: `${fmt(em)} XEL`, sub: max ? `${((em / max) * 100).toFixed(1)}% of max emitted` : "max unknown" };
    }
    case "max": {
      const max = (s.supply?.max ?? 0) / 1e8;
      const circ = (s.supply?.circulating ?? 0) / 1e8;
      return { value: max ? `${fmt(max)} XEL` : "—", sub: max ? `${((circ / max) * 100).toFixed(1)}% circulating` : "" };
    }
    case "quotevol": return { value: s.market?.quote_volume_24h ? `$${fmt(s.market.quote_volume_24h)}` : "—", sub: "USDT quoted, all exchanges" };
    case "exchanges": return { value: s.market ? fmtInt(s.market.exchanges ?? NaN) : "—", sub: s.market ? "active market feeds" : "market unavailable" };
    case "reward": return { value: s.block_reward ? `${atomic(s.block_reward)} XEL` : "—", sub: "miner + dev reward per block" };
    case "target": return { value: s.block_time_target_s ? `${s.block_time_target_s.toFixed(0)}s` : "—", sub: "node emission target" };
    default: return { value: "—", sub: "" };
  }
}

async function refreshSummary(): Promise<void> {
  if (summary && Date.now() - summaryAt < 60_000) return;
  try {
    const res = await fetch("/api/summary");
    summary = (await res.json()) as Summary;
    summaryAt = Date.now();
  } catch { /* keep last known */ }
}

function skeletonHtml(kind: Kind): string {
  if (kind === "stat") {
    return '<div class="w-skel sk-stat"><span class="sk-bar sk-v"></span><span class="sk-bar sk-s"></span></div>';
  }
  if (kind === "chart" || kind === "compare") {
    const bars = [34, 58, 42, 70, 52, 82, 60, 92, 66, 78, 48, 64, 38, 55]
      .map((h) => `<span class="sk-bar sk-col" style="height:${h}%"></span>`)
      .join("");
    return `<div class="w-skel sk-chart">${bars}</div>`;
  }
  return `<div class="w-skel sk-table">${Array.from({ length: 6 }, () =>
    '<span class="sk-row"><span class="sk-bar sk-c1"></span><span class="sk-bar sk-c2"></span></span>').join("")}</div>`;
}

function setLoading(w: Widget, on: boolean): void {
  const el = canvas?.querySelector<HTMLElement>(`[data-id="${w.id}"]`);
  if (!el) return;
  el.classList.toggle("loading", on);
  if (!on) return;
  const kind = byKey.get(w.key)?.kind;
  if (!kind) return;
  const sel = kind === "stat" ? ".w-stat" : kind === "rank" || kind === "list" ? ".w-table" : ".w-chart";
  const body = el.querySelector<HTMLElement>(sel);
  if (body) body.innerHTML = skeletonHtml(kind);
}

function renderStats(): void {
  for (const w of widgets) {
    const item = byKey.get(w.key);
    if (!item || item.kind !== "stat") continue;
    const el = canvas?.querySelector(`[data-id="${w.id}"] .w-stat`);
    if (!el) continue;
    if (!summary) {
      if (!el.querySelector(".w-skel")) {
        el.closest(".widget")?.classList.add("loading");
        el.innerHTML = skeletonHtml("stat");
      }
      continue;
    }
    const o = w.opts ?? {};
    const { value, sub } = statValue(item.field, summary);
    const size = o.valueSize === "small" ? "w-stat-sm" : o.valueSize === "large" ? "w-stat-lg" : "";
    el.className = `w-stat${size ? ` ${size}` : ""}`;
    el.closest(".widget")?.classList.remove("loading");
    el.innerHTML = `<div class="v">${value}</div>${o.hideSub ? "" : `<div class="s">${sub}</div>`}`;
  }
}

function chartBody(w: Widget): HTMLElement | null {
  return canvas?.querySelector(`[data-id="${w.id}"] .w-chart`) ?? null;
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function normSecs(ts: number | undefined): number {
  if (!ts || !Number.isFinite(ts)) return 0;
  return ts > 1e12 ? ts / 1000 : ts;
}

function addrCell(r: Record<string, unknown>, key: string, size = 6, base = "/account/"): string {
  const a = String(r[key] ?? "");
  const label = String(r.label ?? "");
  const kind = String(r.kind ?? "");
  const tag = label ? ` <span class="badge entity ${esc(kind)}">${esc(label)}</span>` : "";
  return `<td title="${esc(a)}"><a href="${base}${esc(a)}">${esc(shortHash(a, size))}</a>${tag}</td>`;
}

// Rows render as [column key, cell html] pairs so tableHtml can hide columns.
// "__pre"/"__post" mark the unhideable fixed columns around the data ones
// (rank #, tx hash, block miner).
function rankRow(src: string, r: Record<string, unknown>, i: number): Array<[string, string]> {
  const rank: [string, string] = ["__pre", `<td class="num rank">${i + 1}</td>`];
  switch (src) {
    case "miners": return [rank, ["address", addrCell(r, "address", 6, "/miner/")], ["blocks", `<td class="num">${fmtInt(Number(r.blocks))}</td>`], ["rewards", `<td class="num">${atomic(Number(r.rewards))} XEL</td>`]];
    case "senders": return [rank, ["address", addrCell(r, "address", 8)], ["txs", `<td class="num">${fmtInt(Number(r.tx_count))}</td>`], ["outputs", `<td class="num">${fmtInt(Number(r.transfer_outputs))}</td>`]];
    case "burners": return [rank, ["address", addrCell(r, "address", 8)], ["burned", `<td class="num">${atomic(Number(r.burned))} XEL</td>`]];
    case "assets": {
      const sym = String(r.symbol ?? "");
      const id = String(r.asset_id ?? "");
      return [rank, ["asset", `<td title="${esc(id)}">${esc(sym || shortHash(id, 8))}</td>`], ["txs", `<td class="num">${fmtInt(Number(r.tx_count))}</td>`], ["transfers", `<td class="num">${fmtInt(Number(r.transfers))}</td>`]];
    }
    case "contracts": {
      const id = String(r.contract_id ?? "");
      return [rank, ["contract", `<td title="${esc(id)}">${esc(shortHash(id, 10))}</td>`], ["invokes", `<td class="num">${fmtInt(Number(r.invokes))}</td>`], ["gas", `<td class="num">${atomic(Number(r.gas))} XEL</td>`]];
    }
    default: return [rank, ["address", addrCell(r, "address")]];
  }
}

function listRow(src: string, r: Record<string, unknown>): Array<[string, string]> {
  if (src === "exchanges") {
    const bid = Number(r.bid ?? 0);
    const ask = Number(r.ask ?? 0);
    const spread = bid > 0 && ask > bid ? `${(((ask - bid) / ((ask + bid) / 2)) * 100).toFixed(2)}%` : "—";
    const chg = r.changePct24h;
    const chgHtml = chg === null || chg === undefined || !Number.isFinite(Number(chg))
      ? "—"
      : `<span style="color:${Number(chg) >= 0 ? "var(--mint)" : "var(--danger)"}">${Number(chg) >= 0 ? "+" : ""}${Number(chg).toFixed(2)}%</span>`;
    return [
      ["exchange", `<td>${esc(r.exchange)}</td>`],
      ["market", `<td>${esc(r.market)}</td>`],
      ["price", `<td class="num">$${Number(r.last ?? 0).toFixed(4)}</td>`],
      ["chg24h", `<td class="num">${chgHtml}</td>`],
      ["spread", `<td class="num">${spread}</td>`],
      ["volBase", `<td class="num">${fmt(Number(r.baseVolume ?? 0))}</td>`],
      ["volQuote", `<td class="num">$${fmt(Number(r.quoteVolume ?? 0))}</td>`],
      ["quoteAge", `<td class="num">${ago(normSecs(Number(r.timestamp)))}</td>`],
    ];
  }
  if (src === "peers") {
    return [
      ["version", `<td>${esc(r.version)}</td>`],
      ["peers", `<td class="num">${fmtInt(Number(r.peer_count))}</td>`],
      ["pruned", `<td class="num">${fmtInt(Number(r.pruned_count ?? 0))}</td>`],
    ];
  }
  if (src === "peer-tags") {
    return [["tag", `<td>${esc(r.tag)}</td>`], ["peers", `<td class="num">${fmtInt(Number(r.peers))}</td>`]];
  }
  if (src === "txs") {
    const hash = String(r.hash ?? "");
    const type = String(r.tx_type ?? "?");
    const topo = Number(r.block_topo);
    return [
      ["__pre", `<td title="${esc(hash)}"><a href="/tx/${esc(hash)}">${esc(shortHash(hash))}</a></td>`],
      ["type", `<td><span class="badge ${esc(type)}">${esc(type)}</span></td>`],
      ["block", `<td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>`],
      ["time", `<td class="num">${ago(normSecs(Number(r.ts)))}</td>`],
      ["fee", `<td class="num">${atomic(Number(r.fee), 6)} XEL</td>`],
      ["sender", addrCell(r, "sender", 8)],
    ];
  }
  if (src === "accounts" || src === "accounts-top") {
    const cols: Array<[string, string]> = [["address", addrCell(r, "address", 8)]];
    if (src === "accounts") cols.push(["last", `<td class="num">${ago(normSecs(Number(r.last_active)))}</td>`]);
    else {
      cols.push(["txs", `<td class="num">${fmtInt(Number(r.tx_count))}</td>`]);
      cols.push(["first", `<td class="num">${ago(normSecs(Number(r.first_seen)))}</td>`]);
    }
    return cols;
  }
  const type = String(r.block_type ?? "?");
  const topo = Number(r.topoheight);
  return [
    ["topo", `<td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>`],
    ["time", `<td class="num">${ago(normSecs(Number(r.ts)))}</td>`],
    ["txs", `<td class="num">${fmtInt(Number(r.tx_count))}</td>`],
    ["type", `<td><span class="bt ${esc(type.toLowerCase())}">${esc(type)}</span></td>`],
    ["__post", addrCell(r, "miner_address", 6, "/miner/")],
  ];
}

// Hideable list-table columns (sources not covered by the sortable
// WIDGET_COLS spec).
const LIST_COLS: Record<string, Array<{ key: string; label: string; num?: boolean }>> = {
  exchanges: [
    { key: "exchange", label: "Exchange" },
    { key: "market", label: "Market" },
    { key: "price", label: "Price", num: true },
    { key: "chg24h", label: "24h", num: true },
    { key: "spread", label: "Spread", num: true },
    { key: "volBase", label: "Vol (XEL)", num: true },
    { key: "volQuote", label: "Vol (USDT)", num: true },
    { key: "quoteAge", label: "Quote age", num: true },
  ],
  peers: [
    { key: "version", label: "Node version" },
    { key: "peers", label: "Peers", num: true },
    { key: "pruned", label: "Pruned", num: true },
  ],
  "peer-tags": [
    { key: "tag", label: "Tag" },
    { key: "peers", label: "Peers", num: true },
  ],
};

// Widget tables whose rows are sorted in SQL over the full dataset: headers
// refetch with ?sort/&dir instead of shuffling the fetched rows. Keys must
// exist in the API whitelists (src/server/sort.ts). pre/post are unsortable
// columns around the sortable ones (rank #, hash, miner).
interface SortCol {
  key: string;
  label: string;
  num?: boolean;
  def: "asc" | "desc";
}

interface SortCols {
  pre: string;
  post: string;
  cols: SortCol[];
}

const WIDGET_COLS: Record<string, SortCols> = {
  miners: {
    pre: '<th class="num">#</th>',
    post: "",
    cols: [
      { key: "address", label: "Miner", def: "asc" },
      { key: "blocks", label: "Blocks", num: true, def: "desc" },
      { key: "rewards", label: "Rewards", num: true, def: "desc" },
    ],
  },
  senders: {
    pre: '<th class="num">#</th>',
    post: "",
    cols: [
      { key: "address", label: "Sender", def: "asc" },
      { key: "txs", label: "Txs", num: true, def: "desc" },
      { key: "outputs", label: "Outputs", num: true, def: "desc" },
    ],
  },
  burners: {
    pre: '<th class="num">#</th>',
    post: "",
    cols: [
      { key: "address", label: "Address", def: "asc" },
      { key: "burned", label: "Burned", num: true, def: "desc" },
    ],
  },
  assets: {
    pre: '<th class="num">#</th>',
    post: "",
    cols: [
      { key: "asset", label: "Asset", def: "asc" },
      { key: "txs", label: "Txs", num: true, def: "desc" },
      { key: "transfers", label: "Transfers", num: true, def: "desc" },
    ],
  },
  contracts: {
    pre: '<th class="num">#</th>',
    post: "",
    cols: [
      { key: "contract", label: "Contract", def: "asc" },
      { key: "invokes", label: "Invokes", num: true, def: "desc" },
      { key: "gas", label: "Gas", num: true, def: "desc" },
    ],
  },
  blocks: {
    pre: "",
    post: "<th>Miner</th>",
    cols: [
      { key: "topo", label: "Block", num: true, def: "desc" },
      { key: "time", label: "Age", num: true, def: "asc" },
      { key: "txs", label: "Txs", num: true, def: "desc" },
      { key: "type", label: "Type", def: "asc" },
    ],
  },
  txs: {
    pre: "<th>Hash</th>",
    post: "",
    cols: [
      { key: "type", label: "Type", def: "asc" },
      { key: "block", label: "Block", num: true, def: "desc" },
      { key: "time", label: "Age", num: true, def: "asc" },
      { key: "fee", label: "Fee", num: true, def: "desc" },
      { key: "sender", label: "Sender", def: "asc" },
    ],
  },
  accounts: {
    pre: "",
    post: "",
    cols: [
      { key: "address", label: "Sender", def: "asc" },
      { key: "last", label: "Last active", num: true, def: "desc" },
    ],
  },
  "accounts-top": {
    pre: "",
    post: "",
    cols: [
      { key: "address", label: "Sender", def: "asc" },
      { key: "txs", label: "Txs", num: true, def: "desc" },
      { key: "first", label: "First seen", num: true, def: "asc" },
    ],
  },
};

const WIDGET_DEF: Record<string, string> = {
  miners: "blocks",
  senders: "txs",
  burners: "burned",
  assets: "txs",
  contracts: "invokes",
  blocks: "topo",
  txs: "block",
  accounts: "last",
  "accounts-top": "txs",
};

// Active sort for a widget's API-sorted table: opts value when valid, else the
// widget default.
function widgetSort(src: string, o: WidgetOpts): { key: string; dir: "asc" | "desc" } {
  const cols = WIDGET_COLS[src];
  if (!cols) return { key: "", dir: "desc" };
  const active = cols.cols.find((c) => c.key === o.sort) ?? cols.cols.find((c) => c.key === WIDGET_DEF[src])!;
  const dir = o.sort === active.key && (o.dir === "asc" || o.dir === "desc") ? o.dir : active.def;
  return { key: active.key, dir };
}

// Hideable column keys + labels for a table widget: the sortable spec when
// one exists, else the fixed LIST_COLS metadata (exchanges, peers).
function tableCols(item: CatalogItem): Array<{ key: string; label: string }> {
  const src = item.src ?? "";
  const sortCols = WIDGET_COLS[src];
  if (sortCols) return sortCols.cols;
  if (item.kind === "rank") return [{ key: "address", label: "Address" }];
  return LIST_COLS[src] ?? [];
}

function tableHtml(item: CatalogItem, rows: Array<Record<string, unknown>>, o: WidgetOpts): string {
  const src = item.src ?? "";
  const hidden = new Set(o.hiddenCols ?? []);
  const vis = (k: string): boolean => !hidden.has(k);
  const sortCols = WIDGET_COLS[src];
  const listCols = LIST_COLS[src] ?? [];

  // Head + row cells must follow the same column order.
  let head = "";
  let body = "";
  if (sortCols) {
    const { key, dir } = widgetSort(src, o);
    const shown = sortCols.cols.filter((c) => vis(c.key));
    head = sortCols.pre + shown.map((c) => {
      const on = c.key === key;
      return `<th class="sortable${c.num ? " num" : ""}" tabindex="0" data-col="${c.key}" data-def="${c.def}"${on ? ` data-dir="${dir}" aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""} title="Sort by ${c.label}">${c.label}</th>`;
    }).join("") + sortCols.post;
    body = rows.map((r, i) => {
      const m = new Map(item.kind === "rank" ? rankRow(src, r, i) : listRow(src, r));
      const rank = item.kind === "rank" ? (m.get("__pre") ?? `<td class="num rank"></td>`) : "";
      const pre = item.kind === "rank" ? "" : sortCols.pre ? (m.get("__pre") ?? "") : "";
      return `<tr>${rank}${pre}${shown.map((c) => m.get(c.key) ?? "<td></td>").join("")}${sortCols.post ? (m.get("__post") ?? "") : ""}</tr>`;
    }).join("");
  } else {
    const shown = listCols.filter((c) => vis(c.key));
    head = shown.map((c) => `<th${c.num ? ' class="num"' : ""}>${c.label}</th>`).join("");
    body = rows.map((r) => {
      const m = new Map(listRow(src, r));
      return `<tr>${shown.map((c) => m.get(c.key) ?? "<td></td>").join("")}</tr>`;
    }).join("");
  }
  return `<table${sortCols ? ' data-srvsort="1"' : ""}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Clicking a sortable widget header refetches from the API with the new sort —
// the ORDER BY runs over the full dataset, not just the fetched rows.
function wireSortClicks(w: Widget, body: HTMLElement): void {
  const table = body.querySelector("table");
  if (!table || !table.dataset.srvsort) return;
  const apply = (th: HTMLElement): void => {
    const key = th.dataset.col ?? "";
    if (!key) return;
    const same = w.opts?.sort === key && (w.opts?.dir === "asc" || w.opts?.dir === "desc");
    const dir: "asc" | "desc" = same ? (w.opts?.dir === "asc" ? "desc" : "asc") : ((th.dataset.def as "asc" | "desc") ?? "asc");
    th.dataset.dir = dir;
    // only show the spinner if the refetch takes a while
    setTimeout(() => { th.dataset.loading = "1"; }, 250);
    setOpt(w, "sort", key);
    setOpt(w, "dir", dir);
    persist();
    void mountTable(w).catch(() => {});
  };
  table.addEventListener("click", (ev) => {
    const th = (ev.target as HTMLElement).closest("th[data-col]") as HTMLElement | null;
    if (th) apply(th);
  });
  table.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const th = (ev.target as HTMLElement).closest("th[data-col]") as HTMLElement | null;
    if (th) { ev.preventDefault(); apply(th); }
  });
}

async function mountTable(w: Widget): Promise<void> {
  const item = byKey.get(w.key);
  const body = canvas?.querySelector<HTMLElement>(`[data-id="${w.id}"] .w-table`);
  if (!item || !body) return;
  const o = w.opts ?? {};
  const limit = o.limit ?? item.limit ?? 12;
  const period = o.period ?? item.period ?? "week";
  const { key: sortKey, dir: sortDir } = widgetSort(item.src ?? "", o);
  const sp = WIDGET_COLS[item.src ?? ""] ? `&sort=${sortKey}&dir=${sortDir}` : "";
  const url = item.kind === "rank"
    ? `/api/top/${item.src}?period=${period}&limit=${limit}${sp}`
    : item.src === "txs"
      ? `/api/transactions?limit=${limit}${o.txType ? `&type=${o.txType}` : ""}${sp}`
      : item.src === "accounts" || item.src === "accounts-top"
        ? `/api/accounts?limit=${limit}${sp}`
        : item.src === "exchanges"
          ? "/api/market"
          : item.src === "peer-tags"
            ? "/api/peers"
            : item.src === "peers"
              ? "/api/node-versions"
              : `/api/blocks?limit=${limit}${o.blockType ? `&type=${o.blockType}` : ""}${sp}`;
  if (!body.querySelector("table")) setLoading(w, true);
  try {
    const j = await fetch(url).then((r) => r.json()) as Record<string, unknown[]>;
    const rows = (j.rows ?? j.blocks ?? j.transactions ?? j.accounts ?? j.tickers ?? j.versions ?? j.tags ?? []) as Record<string, unknown>[];
    setLoading(w, false);
    body.innerHTML = rows.length ? tableHtml(item, rows, o) : '<p class="w-empty">No data available yet.</p>';
    wireSortClicks(w, body);
    refreshSort(body);
  } catch {
    setLoading(w, false);
    body.innerHTML = '<p class="w-empty">Failed to load data.</p>';
  }
}

function mountChart(w: Widget): void {
  const item = byKey.get(w.key);
  const body = chartBody(w);
  if (!item || !body) return;
  const o = w.opts ?? {};
  const prev = charts.get(w.id);
  if (prev) { prev.destroy(); charts.delete(w.id); }
  const p = new URLSearchParams();
  if (o.range === "custom" && (o.from || o.to)) {
    if (o.from) p.set("from", o.from);
    if (o.to) p.set("to", o.to);
  } else {
    p.set("range", o.range ?? item.range ?? "90d");
  }
  p.set("interval", o.interval ?? item.interval ?? "day");
  setLoading(w, true);
  void fetch(`/api/history/${item.metric}?${p.toString()}`)
    .then((r) => r.json())
    .then((j: unknown) => {
      setLoading(w, false);
      let points = (j as { points?: SeriesPoint[] }).points ?? [];
      if (!points.length) {
        body.innerHTML = '<p class="w-empty">No data for this range yet.</p>';
        return;
      }
      if (o.cum) points = cumulativePoints(points);
      const inst = renderChart(body, points, item.label, undefined, { type: o.type, log: o.log, accent: o.accent, fill: o.fill, points: o.points, lineWidth: o.lineWidth });
      if (inst) charts.set(w.id, inst);
    })
    .catch(() => { setLoading(w, false); body.innerHTML = '<p class="w-empty">Failed to load series.</p>'; });
}

function metricLabel(m: string): string {
  return CATALOG.find((c) => c.metric === m)?.label ?? m;
}

async function mountCompare(w: Widget): Promise<void> {
  const item = byKey.get(w.key);
  const body = chartBody(w);
  if (!item || !body) return;
  const metrics = item.metrics ?? [];
  if (!metrics.length) return;
  const o = w.opts ?? {};
  const prev = charts.get(w.id);
  if (prev) { prev.destroy(); charts.delete(w.id); }
  const p = new URLSearchParams();
  if (o.range === "custom" && (o.from || o.to)) {
    if (o.from) p.set("from", o.from);
    if (o.to) p.set("to", o.to);
  } else {
    p.set("range", o.range ?? item.range ?? "90d");
  }
  p.set("interval", o.interval ?? item.interval ?? "day");
  const qs = p.toString();
  setLoading(w, true);
  try {
    const series = (await Promise.all(metrics.map(async (m) => {
      const j = await fetch(`/api/history/${m}?${qs}`).then((r) => r.json()) as { points?: SeriesPoint[] };
      return { label: metricLabel(m), points: j.points ?? [] };
    }))).filter((s) => s.points.length);
    setLoading(w, false);
    if (!series.length) {
      body.innerHTML = '<p class="w-empty">No data for this range yet.</p>';
      return;
    }
    const inst = renderCompare(body, series, { type: o.type, log: o.log ?? item.log, accent: o.accent, fill: o.fill, points: o.points, lineWidth: o.lineWidth });
    if (inst) charts.set(w.id, inst);
  } catch {
    setLoading(w, false);
    body.innerHTML = '<p class="w-empty">Failed to load series.</p>';
  }
}

function resizeCharts(): void {
  for (const [id, inst] of charts) {
    const w = widgets.find((x) => x.id === id);
    const body = w ? chartBody(w) : null;
    if (!body) continue;
    try { inst.setSize({ width: body.clientWidth || 320, height: body.clientHeight || 180 }); } catch { /* detached */ }
  }
}

function applyChrome(w: Widget, el: HTMLElement): void {
  const item = byKey.get(w.key);
  el.style.setProperty("--w-accent", accentHex(w.opts?.accent) ?? "var(--mint)");
  const title = el.querySelector<HTMLElement>(".w-title");
  if (title) title.textContent = w.opts?.title || item?.label || w.key;
}

function widgetEl(w: Widget, s: Slot): HTMLElement {
  const item = byKey.get(w.key);
  const el = document.createElement("article");
  el.className = "widget";
  el.dataset.id = w.id;
  const hasFilters = item?.kind !== "stat";
  el.innerHTML = `
    <header class="w-head" tabindex="0" role="button" aria-label="${item?.label ?? "widget"} — drag to move">
      <span class="w-grip" aria-hidden="true">⠿</span>
      <h3 class="w-title">${esc(w.opts?.title || item?.label || w.key)}</h3>
      <span class="w-spacer"></span>
      ${hasFilters ? `<button class="w-btn" data-act="filters" aria-label="Data filters" title="Data filters">▽</button>` : ""}
      <button class="w-btn" data-act="panel" aria-label="Panel options" title="Panel options">⚙</button>
      <button class="w-btn" data-act="remove" aria-label="Remove widget" title="Remove">×</button>
    </header>
    <div class="w-body">
      <div class="w-main">${item?.kind === "stat" ? '<div class="w-stat"></div>' : item?.kind === "rank" || item?.kind === "list" ? '<div class="w-table"></div>' : '<div class="w-chart"></div>'}</div>
    </div>
    <span class="w-resize" role="separator" aria-label="Resize widget"></span>`;
  applyPlacement(s, el);
  applyChrome(w, el);
  if (item?.kind === "stat" && !summary) {
    const statBody = el.querySelector<HTMLElement>(".w-stat");
    if (statBody) {
      el.classList.add("loading");
      statBody.innerHTML = skeletonHtml("stat");
    }
  }

  el.querySelector<HTMLElement>("[data-act=remove]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    removeWidget(w.id);
  });
  el.querySelector<HTMLElement>("[data-act=filters]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleSettings(w, el, "filters");
  });
  el.querySelector<HTMLElement>("[data-act=panel]")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleSettings(w, el, "panel");
  });

  el.querySelector<HTMLElement>(".w-head")?.addEventListener("pointerdown", (ev) => startDrag(ev, w, el));
  el.querySelector<HTMLElement>(".w-head")?.addEventListener("keydown", (ev) => onWidgetKey(ev, w, el));
  el.querySelector<HTMLElement>(".w-resize")?.addEventListener("pointerdown", (ev) => startResize(ev, w, el));

  return el;
}

// ---------- per-widget settings ----------

type SetMode = "filters" | "panel";

function setOpt(w: Widget, field: keyof WidgetOpts, value: unknown): void {
  if (!w.opts) w.opts = {};
  if (value === "" || value === false || value === undefined) delete w.opts[field];
  else (w.opts as Record<string, unknown>)[field] = value;
}

// The settings popover lives on document.body (not inside the widget) so it
// escapes the widget's overflow clipping and stacking context — otherwise
// neighbouring widgets paint over it. It is linked back via its id.
function popoverId(id: string): string {
  return `w-pop-${id}`;
}

function popoverOf(w: Widget): HTMLElement | null {
  return document.getElementById(popoverId(w.id));
}

function removePopover(id: string): void {
  document.getElementById(popoverId(id))?.remove();
}

function closeSettings(w: Widget, el: HTMLElement): void {
  popoverOf(w)?.remove();
  el.querySelectorAll<HTMLElement>(".w-btn[data-act=filters], .w-btn[data-act=panel]").forEach((b) => b.classList.remove("on"));
}

// Anchor the popover to the widget header and clamp it to the viewport, so
// small widgets still get a full-size, fully visible settings popover.
function placePopover(el: HTMLElement, panel: HTMLElement): void {
  const anchor = el.querySelector<HTMLElement>(".w-head");
  if (!anchor) return;
  const a = anchor.getBoundingClientRect();
  panel.style.visibility = "hidden";
  panel.style.left = "0px";
  panel.style.top = "0px";
  requestAnimationFrame(() => {
    if (!panel.isConnected) return;
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const margin = 8;
    let x = a.right - pw;
    x = Math.min(Math.max(x, margin), Math.max(window.innerWidth - pw - margin, margin));
    let y = a.bottom + 6;
    if (y + ph > window.innerHeight - margin) {
      // prefer opening above the header when space is tight below
      y = a.top - ph - 6;
    }
    y = Math.min(Math.max(y, margin), Math.max(window.innerHeight - ph - margin, margin));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.visibility = "";
  });
}

function toggleSettings(w: Widget, el: HTMLElement, mode: SetMode): void {
  let panel = popoverOf(w);
  if (panel && !panel.hidden && panel.dataset.mode === mode) {
    closeSettings(w, el);
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "w-settings w-pop";
    panel.id = popoverId(w.id);
    document.body.appendChild(panel);
  }
  panel.dataset.mode = mode;
  panel.innerHTML = settingsHtml(w, mode);
  wireSettings(w, el, panel, mode);
  panel.hidden = false;
  placePopover(el, panel);
  el.querySelectorAll<HTMLElement>(".w-btn[data-act=filters], .w-btn[data-act=panel]").forEach((b) =>
    b.classList.toggle("on", b.dataset.act === mode));
}

function settingsHtml(w: Widget, mode: SetMode): string {
  const item = byKey.get(w.key);
  const o = w.opts ?? {};
  const sel = (cur: string, vals: string[], opt: string): string =>
    `<select data-opt="${opt}">${vals.map((v) => `<option value="${v}" ${cur === v ? "selected" : ""}>${v || "all"}</option>`).join("")}</select>`;

  // Hide/show column checkboxes for table widgets. A hidden col is one
  // missing from opts.hiddenCols; unchecked means hidden.
  const colChk = (it: CatalogItem): string => {
    const cols = tableCols(it);
    if (!cols.length) return "";
    const hid = o.hiddenCols ?? [];
    return `
      <div class="w-set-row">
        <span class="w-set-chks">
          <span class="w-set-lab">Columns</span>
          ${cols.map((c) => `<label class="w-set-chk" title="Show the ${esc(c.label)} column"><input type="checkbox" data-opt="hiddenCols" data-col="${esc(c.key)}" ${hid.includes(c.key) ? "" : "checked"}/> ${esc(c.label)}</label>`).join("")}
        </span>
      </div>`;
  };

  const swatches = Object.entries(ACCENTS).map(([name, hex]) =>
    `<button type="button" class="sw${(o.accent ?? "mint") === name ? " on" : ""}" data-accent="${name}" style="background:${hex}" aria-label="Accent ${name}" title="${name}"></button>`
  ).join("");

  // Extra appearance controls, specific to the widget kind.
  const extras =
    item?.kind === "stat"
      ? `
      <div class="w-set-row">
        <label>Value size ${sel(o.valueSize ?? "normal", ["small", "normal", "large"], "valueSize")}</label>
        <span class="w-set-chks">
          <label class="w-set-chk" title="Hide the secondary line under the value"><input type="checkbox" data-opt="hideSub" ${o.hideSub ? "checked" : ""}/> hide subtitle</label>
        </span>
      </div>`
: item?.kind === "chart" || item?.kind === "compare"
          ? o.type === "bar"
            ? `
      <div class="w-set-row">
        <label>Type ${sel(o.type, ["line", "bar"], "type")}</label>
        <label>Bar width ${sel(o.lineWidth ?? "normal", ["thin", "normal", "thick"], "lineWidth")}</label>
      </div>`
            : `
      <div class="w-set-row">
        <label>Type ${sel(o.type ?? "line", ["line", "bar"], "type")}</label>
        <label>Line width ${sel(o.lineWidth ?? "normal", ["thin", "normal", "thick"], "lineWidth")}</label>
      </div>
      <div class="w-set-row">
        <span class="w-set-chks">
          <label class="w-set-chk" title="Fill the area under the line"><input type="checkbox" data-opt="fill" ${o.fill !== false ? "checked" : ""}/> fill</label>
          <label class="w-set-chk" title="Always show data point markers"><input type="checkbox" data-opt="points" ${o.points ? "checked" : ""}/> markers</label>
        </span>
      </div>`
          : "";

  const body = mode === "panel"
    ? `
      <label class="w-set-lab">Title <input type="text" maxlength="60" data-opt="title" value="${esc(o.title ?? "")}" placeholder="${esc(item?.label ?? "")}"/></label>
      <div class="w-set-row"><span class="w-set-lab">Accent</span><span class="swatches">${swatches}</span></div>
      ${extras}`
    : (() => {
        if (item?.kind === "chart") {
          const range = o.range ?? item.range ?? "90d";
          const custom = range === "custom";
          return `
            <div class="w-set-row">
              <label>Period ${sel(range, RANGES, "range")}</label>
              <label>Interval ${sel(o.interval ?? item.interval ?? "day", INTERVALS, "interval")}</label>
            </div>
            <div class="w-set-row" data-custom ${custom ? "" : "hidden"}>
              <label>From <input type="text" data-datepicker data-opt="from" value="${esc(o.from ?? "")}"/></label>
              <label>To <input type="text" data-datepicker data-opt="to" value="${esc(o.to ?? "")}"/></label>
            </div>
            <div class="w-set-row">
              <span class="w-set-chks">
                <label class="w-set-chk"><input type="checkbox" data-opt="log" ${o.log ? "checked" : ""}/> log</label>
                <label class="w-set-chk"><input type="checkbox" data-opt="cum" ${o.cum ? "checked" : ""}/> cumulative</label>
              </span>
            </div>`;
        }
        if (item?.kind === "compare") {
          const range = o.range ?? item.range ?? "90d";
          const custom = range === "custom";
          return `
            <div class="w-set-row">
              <label>Period ${sel(range, RANGES, "range")}</label>
              <label>Interval ${sel(o.interval ?? item.interval ?? "day", INTERVALS, "interval")}</label>
            </div>
            <div class="w-set-row" data-custom ${custom ? "" : "hidden"}>
              <label>From <input type="text" data-datepicker data-opt="from" value="${esc(o.from ?? "")}"/></label>
              <label>To <input type="text" data-datepicker data-opt="to" value="${esc(o.to ?? "")}"/></label>
            </div>
            <div class="w-set-row">
              <span class="w-set-chks">
                <label class="w-set-chk"><input type="checkbox" data-opt="log" ${(o.log ?? item.log) ? "checked" : ""}/> log</label>
              </span>
            </div>`;
        }
        if (item?.kind === "rank") {
          return `
            <div class="w-set-row">
              <label>Period ${sel(o.period ?? item.period ?? "week", RANK_PERIODS, "period")}</label>
              <label>Rows ${sel(String(o.limit ?? item.limit ?? 10), LIMITS.map(String), "limit")}</label>
            </div>${colChk(item)}`;
        }
        if (item?.kind === "list") {
          const rows = `<div class="w-set-row"><label>Rows ${sel(String(o.limit ?? item.limit ?? 12), LIMITS.map(String), "limit")}</label></div>`;
          if (item.src === "txs") {
            const types = ["", ...TX_TYPES];
            return `
              ${rows}
              <div class="w-set-row"><label>Type ${sel(o.txType ?? "", types, "txType")}</label></div>${colChk(item)}`;
          }
          if (item.src === "blocks") {
            const types = ["", ...BLOCK_TYPES];
            return `
              ${rows}
              <div class="w-set-row"><label>Block type ${sel(o.blockType ?? "", types, "blockType")}</label></div>${colChk(item)}`;
          }
          return `${rows}${colChk(item)}`;
        }
        return '<p class="w-set-none">No data filters for this widget.</p>';
      })();

  return `
    <div class="w-set-group">
      <span class="w-set-group-t">${mode === "panel" ? "Panel options" : "Data filters"}</span>
      ${body}
    </div>
    <div class="w-set-actions">
      <button type="button" class="w-btn" data-act="settings-duplicate" title="Add a copy of this widget">⧉ duplicate</button>
      <button type="button" class="w-btn" data-act="settings-reset" title="Reset all widget options">↺ reset</button>
      <button type="button" class="w-btn" data-act="settings-close">done</button>
    </div>`;
}

function wireSettings(w: Widget, el: HTMLElement, panel: HTMLElement, mode: SetMode): void {
  const item = byKey.get(w.key);
  const customRow = panel.querySelector<HTMLElement>("[data-custom]");

  const apply = (refetch: boolean): void => {
    persist();
    applyChrome(w, el);
    if (!refetch) return;
    const kind = item?.kind;
    if (kind === "stat") renderStats();
    else if (kind === "chart") mountChart(w);
    else if (kind === "compare") void mountCompare(w);
    else if (kind === "rank" || kind === "list") void mountTable(w);
  };

  panel.addEventListener("input", (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.opt === "title") {
      setOpt(w, "title", t.value.trim());
      applyChrome(w, el);
      persist();
    }
  });

  panel.addEventListener("change", (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    const opt = t.dataset.opt as keyof WidgetOpts | undefined;
    if (!opt || opt === "title") return;
    if (opt === "hiddenCols" && t instanceof HTMLInputElement) {
      const key = t.dataset.col ?? "";
      const cur = new Set(w.opts?.hiddenCols ?? []);
      if (t.checked) cur.delete(key);
      else cur.add(key);
      if (!w.opts) w.opts = {};
      if (cur.size) w.opts.hiddenCols = [...cur];
      else delete w.opts.hiddenCols;
      apply(true);
      return;
    }
    if (opt === "type" && t instanceof HTMLSelectElement) {
      setOpt(w, "type", t.value);
      // re-render so bar/line-specific controls match the new type
      panel.innerHTML = settingsHtml(w, mode);
      wireSettings(w, el, panel, mode);
      apply(true);
      return;
    }
    if (opt === "range" && customRow) {
      // switching to custom with empty dates: prefill last 30 days
      if ((t as HTMLSelectElement).value === "custom" && !w.opts?.from && !w.opts?.to) {
        const now = new Date();
        setOpt(w, "to", now.toISOString().slice(0, 10));
        setOpt(w, "from", new Date(now.getTime() - 30 * 86400_000).toISOString().slice(0, 10));
        panel.innerHTML = settingsHtml(w, mode);
        wireSettings(w, el, panel, mode);
      } else {
        setOpt(w, "range", (t as HTMLSelectElement).value);
        customRow.hidden = (t as HTMLSelectElement).value !== "custom";
      }
      apply(true);
      return;
    }
    if (t instanceof HTMLInputElement && t.type === "checkbox") {
      // fill defaults to on: persist the explicit false instead of deleting it
      if (opt === "fill") {
        if (!w.opts) w.opts = {};
        w.opts.fill = t.checked;
      } else {
        setOpt(w, opt, t.checked);
      }
      apply(true);
      return;
    }
    setOpt(w, opt, opt === "limit" ? Number((t as HTMLSelectElement).value) : (t as HTMLInputElement).value.trim());
    apply(true);
  });

  panel.addEventListener("click", (ev) => {
    const sw = (ev.target as HTMLElement).closest<HTMLElement>("[data-accent]");
    if (sw) {
      setOpt(w, "accent", w.opts?.accent === sw.dataset.accent ? undefined : sw.dataset.accent);
      panel.querySelectorAll<HTMLElement>(".sw").forEach((s) => s.classList.toggle("on", (w.opts?.accent ?? "mint") === s.dataset.accent));
      apply(item?.kind === "chart" || item?.kind === "compare");
      return;
    }
    if ((ev.target as HTMLElement).closest("[data-act=settings-duplicate]")) {
      if (!item) return;
      closeSettings(w, el);
      const slot = firstFree(item);
      const copy: Widget = { id: nid(), key: w.key, x: slot.x, y: slot.y, w: w.w, h: w.h, opts: w.opts ? { ...w.opts } : undefined };
      widgets.push(copy);
      persist();
      render();
      return;
    }
    if ((ev.target as HTMLElement).closest("[data-act=settings-reset]")) {
      w.opts = {};
      panel.innerHTML = settingsHtml(w, mode);
      wireSettings(w, el, panel, mode);
      apply(true);
      return;
    }
    if ((ev.target as HTMLElement).closest("[data-act=settings-close]")) {
      closeSettings(w, el);
    }
  });

  attachDatePickers(panel);
}

function onWidgetKey(ev: KeyboardEvent, w: Widget, el: HTMLElement): void {
  const k = ev.key;
  if (k === "Backspace" || k === "Delete") {
    ev.preventDefault();
    removeWidget(w.id);
    return;
  }
  if (!ev.altKey || cols < CANON_COLS) return;
  let dx = 0;
  let dy = 0;
  let dw = 0;
  let dh = 0;
  if (k === "ArrowLeft") dx = -1;
  else if (k === "ArrowRight") dx = 1;
  else if (k === "ArrowUp") dy = -1;
  else if (k === "ArrowDown") dy = 1;
  else return;
  ev.preventDefault();
  if (ev.shiftKey) { dw = dx; dh = dy; }
  const next: Widget = { ...w, x: w.x + dx, y: w.y + dy, w: w.w + dw, h: w.h + dh };
  clampPos(next);
  const slot = findFree(widgets, next, w.id);
  next.x = slot.x;
  next.y = slot.y;
  Object.assign(w, next);
  layout();
  persist();
  el.focus();
}

function startDrag(ev: PointerEvent, w: Widget, el: HTMLElement): void {
  if (cols < CANON_COLS) return;
  if ((ev.target as HTMLElement).closest("button")) return;
  ev.preventDefault();
  const head = ev.currentTarget as HTMLElement;
  head.setPointerCapture(ev.pointerId);
  // pageX/pageY include the window scroll offset, so deltas stay valid if the
  // page is scrolled (wheel or edge auto-scroll) while a drag is in progress.
  const startX = ev.pageX;
  const startY = ev.pageY;
  const origin = { x: w.x, y: w.y };
  el.classList.add("dragging");
  const ghost = document.createElement("div");
  ghost.className = "drop-ghost";
  canvas?.appendChild(ghost);

  const move = (e: PointerEvent): void => {
    el.style.transform = `translate(${e.pageX - startX}px, ${e.pageY - startY}px)`;
    const dcol = Math.round((e.pageX - startX) / stepX());
    const drow = Math.round((e.pageY - startY) / stepY());
    const target: Widget = { ...w, x: origin.x + dcol, y: Math.max(origin.y + drow, 0) };
    clampPos(target);
    ghost.style.left = `${gap + target.x * stepX()}px`;
    ghost.style.top = `${gap + target.y * stepY()}px`;
    ghost.style.width = `${target.w * colW + (target.w - 1) * gap}px`;
    ghost.style.height = `${target.h * rowH + (target.h - 1) * gap}px`;
  };
  const up = (e: PointerEvent): void => {
    head.removeEventListener("pointermove", move);
    head.removeEventListener("pointerup", up);
    head.removeEventListener("pointercancel", up);
    const dcol = Math.round((e.pageX - startX) / stepX());
    const drow = Math.round((e.pageY - startY) / stepY());
    const target: Widget = { ...w, x: origin.x + dcol, y: Math.max(origin.y + drow, 0) };
    clampPos(target);
    const slot = findFree(widgets, target, w.id);
    w.x = slot.x;
    w.y = slot.y;
    el.style.transform = "";
    el.classList.remove("dragging");
    ghost.remove();
    layout();
    persist();
  };
  head.addEventListener("pointermove", move);
  head.addEventListener("pointerup", up);
  head.addEventListener("pointercancel", up);
}

function startResize(ev: PointerEvent, w: Widget, el: HTMLElement): void {
  if (cols < CANON_COLS) return;
  ev.preventDefault();
  ev.stopPropagation();
  const grip = ev.currentTarget as HTMLElement;
  grip.setPointerCapture(ev.pointerId);
  // pageX/pageY keep resize deltas stable if the page scrolls mid-gesture.
  const startX = ev.pageX;
  const startY = ev.pageY;
  const origin = { w: w.w, h: w.h };

  const move = (e: PointerEvent): void => {
    const dw = Math.round((e.pageX - startX) / stepX());
    const dh = Math.round((e.pageY - startY) / stepY());
    w.w = Math.min(Math.max(origin.w + dw, 2), CANON_COLS - w.x);
    w.h = Math.max(origin.h + dh, 2);
    applyPlacement({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h });
  };
  const up = (): void => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    grip.removeEventListener("pointercancel", up);
    const next: Widget = { ...w };
    const slot = findFree(widgets, next, w.id);
    w.x = slot.x;
    w.y = slot.y;
    layout();
    persist();
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
  grip.addEventListener("pointercancel", up);
}

function removeWidget(id: string): void {
  const chart = charts.get(id);
  if (chart) { chart.destroy(); charts.delete(id); }
  removePopover(id);
  widgets = widgets.filter((w) => w.id !== id);
  persist();
  render();
}

function addWidget(key: string): void {
  const item = byKey.get(key);
  if (!item) return;
  const slot = firstFree(item);
  const w: Widget = { id: nid(), key, x: slot.x, y: slot.y, w: Math.min(item.w, CANON_COLS), h: item.h };
  widgets.push(w);
  persist();
  render();
}

function autoArrange(): void {
  const sorted = [...widgets].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  let cx = 0;
  let cy = 0;
  let rowMax = 0;
  for (const w of sorted) {
    if (cx + w.w > CANON_COLS) { cx = 0; cy += rowMax; rowMax = 0; }
    const probe: Widget = { ...w, x: cx, y: cy };
    const slot = findFree(widgets, probe, w.id);
    w.x = slot.x;
    w.y = slot.y;
    cx = w.x + w.w;
    rowMax = Math.max(rowMax, w.h);
  }
  persist();
  render();
}

function resetLayout(): void {
  for (const chart of charts.values()) chart.destroy();
  charts.clear();
  tabs = defaultTabs();
  activeTab = tabs[0].id;
  widgets = tabs[0].widgets;
  persist();
  renderTabs();
  render();
}

function exportLayout(): void {
  const blob = new Blob([JSON.stringify({ version: 4, tabs, active: activeTab } satisfies Persisted, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "xelis-dashboard-layout.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importLayoutFile(file: File): void {
  void file.text().then((text) => {
    const state = parsePersisted(text);
    if (!state) {
      alert("Import failed: not a valid dashboard layout file (expected a dashboard export).");
      return;
    }
    for (const chart of charts.values()) chart.destroy();
    charts.clear();
    tabs = state.tabs;
    activeTab = state.active || state.tabs[0].id;
    widgets = tabs.find((t) => t.id === activeTab)!.widgets;
    persist();
    canonicalize();
    renderTabs();
    render();
  });
}

// Repairs a stored layout once, in canonical 12-column space: clamps sizes
// and resolves overlaps. This is the only place a loaded layout is rewritten.
function canonicalize(): void {
  const placed: Widget[] = [];
  let dirty = false;
  for (const w of [...widgets].sort((a, b) => (a.y - b.y) || (a.x - b.x))) {
    const before = `${w.x},${w.y},${w.w},${w.h}`;
    w.w = Math.min(Math.max(Math.round(w.w) || 2, 2), CANON_COLS);
    w.h = Math.max(Math.round(w.h) || 2, 2);
    clampPos(w);
    const slot = findFree(placed, w, w.id);
    w.x = slot.x;
    w.y = slot.y;
    if (`${w.x},${w.y},${w.w},${w.h}` !== before) dirty = true;
    placed.push(w);
  }
  if (dirty) persist();
}

// Derives the on-screen arrangement from the canonical layout. Pure function of
// (widgets, cols): resizing only changes this projection, never the layout.
function projectLayout(): Slot[] {
  const sorted = [...widgets].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  if (cols >= CANON_COLS) return sorted.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h }));
  if (cols <= 2) {
    let y = 0;
    return sorted.map((w) => {
      const slot = { id: w.id, x: 0, y, w: cols, h: w.h };
      y += w.h;
      return slot;
    });
  }
  const scale = cols / CANON_COLS;
  const placed: Widget[] = [];
  return sorted.map((w) => {
    const cand: Widget = {
      ...w,
      w: Math.min(Math.max(Math.round(w.w * scale), 2), cols),
      x: Math.round(w.x * scale),
    };
    clampPos(cand, cols);
    const slot = findFree(placed, cand, cand.id, cols);
    cand.x = slot.x;
    cand.y = slot.y;
    placed.push(cand);
    return { id: cand.id, x: cand.x, y: cand.y, w: cand.w, h: cand.h };
  });
}

function applyPlacement(s: Slot, el?: HTMLElement): void {
  const target = el ?? canvas?.querySelector<HTMLElement>(`[data-id="${s.id}"]`);
  if (!target) return;
  target.style.gridColumn = `${s.x + 1} / span ${s.w}`;
  target.style.gridRow = `${s.y + 1} / span ${s.h}`;
  target.style.order = "";
  target.classList.toggle("movable", cols >= CANON_COLS);
}

function applyView(): void {
  if (!canvas) return;
  for (const s of view) applyPlacement(s);
  const maxRow = view.reduce((m, s) => Math.max(m, s.y + s.h), 0);
  canvas.style.minHeight = `${Math.max(14, maxRow + 3) * stepY() + gap}px`;
  resizeCharts();
}

function layout(): void {
  if (!canvas) return;
  view = projectLayout();
  applyView();
}

function render(): void {
  if (!canvas) return;
  for (const chart of charts.values()) chart.destroy();
  charts.clear();
  // drop stale settings popovers from the previous render pass
  removeOpenPopovers();
  canvas.innerHTML = "";
  view = projectLayout();
  const slots = new Map(view.map((s) => [s.id, s]));
  for (const w of widgets) {
    const s = slots.get(w.id);
    if (s) canvas.appendChild(widgetEl(w, s));
  }
  if (!widgets.length) {
    const empty = document.createElement("p");
    empty.className = "w-empty dash-empty";
    empty.textContent = "This tab is empty — add a widget to get started.";
    canvas.appendChild(empty);
  }
  applyView();
  void refreshSummary().then(renderStats);
  for (const w of widgets) {
    const kind = byKey.get(w.key)?.kind;
    if (kind === "chart") mountChart(w);
    else if (kind === "compare") void mountCompare(w);
    else if (kind === "rank" || kind === "list") void mountTable(w);
  }
}

// ---------- tabs ----------

function tabStrip(): HTMLElement | null {
  return document.getElementById("dash-tabs");
}

function renderTabs(): void {
  const strip = tabStrip();
  if (!strip) return;
  strip.innerHTML = tabs.map((t) => `
    <div class="dash-tab${t.id === activeTab ? " active" : ""}" data-tab="${t.id}" role="tab" tabindex="0" aria-selected="${t.id === activeTab}">
      <span class="dash-tab-name">${esc(t.name)}</span>
      <button class="dash-tab-btn" data-act="rename" aria-label="Rename tab" title="Rename">✎</button>
      ${tabs.length > 1 ? `<button class="dash-tab-btn" data-act="close" aria-label="Close tab" title="Close tab">×</button>` : ""}
    </div>`).join("") + `<button class="dash-tab-add" id="btn-add-tab" aria-label="New tab" title="New tab">+</button>`;
}

function switchTab(id: string): void {
  if (id === activeTab) return;
  const next = tabs.find((t) => t.id === id);
  if (!next) return;
  for (const chart of charts.values()) chart.destroy();
  charts.clear();
  removeOpenPopovers();
  activeTab = id;
  widgets = next.widgets;
  persist();
  renderTabs();
  render();
}

function removeOpenPopovers(): void {
  document.querySelectorAll<HTMLElement>(".w-settings.w-pop").forEach((p) => p.remove());
}

function addTab(): void {
  const name = prompt("Tab name:", "New tab");
  if (name === null) return;
  const tab: Tab = { id: nid(), name: name.trim().slice(0, 40) || "New tab", widgets: [] };
  tabs.push(tab);
  persist();
  switchTab(tab.id);
}

function closeTab(id: string): void {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (!confirm(`Close tab "${tabs[idx].name}"? Its widgets will be removed.`)) return;
  tabs.splice(idx, 1);
  if (activeTab === id) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeTab = "";
    switchTab(next.id);
  } else {
    persist();
    renderTabs();
  }
}

function renameTab(id: string): void {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  const name = prompt("Tab name:", tab.name);
  if (name === null) return;
  tab.name = name.trim().slice(0, 40) || tab.name;
  persist();
  renderTabs();
}

function wireTabs(): void {
  const strip = tabStrip();
  if (!strip) return;
  strip.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const tabEl = t.closest<HTMLElement>("[data-tab]");
    if (!tabEl) {
      if (t.closest("#btn-add-tab")) addTab();
      return;
    }
    const id = tabEl.dataset.tab ?? "";
    if (t.closest('[data-act="close"]')) closeTab(id);
    else if (t.closest('[data-act="rename"]')) renameTab(id);
    else switchTab(id);
  });
  strip.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const tabEl = (ev.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (tabEl) { ev.preventDefault(); switchTab(tabEl.dataset.tab ?? ""); }
  });
}

function renderPalette(query: string): void {
  const overlay = document.getElementById("palette");
  const list = document.getElementById("palette-list");
  if (!overlay || !list) return;
  const q = query.trim().toLowerCase();
  const matches = (c: CatalogItem): boolean => !q || `${c.label} ${c.desc} ${c.kind}`.toLowerCase().includes(q);
  const counts = new Map<string, number>();
  for (const w of widgets) counts.set(w.key, (counts.get(w.key) ?? 0) + 1);
  const section = (title: string, kind: Kind): string => {
    const items = CATALOG.filter((c) => c.kind === kind && matches(c)).map((c) => {
      const used = counts.get(c.key) ?? 0;
      const tag = used === 0 ? "" : used === 1 ? '<span class="used-tag">✓ Added</span>' : `<span class="used-tag">✓ ${used}× on board</span>`;
      return `<button class="palette-item${used ? " is-used" : ""}" data-key="${c.key}" aria-pressed="${used > 0}">
        <span class="pt"><span>${c.label}</span>${tag}</span>
        <span class="pd">${c.desc}</span>
      </button>`;
    }).join("");
    return items ? `<div class="palette-section">${title}</div>${items}` : "";
  };
  const safeQuery = query.replace(/[&<>"']/g, "");
  const html = section("Stat cards", "stat") + section("Charts", "chart") + section("Compare", "compare") + section("Rankings", "rank") + section("Lists", "list");
  list.innerHTML = html || `<p class="palette-empty">No widgets match “${safeQuery}”.</p>`;
  list.querySelectorAll<HTMLElement>(".palette-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      addWidget(btn.dataset.key ?? "");
      renderPalette((document.getElementById("palette-search") as HTMLInputElement | null)?.value ?? "");
    });
  });
}

function togglePalette(show: boolean): void {
  const overlay = document.getElementById("palette");
  if (!overlay) return;
  overlay.hidden = !show;
  if (show) {
    const search = document.getElementById("palette-search") as HTMLInputElement | null;
    if (search) { search.value = ""; }
    renderPalette("");
    search?.focus();
  }
}

export function initDashboard(): void {
  canvas = document.getElementById("custom-grid");
  if (!canvas) return;

  const state = loadState();
  tabs = state.tabs;
  activeTab = state.active || (tabs[0]?.id ?? "");
  widgets = tabs.find((t) => t.id === activeTab)?.widgets ?? tabs[0].widgets;
  measure();
  canonicalize();
  renderTabs();
  wireTabs();
  render();

  const toolbar = document.querySelector(".dash-toolbar");
  const sentinel = document.querySelector(".dash-toolbar-sentinel");
  if (toolbar && sentinel) {
    new IntersectionObserver(([entry]) => {
      toolbar.classList.toggle("is-stuck", !entry?.isIntersecting);
    }).observe(sentinel);
  }

  const header = document.querySelector<HTMLElement>("header.site");
  const syncToolbarOffset = (): void => {
    if (!header) return;
    const top = parseFloat(getComputedStyle(header).top) || 0;
    const height = header.getBoundingClientRect().height;
    document.documentElement.style.setProperty("--site-header-offset", `${Math.round(top + height + 8)}px`);
  };
  syncToolbarOffset();
  window.addEventListener("resize", syncToolbarOffset, { passive: true });
  if (typeof ResizeObserver !== "undefined" && header) {
    new ResizeObserver(syncToolbarOffset).observe(header);
  }

  const addBtn = document.getElementById("btn-add-widget");
  const arrangeBtn = document.getElementById("btn-auto-arrange");
  const resetBtn = document.getElementById("btn-reset");
  const exportBtn = document.getElementById("btn-export");
  const importBtn = document.getElementById("btn-import");
  const overlay = document.getElementById("palette");
  const closeBtn = document.getElementById("palette-close");
  const search = document.getElementById("palette-search") as HTMLInputElement | null;

  search?.addEventListener("input", () => renderPalette(search.value));
  search?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      togglePalette(false);
    }
  });

  addBtn?.addEventListener("click", () => togglePalette(true));
  const menuToggle = document.getElementById("dash-menu-toggle");
  const menuItems = document.getElementById("dash-menu-items");
  const toggleMenu = (show: boolean): void => {
    if (!menuItems || !menuToggle) return;
    menuItems.hidden = !show;
    menuToggle.setAttribute("aria-expanded", show ? "true" : "false");
  };
  menuToggle?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleMenu(menuItems?.hidden ?? false);
  });
  menuItems?.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("button")) toggleMenu(false);
  });
  document.addEventListener("pointerdown", (ev) => {
    if (!menuItems?.hidden && !(ev.target as HTMLElement).closest("#dash-menu")) toggleMenu(false);
  });
  arrangeBtn?.addEventListener("click", autoArrange);
  resetBtn?.addEventListener("click", () => {
    if (confirm("Reset the dashboard to the default layout?")) resetLayout();
  });
  exportBtn?.addEventListener("click", exportLayout);
  const importInput = document.createElement("input");
  importInput.type = "file";
  importInput.accept = "application/json,.json";
  importInput.hidden = true;
  document.body.appendChild(importInput);
  importBtn?.addEventListener("click", () => importInput.click());
  importInput.addEventListener("change", () => {
    const f = importInput.files?.[0];
    if (f) importLayoutFile(f);
    importInput.value = "";
  });
  overlay?.addEventListener("click", (ev) => {
    if (ev.target === overlay) togglePalette(false);
  });
  closeBtn?.addEventListener("click", () => togglePalette(false));
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      togglePalette(false);
      toggleMenu(false);
    }
  });

  // settings popovers: dismiss on outside click / Escape, follow layout changes
  const closeAllPopovers = (): void => {
    for (const w of widgets) {
      const el = canvas?.querySelector<HTMLElement>(`[data-id="${w.id}"]`);
      if (el && popoverOf(w)) closeSettings(w, el);
    }
  };
  document.addEventListener("pointerdown", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest(".w-settings") || t.closest(".w-btn[data-act=filters]") || t.closest(".w-btn[data-act=panel]")) return;
    closeAllPopovers();
  });
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeAllPopovers();
  });
  const repositionPopovers = (): void => {
    for (const w of widgets) {
      const el = canvas?.querySelector<HTMLElement>(`[data-id="${w.id}"]`);
      const panel = popoverOf(w);
      if (el && panel && !panel.hidden) placePopover(el, panel);
    }
  };
  window.addEventListener("resize", repositionPopovers);
  window.addEventListener("scroll", repositionPopovers, true);

  let raf = 0;
  let lastWidth = canvas.clientWidth;
  const onViewportChange = (): void => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (!canvas || canvas.clientWidth === lastWidth) return;
      lastWidth = canvas.clientWidth;
      measure();
      layout();
    });
  };
  window.addEventListener("resize", onViewportChange);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(onViewportChange).observe(canvas);

  setInterval(() => {
    void refreshSummary().then(renderStats);
    for (const w of widgets) {
      const kind = byKey.get(w.key)?.kind;
      if (kind === "rank" || kind === "list") void mountTable(w);
    }
  }, 60_000);
}
