// Shared column-sorting spec for server-rendered pages and the JSON APIs that
// dashboard widgets fetch from. Sorting always runs in SQL over the full
// dataset; whitelists keep user input out of ORDER BY.

export interface SortCol {
  sql: string;
  def: "asc" | "desc";
}

type QueryFn = (name: string) => string | undefined;

// Resolves ?sort/&dir against a whitelist and builds the ORDER BY clause with a
// stable tiebreak so pagination stays consistent. The tiebreak follows the sort
// direction (unless it carries its own), so a single composite index
// `(sortCol, tiebreak)` serves both ASC and DESC via forward/reverse scans.
export function parseSort(query: QueryFn, cols: Record<string, SortCol>, defKey: string, tiebreak: string): { order: string; key: string; dir: "asc" | "desc" } {
  const reqKey = query("sort") ?? "";
  const key = cols[reqKey] ? reqKey : defKey;
  const dir: "asc" | "desc" = query("dir") === "asc" || query("dir") === "desc" ? (query("dir") as "asc" | "desc") : cols[key].def;
  const tb = tiebreak.replace(/\s+(?:ASC|DESC)\s*$/i, "").trim();
  const hasDir = /\s+(?:ASC|DESC)\s*$/i.test(tiebreak);
  const tie = tb && tb !== cols[key].sql ? `, ${hasDir ? tiebreak : `${tb} ${dir.toUpperCase()}`}` : "";
  const order = `${cols[key].sql} ${dir.toUpperCase()}${tie}`;
  return { order, key, dir };
}

// Page-level wrapper: renders sortable header links (th) plus URL helpers.
// ?sort/&dir are dropped from URLs while the view is at its default.
export function srvSort(
  query: QueryFn,
  cols: Record<string, SortCol>,
  defKey: string,
  tiebreak: string,
  url: (sortPart: string) => string,
) {
  const { order, key, dir } = parseSort(query, cols, defKey, tiebreak);
  const qs = key === defKey && dir === cols[defKey].def ? "" : `sort=${key}&dir=${dir}`;
  const link = (k: string, d: "asc" | "desc"): string => url(k === defKey && d === cols[defKey].def ? "" : `sort=${k}&dir=${d}`);
  const th = (k: string, label: string, num = false): string => {
    const active = k === key;
    const d = active ? (dir === "asc" ? "desc" : "asc") : cols[k].def;
    return `<th class="sortable${num ? " num" : ""}"${active ? ` data-dir="${dir}" aria-sort="${dir === "asc" ? "ascending" : "descending"}"` : ""}><a href="${link(k, d)}" title="Sort by ${label}">${label}</a></th>`;
  };
  return { order, key, dir, qs, link, th };
}

// ---------- whitelists ----------
// Keys here are the public ?sort= values shared by pages, APIs and the
// dashboard widget headers.

export const BLOCK_COLS: Record<string, SortCol> = {
  topo: { sql: "topoheight", def: "desc" },
  hash: { sql: "hash", def: "asc" },
  time: { sql: "ts", def: "desc" },
  txs: { sql: "tx_count", def: "desc" },
  difficulty: { sql: "difficulty", def: "desc" },
  reward: { sql: "miner_reward", def: "desc" },
  type: { sql: "block_type", def: "asc" },
};

export const TX_COLS: Record<string, SortCol> = {
  block: { sql: "block_topo", def: "desc" },
  time: { sql: "ts", def: "desc" },
  type: { sql: "tx_type", def: "asc" },
  sender: { sql: "sender", def: "asc" },
  transfers: { sql: "transfer_count", def: "desc" },
  fee: { sql: "fee", def: "desc" },
  executed: { sql: "executed", def: "asc" },
};

export const ACCT_COLS: Record<string, SortCol> = {
  address: { sql: "address", def: "asc" },
  first: { sql: "first_seen", def: "asc" },
  last: { sql: "last_active", def: "desc" },
  txs: { sql: "tx_count", def: "desc" },
};

// /api/top rankings; ORDER BY aliases must match each ranking query
export const TOP_COLS: Record<string, Record<string, SortCol>> = {
  miners: {
    blocks: { sql: "blocks", def: "desc" },
    normal: { sql: "normal", def: "desc" },
    sync: { sql: "sync", def: "desc" },
    side: { sql: "side", def: "desc" },
    rewards: { sql: "rewards", def: "desc" },
    address: { sql: "address", def: "asc" },
  },
  senders: {
    txs: { sql: "tx_count", def: "desc" },
    outputs: { sql: "transfer_outputs", def: "desc" },
    address: { sql: "address", def: "asc" },
  },
  burners: {
    burned: { sql: "burned", def: "desc" },
    address: { sql: "address", def: "asc" },
  },
  assets: {
    txs: { sql: "tx_count", def: "desc" },
    transfers: { sql: "transfers", def: "desc" },
    asset: { sql: "da.asset_id", def: "asc" },
  },
  contracts: {
    invokes: { sql: "invokes", def: "desc" },
    gas: { sql: "gas", def: "desc" },
    contract: { sql: "contract_id", def: "asc" },
  },
};

export const TOP_DEFAULT: Record<string, string> = {
  miners: "blocks",
  senders: "txs",
  burners: "burned",
  assets: "txs",
  contracts: "invokes",
};

export const TOP_TIEBREAK: Record<string, string> = {
  miners: "address",
  senders: "address",
  burners: "address",
  assets: "da.asset_id",
  contracts: "contract_id",
};
