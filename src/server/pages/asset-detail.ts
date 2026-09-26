import { Hono } from "hono";
import type { Env } from "../app";
import { layout, notFound, statCard } from "../../client/layout";
import { icons } from "../../client/icons";
import { fmt, fmtInt, shortHash, fmtTime, atomic } from "../../client/format";
import { rpc, getInfo } from "../xelis";
import { parseMaxSupply, parseOwner, type AssetMaxSupply, type AssetOwner } from "../asset-registry";
import { srvSort, TX_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { esc, jsq, flaggedText, blkCopyScript, num, PAGE_SIZE, pager, clampInt, logErr } from "./shared";
import { topNRaw, countRaw, mergeAgg } from "../shards";

export const assetDetail = new Hono<{ Bindings: Env }>();

const XEL_ASSET_ID = "0".repeat(64);
const TX_TYPES = ["transfer", "burn", "invoke_contract", "deploy_contract", "multisig"];

// Contracts are the only holders we can enumerate (account balances are
// encrypted and there is no get_asset_holders RPC). Scan the most active
// indexed contracts and cache the result; the cap bounds the RPC fan-out.
const CONTRACT_SCAN_MAX = 100;
const CONTRACT_SCAN_CONCURRENCY = 10;
const HOLDINGS_CACHE_TTL = 600;

// Minimum matching transactions before the dense-asset (semi-join) query path
// is considered; below this the joined sort is already cheap and an extra
// total-count query would not pay for itself.
const SEMIJOIN_MIN = 5000;

interface Holding {
  contract: string;
  balance: number;
  topo: number | null;
}

/** Contracts that currently hold a positive balance of `assetId` (KV-cached). */
async function contractsHolding(env: Env, assetId: string): Promise<Holding[]> {
  const key = `asset:holdings:${assetId}`;
  try {
    const cached = await env.KV.get<Holding[]>(key, "json");
    if (cached) return cached;
  } catch { /* cache miss */ }

  const rows = await env.DB.prepare(
    "SELECT contract_id FROM contracts ORDER BY invoke_count DESC LIMIT ?"
  ).bind(CONTRACT_SCAN_MAX).all<{ contract_id: string }>();
  const ids = (rows.results ?? []).map((r) => r.contract_id).filter(Boolean);

  const out: Holding[] = [];
  for (let i = 0; i < ids.length; i += CONTRACT_SCAN_CONCURRENCY) {
    const chunk = ids.slice(i, i + CONTRACT_SCAN_CONCURRENCY);
    const results = await Promise.all(chunk.map(async (cid): Promise<Holding | null> => {
      try {
        const b = await rpc<{ data?: number; topoheight?: number }>(
          "get_contract_balance", { contract: cid, asset: assetId }, env.XELIS_NODE
        );
        const v = Number(b?.data);
        return Number.isFinite(v) && v > 0 ? { contract: cid, balance: v, topo: num(b.topoheight) || null } : null;
      } catch {
        return null; // asset not held by this contract (or node hiccup)
      }
    }));
    for (const h of results) if (h) out.push(h);
  }
  out.sort((a, b) => b.balance - a.balance);
  try { await env.KV.put(key, JSON.stringify(out), { expirationTtl: HOLDINGS_CACHE_TTL }); } catch { /* best effort */ }
  return out;
}

interface NodeAsset {
  name?: string | null;
  ticker?: string | null;
  decimals?: number | null;
  topoheight?: number | null;
  max_supply?: unknown;
  owner?: unknown;
}

assetDetail.get("/asset/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const isXel = id === XEL_ASSET_ID;
  const page = clampInt(c.req.query("page"), 1, 100_000);
  const rawType = c.req.query("type") ?? "";
  const type = TX_TYPES.includes(rawType) ? rawType : "";
  const srt = srvSort((n) => c.req.query(n), TX_COLS, "block", "hash", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/asset/${esc(id)}?${q}` : `/asset/${esc(id)}`;
  });

  let asset: Record<string, unknown> | undefined;
  try {
    asset = (await db.prepare("SELECT * FROM assets WHERE asset_id = ?").bind(id).first()) ?? undefined;
  } catch (err) { logErr("page/asset", err); }

  let nodeAsset: NodeAsset | null = null;
  try {
    nodeAsset = await rpc<NodeAsset>("get_asset", { asset: id }, c.env.XELIS_NODE);
  } catch { /* node unreachable or unknown asset */ }

  if (!asset && !nodeAsset) return c.html(layout("Not found", notFound("Asset"), "/assets"));

  const name = String(asset?.name ?? nodeAsset?.name ?? "");
  const symbol = String(asset?.symbol ?? nodeAsset?.ticker ?? "");
  const decimals = num(asset?.decimals) || num(nodeAsset?.decimals) || 8;
  const firstTopo = num(asset?.first_seen_topo) || num(nodeAsset?.topoheight) || 0;
  const unit = 10 ** decimals;
  const amount = (v: number | null | undefined): string => (v == null || !Number.isFinite(v) ? "—" : fmt(v / unit, 2));
  const label = symbol ? flaggedText(symbol) : esc(shortHash(id, 8));

  // max supply + owner: stored registry metadata first, live node fallback
  const max: AssetMaxSupply = asset?.max_supply_kind
    ? { kind: String(asset.max_supply_kind) as AssetMaxSupply["kind"], value: asset.max_supply != null ? num(asset.max_supply) : null }
    : parseMaxSupply(nodeAsset?.max_supply);
  const owner: AssetOwner = asset?.owner_contract
    ? { contract: String(asset.owner_contract), assetId: asset.owner_asset_id != null ? num(asset.owner_asset_id) : null }
    : parseOwner(nodeAsset?.owner);

  // current supply: native XEL reads circulating supply from get_info, tokens
  // use get_asset_supply (current minted amount)
  let supply: number | null = null;
  let supplySource = "";
  try {
    if (isXel) {
      const info = await getInfo(c.env.XELIS_NODE);
      supply = num(info.circulating_supply);
      supplySource = "network circulating";
    } else {
      const s = await rpc<{ data?: number }>("get_asset_supply", { asset: id }, c.env.XELIS_NODE);
      supply = Number.isFinite(Number(s?.data)) ? Number(s.data) : null;
      supplySource = "on-chain minted";
    }
  } catch { /* fall back to the last snapshot below */ }

  // supply history (hourly snapshots, reduced to the last value per day)
  let supplyRows: Record<string, unknown>[] = [];
  try {
    supplyRows = await db.prepare(
      "SELECT ts, supply FROM asset_supply_snapshots WHERE asset_id = ? ORDER BY ts ASC LIMIT 5000"
    ).bind(id).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* no snapshots yet */ }
  const supplyByDay = new Map<string, number>();
  for (const r of supplyRows) {
    const d = new Date(num(r.ts)).toISOString().slice(0, 10);
    supplyByDay.set(d, num(r.supply));
  }
  const supplySeries = [...supplyByDay.entries()].map(([date, v]) => ({ date, value: v / unit }));
  if (supply === null && supplySeries.length) {
    supply = supplyByDay.get([...supplyByDay.keys()].pop() as string) ?? null;
    supplySource = "last snapshot";
  }

  // per-day activity rollup
  let activityRows: Record<string, unknown>[] = [];
  try {
    activityRows = await db.prepare(
      `SELECT date, tx_count, transfer_count FROM daily_assets
       WHERE asset_id = ? AND date > date('now','-180 days') ORDER BY date ASC`
    ).bind(id).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* not ready */ }
  const txsSeries = activityRows.map((r) => ({ date: String(r.date ?? ""), value: num(r.tx_count) }));
  const transfersSeries = activityRows.map((r) => ({ date: String(r.date ?? ""), value: num(r.transfer_count) }));

  // transactions involving the asset (tx_assets join tx_index, across shards)
  const conds = ["a.asset = ?"];
  const binds: unknown[] = [id];
  if (type) { conds.push("t.tx_type = ?"); binds.push(type); }
  const extra = { sql: conds.join(" AND "), binds };
  let histTotal = 0;
  let txs: Record<string, unknown>[] = [];
  try {
    histTotal = await countRaw(c.env, {
      table: "tx_index t JOIN tx_assets a ON a.tx_hash = t.hash",
      extra,
      floorCol: "t.block_topo",
    });

    // The native XEL asset is in nearly every transaction, so the join makes
    // SQLite materialise and sort the whole match set (700k+ rows) before the
    // LIMIT applies. Driving the scan from tx_index's (sortCol, hash) index and
    // probing tx_assets by primary key lets it stop once the page is filled.
    // Only switch when that probe count beats sorting the matching set; sparse
    // assets keep the join. A type filter cannot use the ordered sort indexes,
    // so it also stays on the join.
    const skip = (page - 1) * PAGE_SIZE;
    let semi = false;
    if (!type && histTotal >= SEMIJOIN_MIN) {
      const totalTxs = await countRaw(c.env, { table: "tx_index", floorCol: "block_topo" });
      semi = totalTxs > 0 && totalTxs * (skip + PAGE_SIZE) < histTotal * histTotal;
    }
    txs = await topNRaw(c.env, {
      table: semi ? "tx_index t" : "tx_index t JOIN tx_assets a ON a.tx_hash = t.hash",
      select: "t.hash, t.block_topo, t.ts, t.tx_type, t.sender, t.fee, t.transfer_count",
      order: srt.order,
      limit: PAGE_SIZE,
      skip,
      extra: semi
        ? { sql: "EXISTS (SELECT 1 FROM tx_assets a WHERE a.tx_hash = t.hash AND a.asset = ?)", binds: [id] }
        : extra,
      floorCol: "t.block_topo",
    });
  } catch (err) { logErr("page/asset", err); }

  // publicly burned amount of this asset
  let burnedTotal = 0;
  let burnedCount = 0;
  try {
    const b = await mergeAgg(c.env,
      "SELECT SUM(burn_amount) sb, COUNT(*) c FROM tx_index WHERE burn_asset = ?",
      [id], { sum: ["sb", "c"] });
    burnedTotal = num(b.sb);
    burnedCount = num(b.c);
  } catch { /* not ready */ }

  // creator contract + sibling assets
  let creator: Record<string, unknown> | undefined;
  let related: Record<string, unknown>[] = [];
  if (owner.contract) {
    try {
      creator = (await db.prepare(
        "SELECT deployer, deploy_topo, invoke_count, gas_total FROM contracts WHERE contract_id = ?"
      ).bind(owner.contract).first()) ?? undefined;
      related = await db.prepare(
        `SELECT asset_id, name, symbol, first_seen_topo FROM assets
         WHERE owner_contract = ? AND asset_id != ? ORDER BY first_seen_topo DESC LIMIT 24`
      ).bind(owner.contract, id).all<Record<string, unknown>>().then((r) => r.results ?? []);
    } catch { /* not ready */ }
  }

  // contracts holding the asset (best effort, cached)
  let holdings: Holding[] = [];
  try { holdings = await contractsHolding(c.env, id); } catch { /* none */ }
  const heldSum = holdings.reduce((a, h) => a + h.balance, 0);

  const maxLabel = max.kind === "none"
    ? "Unlimited"
    : amount(max.value);
  const maxSub = max.kind === "fixed" ? "fixed cap" : max.kind === "mintable" ? "mintable cap" : "no maximum supply";

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Asset <span class="mint" style="font-size:0.72em">${label}</span>${name ? ` <span style="color:var(--text-dim);font-size:0.6em">${flaggedText(name)}</span>` : ""}</h2>
        <div class="blk-meta">
          ${isXel ? '<span class="badge">native</span>' : ""}
          ${max.kind === "fixed" ? '<span class="badge">fixed supply</span>' : max.kind === "mintable" ? '<span class="badge">mintable</span>' : '<span class="badge">no max supply</span>'}
          ${owner.contract ? `<span class="badge">owned</span>` : ""}
          ${firstTopo > 0 ? `<span class="blk-when">created at block #${fmtInt(firstTopo)}</span>` : ""}
        </div>
        <div class="hash-row">
          <span class="hashline mono">${esc(id)}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${jsq(id)}', this)">copy</button>
        </div>
      </div>
      <div class="blk-nav">
        ${owner.contract ? `<a class="btn ghost" href="/contracts/${esc(owner.contract)}" title="Creator contract">Contract ${icons.chevronRight}</a>` : ""}
        <a class="btn ghost" href="/assets" title="All indexed assets">Assets ${icons.chevronRight}</a>
      </div>
    </div>
    <div class="cards blk-cards">
      ${statCard("Supply", amount(supply), supplySource || "minted so far")}
      ${statCard("Max Supply", maxLabel, maxSub)}
      ${statCard("Transactions", histTotal > 0 ? fmtInt(histTotal) : "—", "indexed involvement")}
      ${statCard("Burned", burnedCount > 0 ? amount(burnedTotal) : "—", burnedCount > 0 ? `${fmtInt(burnedCount)} public burn tx` : "no public burns")}
      ${statCard("Contracts Holding", holdings.length > 0 ? fmtInt(holdings.length) : "—", holdings.length > 0 ? `${amount(heldSum)} observed` : "none observed")}
    </div>
  </div>`;

  const ownerValue = owner.contract
    ? `<a class="mono" href="/contracts/${esc(owner.contract)}">${esc(shortHash(owner.contract, 10))}</a>${owner.assetId != null ? ` <span style="color:var(--text-dim)">asset #${fmtInt(owner.assetId)}</span>` : ""} <button class="copybtn" type="button" onclick="blkCopy('${jsq(owner.contract)}', this)">copy</button>`
    : '<span style="color:var(--text-dim)">unowned</span>';

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Asset ID</td><td><span class="mono">${esc(id)}</span> <button class="copybtn" type="button" onclick="blkCopy('${jsq(id)}', this)">copy</button></td></tr>
    <tr><td>Name</td><td>${name ? flaggedText(name) : "—"}</td></tr>
    <tr><td>Symbol</td><td>${symbol ? flaggedText(symbol) : "—"}</td></tr>
    <tr><td>Decimals</td><td>${fmtInt(decimals)}</td></tr>
    ${firstTopo > 0 ? `<tr><td>Created at</td><td><a href="/block/${firstTopo}"><span class="mint">#${fmtInt(firstTopo)}</span></a></td></tr>` : ""}
    <tr><td>Max supply</td><td>${maxLabel}${max.kind !== "none" ? ` <span style="color:var(--text-dim)">(${maxSub})</span>` : ""}</td></tr>
    <tr><td>Supply</td><td>${amount(supply)} <span style="color:var(--text-dim)">${supplySource ? `· ${supplySource}` : ""}</span></td></tr>
    <tr><td>Owner</td><td>${ownerValue}</td></tr>
  </table></div>`;

  const hasActivity = txsSeries.some((p) => p.value > 0) || transfersSeries.some((p) => p.value > 0);
  const activity = hasActivity
    ? `<div class="grid-2">
      <div class="panel"><h2>Transactions <span style="color:var(--text-dim)">per day · 180d</span></h2><div id="u-asset-txs" class="chart" style="min-height:260px"></div></div>
      <div class="panel"><h2>Transfers <span style="color:var(--text-dim)">per day · 180d</span></h2><div id="u-asset-transfers" class="chart" style="min-height:260px"></div></div>
    </div>`
    : `<div class="panel"><h2>Activity</h2><p style="color:var(--text-dim)">No daily activity recorded for this asset yet.</p></div>`;

  const supplyPanel = supplySeries.length >= 2
    ? `<div class="panel"><h2>Supply <span style="color:var(--text-dim)">recorded hourly · 180d</span></h2><div id="u-asset-supply" class="chart" style="min-height:260px"></div></div>`
    : "";

  const fActive = !!type;
  const fFields = `
    ${filterField("Transaction type", `<select name="type">${selectOpts(TX_TYPES, type, "all types")}</select>`)}
  `;
  const fPop = filterPop("f-asset-txs", `/asset/${esc(id)}`, fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/asset/${esc(id)}${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const txRows = txs.length
    ? txs.map((t) => {
        const hash = String(t.hash ?? "");
        return `<tr>
          <td><a class="mono" href="/tx/${esc(hash)}">${esc(shortHash(hash, 10))}</a></td>
          <td><a href="/block/${num(t.block_topo)}"><span class="mint">${fmtInt(num(t.block_topo))}</span></a></td>
          <td>${fmtTime(num(t.ts))}</td>
          <td><span class="badge ${esc(t.tx_type ?? "other")}">${esc(t.tx_type ?? "other")}</span></td>
          <td><a class="mono" href="/account/${esc(t.sender as string)}">${esc(shortHash(t.sender as string, 8))}</a></td>
          <td class="num">${fmtInt(num(t.transfer_count))}</td>
          <td class="num">${atomic(num(t.fee), 6)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">${histTotal > 0 ? "No transactions match the current filters." : "No indexed transactions involving this asset yet."}</td></tr>`;

  const totalPages = Math.max(1, Math.ceil(histTotal / PAGE_SIZE));
  const txsPanel = `<div class="panel">
    <div class="panel-head">
      <h2>Transactions <span style="color:var(--text-dim)">${fmtInt(histTotal)} involving this asset</span></h2>
      ${filterButton("f-asset-txs", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th>Hash</th>${srt.th("block", "Block")}${srt.th("time", "Time")}${srt.th("type", "Type")}${srt.th("sender", "Sender")}${srt.th("transfers", "Transfers", true)}${srt.th("fee", "Fee (XEL)", true)}</tr></thead>
      <tbody>${txRows}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;

  const holdingRows = holdings.length
    ? holdings.map((h) => `<tr>
        <td><a class="mono" href="/contracts/${esc(h.contract)}">${esc(shortHash(h.contract, 12))}</a></td>
        <td class="num">${amount(h.balance)}</td>
        <td class="num">${h.topo ? `<a href="/block/${h.topo}">${fmtInt(h.topo)}</a>` : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="3" style="color:var(--text-dim)">No indexed contract holds this asset (or none checked so far).</td></tr>`;
  const holdingsPanel = `<div class="panel"><h2>Contracts Holding</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Contract</th><th class="num">Balance</th><th class="num">Updated (topo)</th></tr></thead>
      <tbody>${holdingRows}</tbody>
    </table></div>
    <p style="color:var(--text-dim);font-size:1.1rem;margin-top:0.8rem">Only contracts indexed by this explorer are checked, and account balances are encrypted — this is not a full holder distribution.</p>
  </div>`;

  const creatorPanel = owner.contract
    ? `<div class="panel"><h2>Creator</h2>
      <table class="kv">
        <tr><td>Creator contract</td><td><a class="mono" href="/contracts/${esc(owner.contract)}">${esc(shortHash(owner.contract, 12))}</a> <button class="copybtn" type="button" onclick="blkCopy('${jsq(owner.contract)}', this)">copy</button></td></tr>
        ${creator?.deployer ? `<tr><td>Deployer</td><td><a class="mono" href="/account/${esc(creator.deployer as string)}">${esc(shortHash(creator.deployer as string, 10))}</a></td></tr>` : ""}
        ${num(creator?.deploy_topo) ? `<tr><td>Contract deployed</td><td><a href="/block/${num(creator?.deploy_topo)}">#${fmtInt(num(creator?.deploy_topo))}</a></td></tr>` : ""}
        ${num(creator?.invoke_count) ? `<tr><td>Contract invokes</td><td><a href="/contracts/${esc(owner.contract)}">${fmtInt(num(creator?.invoke_count))} indexed</a></td></tr>` : ""}
        ${owner.assetId != null ? `<tr><td>Asset index</td><td>#${fmtInt(owner.assetId)}</td></tr>` : ""}
      </table>
    </div>`
    : "";

  const relatedPanel = related.length
    ? `<div class="panel"><h2>Related Assets <span style="color:var(--text-dim)">${fmtInt(related.length)}</span></h2>
      <div class="tablewrap"><table>
        <thead><tr><th>Asset</th><th>Symbol</th><th class="num">Created (topo)</th></tr></thead>
        <tbody>${related.map((r) => `<tr>
          <td><a class="mono" href="/asset/${esc(r.asset_id as string)}">${esc(shortHash(r.asset_id as string, 10))}</a></td>
          <td>${r.symbol ? flaggedText(r.symbol) : "—"}</td>
          <td class="num">${num(r.first_seen_topo) ? `<a href="/block/${num(r.first_seen_topo)}">${fmtInt(num(r.first_seen_topo))}</a>` : "—"}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`
    : "";

  const seriesJson = JSON.stringify({ txs: txsSeries, transfers: transfersSeries, supply: supplySeries }).replace(/</g, "\\u003c");
  const content = `${hero}
    <div class="grid-2">${overview}${creatorPanel || ownershipNote()}</div>
    ${relatedPanel}
    ${activity}
    ${supplyPanel}
    ${txsPanel}
    ${holdingsPanel}
    <div class="tx-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Asset metadata, supply and owner are public on Xelis. Transfer amounts and account balances are encrypted, so per-holder distribution cannot be derived; only contract-held balances are observable.</span>
    </div>
    <script>${blkCopyScript}</script>
    <script type="application/json" id="asset-series">${seriesJson}</script>`;
  return c.html(layout(`Asset ${esc(shortHash(id, 8))}`, content, "/assets"));
});

// placeholder so the overview/related grid stays balanced when there is no owner
function ownershipNote(): string {
  return `<div class="panel"><h2>Ownership</h2><p style="color:var(--text-dim)">This asset has no creator contract recorded — it was likely minted natively at genesis or its registry owner is unset.</p></div>`;
}
