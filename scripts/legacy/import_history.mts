/**
 * Import legacy Postgres market + chain-size history into D1 SQL files.
 *
 * Source CSVs (produced once from the old cluster via COPY, see README) are
 * transformed into the current D1 schema and written next to the other export
 * artifacts for `wrangler d1 execute --file`.
 *
 *   scripts/legacy/import_history.mts --tickers=<csv> --chain-size=<csv> [--out=export]
 *
 * market_tickers  -> market_snapshots   (seconds -> ms, venue names canonical,
 *                                        price->last, volume->base_volume,
 *                                        quote_volume = price * volume)
 * blockchain_size -> chain_size_snapshots (seconds -> ms, bytes)
 * both            -> exchanges           (name/status/url/added/retired)
 *
 * Remote import:
 *   npx wrangler d1 execute xelis-stats --file export/exchanges.sql --remote
 *   npx wrangler d1 execute xelis-stats --file export/market_snapshots.sql --remote
 *   npx wrangler d1 execute xelis-stats --file export/chain_size_snapshots.sql --remote
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (name: string): string | undefined =>
  process.argv.find((a: string) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

const TICKERS_CSV = arg("tickers") ?? process.env.OLD_TICKERS_CSV ?? "";
const CHAIN_SIZE_CSV = arg("chain-size") ?? process.env.OLD_CHAIN_SIZE_CSV ?? "";
const OUT_DIR = arg("out") ?? process.env.EXPORT_DIR ?? "export";
const QUOTE = "USDT";
const MARKET = `XEL/${QUOTE}`;

// canonical display name + lifecycle metadata, keyed by the legacy (lowercase)
// venue id. Lives in the registry so the charts page can order/label venues and
// mark retired feeds; mirrors config/addresses.json links.
const VENUES: Record<string, { name: string; status: string; url: string }> = {
  mexc: { name: "MEXC", status: "active", url: "https://www.mexc.com/" },
  coinex: { name: "CoinEx", status: "active", url: "https://www.coinex.com" },
  nonkyc: { name: "NonKyc", status: "active", url: "https://nonkyc.io/" },
  tradeogre: { name: "TradeOgre", status: "inactive", url: "https://tradeogre.com/" },
  exbitron: { name: "Exbitron", status: "inactive", url: "https://exbitron.com/" },
  xeggex: { name: "XeggeX", status: "inactive", url: "https://xeggex.com/" },
  xt: { name: "XT", status: "inactive", url: "https://www.xt.com/" },
  biconomy: { name: "Biconomy", status: "inactive", url: "https://biconomy.com/" },
  mecacex: { name: "MecaCex", status: "inactive", url: "https://mecacex.com/" },
};

function venue(id: string): { name: string; status: string; url: string } {
  return VENUES[id.toLowerCase()] ?? { name: id, status: "inactive", url: "" };
}

function esc(v: string | null): string {
  if (v === null || v === "") return "NULL";
  // all numeric source columns; keep raw text so no float rounding is introduced
  return /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

// legacy market_tickers has no quote volume; derive it from price * base volume
// so the quote-volume history series has data before live cron collection began.
function quoteVolume(price: string, volume: string): string {
  if (price === "" || volume === "") return "NULL";
  const p = Number(price);
  const v = Number(volume);
  if (!Number.isFinite(p) || !Number.isFinite(v)) return "NULL";
  // trim binary floating-point noise (e.g. 1851.8249999999998 -> 1851.825)
  return String(Number((p * v).toPrecision(12)));
}

// Minimal RFC-4180 parser: handles quoted fields, escaped quotes ("") and
// newlines inside quotes, which the legacy COPY output can contain.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.length > 0));
}

function readCsv(path: string, required: string[]): { header: string[]; rows: string[][] } {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const table = parseCsv(text);
  if (!table.length) throw new Error(`${path}: empty CSV`);
  const header = table[0].map((h) => h.trim());
  const missing = required.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`${path}: missing column(s) ${missing.join(", ")} (found: ${header.join(", ")})`);
  }
  return { header, rows: table.slice(1) };
}

mkdirSync(OUT_DIR, { recursive: true });
function fresh(file: string): void {
  try { unlinkSync(file); } catch { /* not there */ }
}
// publish the .tmp artifact only on success so an interrupted run never leaves
// a truncated file that looks like a complete export
function publish(tmp: string, file: string): void {
  if (existsSync(tmp)) renameSync(tmp, file);
  else fresh(file);
}
function writer(file: string, table: string, cols: string[]): { add: (row: string[]) => void; done: () => void } {
  const tmp = `${file}.tmp`;
  fresh(tmp);
  let buffer: string[] = [];
  const flush = (): void => {
    if (!buffer.length) return;
    writeFileSync(tmp, `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES\n${buffer.join(",\n")};\n`, { flag: "a" });
    buffer = [];
  };
  return {
    add: (row: string[]) => {
      buffer.push(`(${row.join(",")})`);
      if (buffer.length >= 100) flush();
    },
    done: () => { flush(); publish(tmp, file); },
  };
}
function report(name: string, count: number): void {
  const file = join(OUT_DIR, `${name}.sql`);
  if (!existsSync(file)) { console.log(`  ${name}: ${count.toLocaleString()} rows (no file written)`); return; }
  const size = statSync(file).size / 1e6;
  console.log(`  ${name}: ${count.toLocaleString()} rows (${size.toFixed(1)} MB)`);
}

