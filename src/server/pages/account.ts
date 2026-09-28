import { Hono } from "hono";
import type { Env } from "../app";
import { layout, statCard } from "../../client/layout";
import { icons } from "../../client/icons";
import { fmtInt, shortHash, fmtTime, ago, atomic, timeCell } from "../../client/format";
import { knownEntity } from "../entities";
import { rpc } from "../xelis";
import { srvSort, TX_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { PAGE_SIZE, pager, esc, jsq, clampInt, logErr, blkCopyScript, flaggedText, num } from "./shared";
import { topNRaw, countRaw, mergeAgg, mergeGroups, fetchBlockTimes } from "../shards";

export const account = new Hono<{ Bindings: Env }>();

const XEL_ASSET_ID = "0".repeat(64);
// The daemon caps `get_account_assets` at 64 assets per call.
const ACCOUNT_ASSETS_MAX = 64;

account.get("/account/:address", async (c) => {
  const address = c.req.param("address");
  const db = c.env.DB;

  // history section: full sent-tx list with pagination, sorting and filters
  const page = clampInt(c.req.query("page"), 1, 100_000);
  const TX_TYPES = ["transfer", "burn", "invoke_contract", "deploy_contract", "multisig"];
  const rawType = c.req.query("type") ?? "";
  const type = TX_TYPES.includes(rawType) ? rawType : "";
  const executed = c.req.query("executed") === "1" || c.req.query("executed") === "0" ? c.req.query("executed")! : "";
  const srt = srvSort((nm) => c.req.query(nm), TX_COLS, "block", "hash", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (executed) p.set("executed", executed);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/account/${esc(address)}?${q}` : `/account/${esc(address)}`;
  });

  let acct: Record<string, unknown> | undefined;
  let txs: Record<string, unknown>[] = [];
  let histTotal = 0;
  let lastSendTopo = 0;
  let agg: Record<string, unknown> | null = null;
  let types: Record<string, unknown>[] = [];
  let minedAll = 0;
  let maxTopo: number | null = null;
  let contractRows: Record<string, unknown>[] = [];
  let accountAssets: string[] = [];
  try {
    const conds: string[] = ["sender = ?"];
    const binds: unknown[] = [address];
    if (type) { conds.push("tx_type = ?"); binds.push(type); }
    if (executed === "1") { conds.push("executed = 1"); }
    if (executed === "0") { conds.push("executed = 0"); }
    const histExtra = { sql: conds.join(" AND "), binds };
    // The per-address fact queries are independent, so run them concurrently.
    const [acctRow, histTotalN, txRows, aggRow, typeRows, minedAllRow, maxTopoRow, contractResult, assetResult] = await Promise.all([
      db.prepare("SELECT * FROM accounts WHERE address = ?").bind(address).first<Record<string, unknown>>(),
      // SUM(fee) instead of AVG(fee): averages are merged across shards in JS
      countRaw(c.env, { table: "tx_index", extra: histExtra, floorCol: "block_topo" }),
      topNRaw(c.env, {
        table: "tx_index",
        select: "*",
        order: srt.order,
        limit: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
        extra: histExtra,
        floorCol: "block_topo",
      }),
      // one scan for the global totals; MAX(block_topo) rides along so the
      // "last send" fact does not need its own pass over the sender index
      mergeAgg(c.env,
        `SELECT COUNT(*) c, SUM(fee) fees, MIN(ts) first_tx, MAX(ts) last_tx, MAX(block_topo) last_topo,
                SUM(encrypted) enc, SUM(CASE WHEN executed = 1 THEN 1 ELSE 0 END) ok
         FROM tx_index WHERE sender = ?`,
        [address], { sum: ["c", "fees", "enc", "ok"], min: "first_tx", max: ["last_tx", "last_topo"], floorCol: "block_topo" }),
      mergeGroups(c.env,
        "SELECT tx_type, COUNT(*) c FROM tx_index WHERE sender = ? GROUP BY tx_type",
        [address], "tx_type", ["c"], { floorCol: "block_topo" }),
      db.prepare("SELECT SUM(blocks_found) AS c FROM daily_miners WHERE address = ?").bind(address)
        .first<{ c: number | null }>(),
      db.prepare("SELECT MAX(topoheight) AS m FROM blocks").first<{ m: number | null }>(),
      // contracts this address deployed (hot-only table, indexed by deployer)
      db.prepare(
        `SELECT contract_id, deploy_topo, invoke_count, gas_total, COUNT(*) OVER() AS total
         FROM contracts WHERE deployer = ? ORDER BY invoke_count DESC, deploy_topo DESC LIMIT 100`
      ).bind(address).all<Record<string, unknown>>().then((r) => r.results ?? []),
      // assets with a registered (encrypted) balance for this account; the node
      // RPC is best-effort, so a failure must not drop the indexed results
      rpc<string[]>("get_account_assets", { address, skip: 0, maximum: ACCOUNT_ASSETS_MAX }, c.env.XELIS_NODE)
        .catch(() => [] as string[]),
    ]);
    acct = acctRow ?? undefined;
    histTotal = histTotalN;
    lastSendTopo = num(aggRow?.last_topo);
    txs = txRows;
    agg = aggRow;
    types = typeRows;
    types.sort((a, b) => num(b.c) - num(a.c));
    minedAll = Number(minedAllRow?.c) || 0;
    maxTopo = maxTopoRow?.m ?? null;
    contractRows = contractResult;
    accountAssets = Array.isArray(assetResult) ? assetResult : [];
  } catch (err) { logErr("page/account", err); }
  const histPages = Math.max(1, Math.ceil(histTotal / PAGE_SIZE));

  const txCount = num(acct?.tx_count) || num(agg?.c);
  const fees = num(agg?.fees);
  const avgFee = txCount > 0 ? fees / txCount : 0;
  const firstTx = num(agg?.first_tx);
  const lastTx = num(agg?.last_tx);
  const firstSeen = num(acct?.first_seen) || firstTx;
  const lastActive = num(acct?.last_active) || lastTx;
  const okCount = num(agg?.ok);
  const encCount = num(agg?.enc);
  const okPct = txCount > 0 ? (okCount / txCount) * 100 : null;
  const minedTotal = minedAll;

  const ent = knownEntity(address);
  const dbLabel = (acct?.label as string) ?? "";
  const entityBadge = ent
    ? `<span class="badge entity ${esc(ent.kind)}">${esc(ent.label)}</span>`
    : dbLabel ? `<span class="badge">${esc(dbLabel)}</span>` : "";
  const labelValue = ent
    ? `${esc(ent.label)} <span class="badge entity ${esc(ent.kind)}">${esc(ent.kind)}</span>${ent.link ? ` · <a href="${esc(ent.link)}" target="_blank" rel="noopener noreferrer">website</a>` : ""}`
    : dbLabel || '<span style="color:var(--text-dim)">—</span>';

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Account <span class="mint mono" style="font-size:0.72em">${esc(shortHash(address, 10))}</span></h2>
        <div class="blk-meta">
          ${entityBadge}
          ${txCount > 0 ? `<span class="badge">${fmtInt(txCount)} sent tx${txCount === 1 ? "" : "s"}</span>` : '<span class="badge">no observed activity</span>'}
          ${minedTotal > 0 ? `<span class="badge ok">miner</span>` : ""}
          <span class="blk-when">${lastActive ? `last active ${ago(lastActive)}` : "never observed"}</span>
        </div>
        <div class="hash-row">
          <span class="hashline mono">${esc(address)}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${jsq(address)}', this)">copy</button>
        </div>
      </div>
      <div class="blk-nav">
        ${minedTotal > 0 ? `<a class="btn ghost" href="/miner/${esc(address)}" title="Mining profile for this address">Miner ${icons.chevronRight}</a>` : ""}
        <a class="btn ghost" href="/accounts" title="All observed accounts">Accounts ${icons.chevronRight}</a>
      </div>
    </div>
    <div class="cards blk-cards">
      ${statCard("Sent Txs", txCount > 0 ? fmtInt(txCount) : "—", txCount > 0 ? "observed since indexing" : "no sends indexed")}
      ${statCard("Fees Paid", txCount > 0 ? `${atomic(fees, 4)} XEL` : "—", avgFee > 0 ? `avg ${atomic(avgFee, 6)} / tx` : "public metadata only")}
      ${statCard("First Seen", firstSeen ? fmtTime(firstSeen) : "—", firstSeen ? ago(firstSeen) : "not in indexed data")}
      ${statCard("Last Active", lastActive ? ago(lastActive) : "—", lastActive ? fmtTime(lastActive) : "")}
      ${statCard("Blocks Mined", minedTotal > 0 ? fmtInt(minedTotal) : "—", minedTotal > 0 ? "all-time rollups" : "payment-only account")}
    </div>
  </div>`;

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Address</td><td><span class="mono">${esc(address)}</span> <button class="copybtn" type="button" onclick="blkCopy('${jsq(address)}', this)">copy</button></td></tr>
    <tr><td>Label</td><td>${labelValue}</td></tr>
    <tr><td>First seen</td><td>${firstSeen ? fmtTime(firstSeen) : "—"}</td></tr>
    <tr><td>Last active</td><td>${lastActive ? `${fmtTime(lastActive)} (${ago(lastActive)})` : "—"}</td></tr>
    <tr><td>Observed sent txs</td><td>${txCount > 0 ? fmtInt(txCount) : "—"}</td></tr>
  </table></div>`;

  const typeRows = types.length
    ? types.map((t) => {
        const type = esc(t.tx_type ?? "other");
        const cnt = num(t.c);
        const pct = txCount > 0 ? (cnt / txCount) * 100 : 0;
        return `<tr>
          <td><span class="badge ${type}">${type}</span></td>
          <td class="num">${fmtInt(cnt)}</td>
          <td class="num">${pct.toFixed(1)}%</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="3" style="color:var(--text-dim)">No typed transactions indexed for this address yet.</td></tr>`;

  const activity = `<div class="panel"><h2>Activity Breakdown</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Type</th><th class="num">Count</th><th class="num">Share</th></tr></thead>
      <tbody>${typeRows}</tbody>
    </table></div>
    <table class="kv" style="margin-top:1rem">
      ${okPct !== null ? `<tr><td>Executed ok</td><td>${fmtInt(okCount)} of ${fmtInt(txCount)} (${okPct.toFixed(1)}%)</td></tr>` : ""}
      ${txCount > 0 ? `<tr><td>Encrypted payloads</td><td>${fmtInt(encCount)} of ${fmtInt(txCount)}</td></tr>` : ""}
      ${maxTopo !== null && lastSendTopo > 0 ? `<tr><td>Confirmations</td><td>${fmtInt(Math.max(0, maxTopo - lastSendTopo))} <span style="color:var(--text-dim)">since last send</span></td></tr>` : ""}
    </table>
  </div>`;

  const contractTotal = num(contractRows[0]?.total);
  let deployTimes = new Map<number, number>();
  if (contractRows.length) {
    try { deployTimes = await fetchBlockTimes(c.env, contractRows.map((ct) => num(ct.deploy_topo))); } catch { /* unresolved */ }
  }
  const deployedRows = contractRows.map((ct) => {
    const cid = String(ct.contract_id ?? "");
    const topo = num(ct.deploy_topo);
    const ts = deployTimes.get(topo);
    const invokes = num(ct.invoke_count);
    const gas = num(ct.gas_total);
    return `<tr>
      <td><a class="mono" href="/contracts/${esc(cid)}">${esc(shortHash(cid, 10))}</a></td>
      <td class="num">${topo > 0 ? `<a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a>` : "—"}</td>
      <td>${ts ? timeCell(ts) : "—"}</td>
      <td class="num">${fmtInt(invokes)}</td>
      <td class="num">${gas > 0 ? `${atomic(gas)} XEL` : "—"}</td>
    </tr>`;
  }).join("");
  const deployedPanel = contractTotal > 0 ? `<div class="panel">
    <div class="panel-head">
      <h2>Contracts Deployed <span style="color:var(--text-dim)">${fmtInt(contractTotal)}</span>${contractRows.length < contractTotal ? ` <span style="color:var(--text-dim)">· top ${fmtInt(contractRows.length)}</span>` : ""}</h2>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Contract</th><th class="num">Deployed (topo)</th><th>Age</th><th class="num">Invokes</th><th class="num">Gas (XEL)</th></tr></thead>
      <tbody>${deployedRows}</tbody>
    </table></div>
  </div>` : "";

  // local metadata for the assets the node reports for this account
  const assetMeta = new Map<string, { name: string | null; symbol: string | null; decimals: number | null }>();
  const nonXelIds = accountAssets.filter((a) => a && a !== XEL_ASSET_ID);
  try {
    if (nonXelIds.length) {
      const rows = await db.prepare(
        `SELECT asset_id, name, symbol, decimals FROM assets WHERE asset_id IN (${nonXelIds.map(() => "?").join(",")})`
      ).bind(...nonXelIds).all<{ asset_id: string; name: string | null; symbol: string | null; decimals: number | null }>();
      for (const r of rows.results ?? []) assetMeta.set(r.asset_id, { name: r.name, symbol: r.symbol, decimals: r.decimals });
    }
  } catch (err) { logErr("page/account", err); }

  const orderedAssets = [...accountAssets].sort((a, b) => {
    if (a === XEL_ASSET_ID) return -1;
    if (b === XEL_ASSET_ID) return 1;
    return 0;
  });
  const assetRows = orderedAssets.length
    ? orderedAssets.map((aid) => {
        const isXel = aid === XEL_ASSET_ID;
        const meta = isXel
          ? { name: "Xelis", symbol: "XEL", decimals: 8 }
          : assetMeta.get(aid) ?? { name: null, symbol: null, decimals: null };
        const label = meta.symbol ? flaggedText(meta.symbol) : esc(shortHash(aid, 8));
        return `<tr>
          <td><a class="mono" href="/asset/${esc(aid)}">${label}</a></td>
          <td>${meta.name ? flaggedText(meta.name) : "—"}</td>
          <td class="num">${meta.decimals != null ? fmtInt(meta.decimals) : "—"}</td>
          <td>${isXel ? '<span class="badge">native</span>' : ""}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" style="color:var(--text-dim)">No registered assets returned by the node for this address.</td></tr>`;
  const assetsPanel = `<div class="panel">
    <div class="panel-head">
      <h2>Assets <span style="color:var(--text-dim)">${orderedAssets.length > 0 ? `${fmtInt(orderedAssets.length)} registered` : "none observed"}</span></h2>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>Asset</th><th>Name</th><th class="num">Decimals</th><th></th></tr></thead>
      <tbody>${assetRows}</tbody>
    </table></div>
    <p style="color:var(--text-dim);font-size:1.1rem;margin-top:0.8rem">Assets the account has a registered balance for, reported by the node's <span class="mono">get_account_assets</span> RPC. Balances are encrypted, so amounts are not shown.</p>
  </div>`;

  const txRows = txs.length
    ? txs.map((t) => {
        const hash = String(t.hash ?? "");
        return `<tr>
          <td><a class="mono" href="/tx/${esc(hash)}">${esc(shortHash(hash, 10))}</a></td>
          <td><a href="/block/${num(t.block_topo)}"><span class="mint">${fmtInt(num(t.block_topo))}</span></a></td>
          <td>${fmtTime(num(t.ts))}</td>
          <td><span class="badge ${esc(t.tx_type ?? "other")}">${esc(t.tx_type ?? "other")}</span></td>
          <td class="num"${Number(t.transfer_count) === 0 ? ' style="color:var(--text-dim)"' : ""}>${fmtInt(Number(t.transfer_count))}</td>
          <td class="num">${atomic(num(t.fee), 6)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--text-dim)">${histTotal > 0 ? "No transactions match the current filters." : "No indexed transactions from this address (backfill pending or address inactive)."}</td></tr>`;

  const fActive = !!type || !!executed;
  const fFields = `
    ${filterField("Transaction type", `<select name="type">${selectOpts(TX_TYPES, type, "all types")}</select>`)}
    ${filterField("Execution", `<select name="executed"><option value=""${executed === "" ? " selected" : ""}>any status</option><option value="1"${executed === "1" ? " selected" : ""}>executed</option><option value="0"${executed === "0" ? " selected" : ""}>unexecuted</option></select>`)}
  `;
  const fPop = filterPop("f-acct-txs", `/account/${esc(address)}`, fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/account/${esc(address)}${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const history = `<div class="panel">
    <div class="panel-head">
      <h2>History <span style="color:var(--text-dim)">${fmtInt(histTotal)} sent txs</span></h2>
      ${filterButton("f-acct-txs", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th>Hash</th>${srt.th("block", "Block")}${srt.th("time", "Time")}${srt.th("type", "Type")}${srt.th("transfers", "Transfers", true)}${srt.th("fee", "Fee (XEL)", true)}</tr></thead>
      <tbody>${txRows}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, histPages)}
  </div>`;

  const content = `${hero}
    <div class="grid-2">${overview}${activity}</div>
    ${assetsPanel}
    ${history}
    ${deployedPanel}
    <div class="tx-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Sender-observation page: shows this address's publicly visible sending activity. Xelis balances and transfer amounts are encrypted; receiver addresses are public and shown on transaction pages.</span>
    </div>
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`Account ${esc(shortHash(address, 6))}`, content, "/accounts"));
});