const bounds = new Map<string, { min: number; max: number }>();
let tickerCount = 0;

if (TICKERS_CSV) {
  console.log(`Importing market tickers from ${TICKERS_CSV}…`);
  const { header, rows } = readCsv(TICKERS_CSV, ["exchange", "timestamp", "price", "volume"]);
  const col = (r: string[], n: string): string => r[header.indexOf(n)] ?? "";
  const write = writer(join(OUT_DIR, "market_snapshots.sql"), "market_snapshots",
    ["ts", "exchange", "market", "last", "high", "low", "base_volume", "quote_volume", "source_ts"]);
  for (const r of rows) {
    const id = col(r, "exchange");
    if (!id) continue;
    const ts = Number(col(r, "timestamp")) * 1000;
    if (!Number.isFinite(ts)) continue;
    const v = venue(id);
    const market = `XEL/${col(r, "asset") || QUOTE}`;
    const price = col(r, "price");
    const volume = col(r, "volume");
    const b = bounds.get(v.name) ?? { min: ts, max: ts };
    b.min = Math.min(b.min, ts); b.max = Math.max(b.max, ts);
    bounds.set(v.name, b);
    write.add([String(ts), esc(v.name), esc(market), esc(price), esc(col(r, "high")),
      esc(col(r, "low")), esc(volume), quoteVolume(price, volume), String(ts)]);
    tickerCount++;
  }
  write.done();
  report("market_snapshots", tickerCount);
} else {
  console.log("  market_snapshots: skipped (no --tickers)");
}

if (CHAIN_SIZE_CSV) {
  console.log(`Importing chain size from ${CHAIN_SIZE_CSV}…`);
  const { header, rows } = readCsv(CHAIN_SIZE_CSV, ["timestamp", "size_in_bytes"]);
  const col = (r: string[], n: string): string => r[header.indexOf(n)] ?? "";
  const write = writer(join(OUT_DIR, "chain_size_snapshots.sql"), "chain_size_snapshots", ["ts", "size_bytes"]);
  let n = 0;
  for (const r of rows) {
    const ts = Number(col(r, "timestamp")) * 1000;
    const size = Number(col(r, "size_in_bytes"));
    if (!Number.isFinite(ts) || !Number.isFinite(size)) continue;
    write.add([String(ts), String(size)]);
    n++;
  }
  write.done();
  report("chain_size_snapshots", n);
} else {
  console.log("  chain_size_snapshots: skipped (no --chain-size)");
}

// exchanges registry: metadata for every venue we know, bounded by imported data
{
  const write = writer(join(OUT_DIR, "exchanges.sql"), "exchanges",
    ["name", "status", "url", "added_ts", "retired_ts", "notes"]);
  const ids = new Set<string>([...Object.keys(VENUES), ...[...bounds.keys()].map((n) => n.toLowerCase())]);
  let n = 0;
  for (const id of ids) {
    const v = venue(id);
    // bounds are keyed by canonical name
    const b = bounds.get(v.name);
    const active = v.status === "active";
    write.add([
      esc(v.name), esc(v.status), esc(v.url),
      b ? String(b.min) : "NULL",
      active || !b ? "NULL" : String(b.max),
      esc("seeded from legacy market history"),
    ]);
    n++;
  }
  write.done();
  report("exchanges", n);
}

console.log("\nDone. Import to D1 (after migrations):");
console.log("  npx wrangler d1 execute xelis-stats --file export/exchanges.sql --remote");
console.log("  npx wrangler d1 execute xelis-stats --file export/market_snapshots.sql --remote");
console.log("  npx wrangler d1 execute xelis-stats --file export/chain_size_snapshots.sql --remote");
