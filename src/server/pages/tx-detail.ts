import { Hono } from "hono";
import type { Env } from "../app";
import { layout, notFound, statCard } from "../../client/layout";
import { fmt, fmtInt, shortHash, fmtTime, ago, atomic } from "../../client/format";
import { rpc } from "../xelis";
import { esc, entityTag, blkCopyScript, num } from "./shared";

export const txDetail = new Hono<{ Bindings: Env }>();

txDetail.get("/tx/:hash", async (c) => {
  const hash = c.req.param("hash");
  const db = c.env.DB;
  let tx: Record<string, unknown> | undefined;
  let assets: string[] = [];
  try {
    tx = (await db.prepare("SELECT * FROM tx_index WHERE hash = ?").bind(hash).first()) ?? undefined;
    if (tx) {
      assets = await db.prepare("SELECT asset FROM tx_assets WHERE tx_hash = ?").bind(hash)
        .all<{ asset: string }>().then((r) => (r.results ?? []).map((x) => x.asset));
    }
  } catch { /* db not ready */ }

  if (!tx) {
    // fallback: live node lookup
    try {
      const t = await rpc<Record<string, unknown>>("get_transaction", { hash }, c.env.XELIS_NODE);
      if (t) {
        const data = (t.data ?? {}) as Record<string, unknown>;
        // burn payloads are public on-chain: amount + asset are plaintext
        const burnData = (data.burn ?? null) as Record<string, unknown> | null;
        const burnAmt = burnData ? num(burnData.amount) : 0;
        const burnAssetId = burnData && typeof burnData.asset === "string" ? burnData.asset : "";
        const burnLabel = burnAssetId ? `${atomic(burnAmt)} ${shortHash(burnAssetId, 4)}` : `${atomic(burnAmt)} XEL`;
        const type = esc(Object.keys(data)[0] ?? "unknown");
        const fee = num(t.fee_paid ?? t.fee);
        const size = num(t.size);
        const source = String(t.source ?? "");
        const blockTopo = num(t.executed_in_topoheight);
        const blockHash = typeof t.executed_in_block === "string" ? t.executed_in_block : "";
        let payload = String(t.data);
        try { payload = JSON.stringify(data, null, 2); } catch { /* keep raw */ }
        if (payload.length > 4000) payload = payload.slice(0, 4000) + "\n… truncated (cryptographic proof data)";

        const blockCard = blockTopo > 0
          ? statCard("Block", `<a href="/block/${blockTopo}">#${fmtInt(blockTopo)}</a>`, "executed in block")
          : statCard("Block", "—", "not executed / mempool");
        const hero = `<div class="panel blk-hero">
          <div class="blk-head">
            <div class="blk-id">
              <h2 class="blk-title">Transaction <span class="mint mono">${shortHash(hash, 12)}</span></h2>
              <div class="blk-meta">
                <span class="badge ${type.toLowerCase()}">${type}</span>
                <span class="badge livesrc">live node</span>
                <span class="badge">not indexed</span>
              </div>
              <div class="hash-row">
                <span class="hashline mono">${esc(hash)}</span>
                <button class="copybtn" type="button" onclick="blkCopy('${esc(hash)}', this)">copy</button>
              </div>
            </div>
          </div>
          <div class="cards blk-cards">
            ${statCard("Fee", atomic(fee, 6) + " XEL", size ? `${atomic((fee * 1024) / size, 5)} XEL / kB fee rate` : "network fee")}
            ${statCard("Size", fmtInt(size) + " bytes", size ? `${fmt(size / 1024)} KB on-chain` : "unknown")}
            ${blockCard}
            ${burnData ? statCard("Burned", burnLabel, "public burn amount") : ""}
          </div>
        </div>`;

        const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
          <tr><td>Type</td><td><span class="badge ${type.toLowerCase()}">${type}</span></td></tr>
          <tr><td>Sender</td><td>${source ? `<a class="mono" href="/account/${esc(source)}">${shortHash(source, 10)}</a>${entityTag(source)} <button class="copybtn" type="button" onclick="blkCopy('${esc(source)}', this)">copy</button>` : "—"}</td></tr>
          <tr><td>Block</td><td>${blockTopo > 0 ? `<a href="/block/${blockTopo}"><span class="mint">#${fmtInt(blockTopo)}</span></a>` : blockHash ? `<a class="mono" href="/block/${esc(blockHash)}">${shortHash(blockHash, 10)}</a>` : '<span class="badge">unconfirmed</span>'}</td></tr>
          ${burnData ? `<tr><td>Burned</td><td><span class="mint">${esc(burnLabel)}</span> <span style="color:var(--text-dim)">public burn amount</span></td></tr>` : ""}
          <tr><td>Version</td><td>v${num(t.version)}</td></tr>
          <tr><td>Source</td><td><span class="badge livesrc">queried from node just now</span></td></tr>
        </table></div>`;

        const payloadPanel = `<div class="panel"><h2>Payload <span style="color:var(--text-dim)">(public fields)</span></h2><pre class="json-pre">${esc(payload)}</pre></div>`;

        const content = `${hero}
          ${overview}
          ${payloadPanel}
          <div class="tx-note">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            <span>Transfer amounts and receivers are encrypted; only verified public metadata is shown. This transaction is served straight from the node and is not indexed yet.</span>
          </div>
          <script>${blkCopyScript}</script>`;
        return c.html(layout(`TX ${shortHash(hash, 8)}`, content, "/transactions"));
      }
    } catch { /* not found anywhere */ }
    return c.html(layout("Not found", notFound("Transaction"), "/transactions"));
  }

  // Transfer amounts and receivers are encrypted on mainnet; only asset
  // involvement is public.
  const topo = num(tx.block_topo);
  const ts = num(tx.ts);
  const fee = num(tx.fee);
  const size = num(tx.size);
  const txType = esc(tx.tx_type ?? "other");
  // Burn payloads are public on-chain (amount + asset in plaintext), unlike
  // transfer amounts. Legacy rows predate per-tx burn storage (NULL burn_asset);
  // top them up from the node so the page always shows the amount.
  let burnAmount = num(tx.burn_amount);
  let burnAsset = String(tx.burn_asset ?? "");
  if (txType === "burn" && tx.burn_asset === null) {
    try {
      const t = await rpc<Record<string, unknown>>("get_transaction", { hash });
      const burn = ((t.data ?? {}) as Record<string, unknown>).burn as Record<string, unknown> | undefined;
      if (burn) {
        burnAmount = num(burn.amount);
        burnAsset = typeof burn.asset === "string" ? burn.asset : "";
      }
    } catch { /* keep stored values */ }
  }
  const sender = esc(tx.sender ?? "");
  const result = esc(tx.result ?? "unknown");
  const contractId = String(tx.contract_id ?? "");
  const gas = num(tx.gas);
  const feeRate = fee > 0 && size > 0 ? `${atomic((fee * 1024) / size, 5)} XEL / kB` : "";

  // context queries (best-effort; page degrades gracefully)
  let maxTopo: number | null = null;
  let blockTxCount: number | null = null;
  let blockHash = "";
  let acct: Record<string, unknown> | undefined;
  let assetRows: { asset_id: string; name: string | null; symbol: string | null; decimals: number | null }[] = [];
  let contract: Record<string, unknown> | undefined;
  let maxGas: number | null = null;
  let siblings: Record<string, unknown>[] = [];
  try {
    if (topo > 0) {
      const b = await db.prepare("SELECT hash, tx_count FROM blocks WHERE topoheight = ?").bind(topo).first<{ hash: string; tx_count: number }>();
      blockHash = String(b?.hash ?? "");
      blockTxCount = num(b?.tx_count);
      siblings = await db.prepare("SELECT hash, tx_type, fee, size, result, sender FROM tx_index WHERE block_topo = ? AND hash != ? ORDER BY ts, hash LIMIT 10")
        .bind(topo, hash).all<Record<string, unknown>>().then((r) => r.results ?? []);
    }
    maxTopo = (await db.prepare("SELECT MAX(topoheight) AS m FROM blocks").first<{ m: number }>())?.m ?? null;
    if (sender) acct = (await db.prepare("SELECT first_seen, last_active, tx_count FROM accounts WHERE address = ?").bind(sender).first()) ?? undefined;
    if (assets.length) {
      const rows = await db.prepare(
        `SELECT asset_id, name, symbol, decimals FROM assets WHERE asset_id IN (${assets.map(() => "?").join(",")})`
      ).bind(...assets).all<{ asset_id: string; name: string | null; symbol: string | null; decimals: number | null }>();
      const byId = new Map((rows.results ?? []).map((r) => [r.asset_id, r]));
      assetRows = assets.map((a) => byId.get(a) ?? { asset_id: a, name: null, symbol: null, decimals: null });
    }
    if (contractId) {
      maxGas = (await db.prepare("SELECT max_gas FROM tx_contracts WHERE tx_hash = ?").bind(hash).first<{ max_gas: number }>())?.max_gas ?? null;
      contract = (await db.prepare("SELECT deployer, deploy_topo, invoke_count, gas_total FROM contracts WHERE contract_id = ?").bind(contractId).first()) ?? undefined;
    }
  } catch { /* db not ready */ }

  // format the public burn amount with the asset's decimals (defaults to XEL)
  const burnRow = burnAsset ? assetRows.find((a) => a.asset_id === burnAsset) : undefined;
  const burnDecimals = burnRow?.decimals !== null && burnRow?.decimals !== undefined ? Number(burnRow.decimals) : 8;
  const burnSymbol = burnRow?.symbol || "XEL";
  const burnLabel = `${fmt(burnAmount / 10 ** burnDecimals, 2)} ${esc(burnSymbol)}`;
  const isBurn = txType === "burn";

  const conf = maxTopo !== null && topo > 0 ? fmtInt(Math.max(0, maxTopo - topo)) : "—";
  const otherInBlock = blockTxCount !== null ? Math.max(0, blockTxCount - 1) : null;
  const hasResult = tx.result !== null && tx.result !== undefined && tx.result !== "";
  const blockSub = otherInBlock === null ? ""
    : otherInBlock === 0 ? "only tx in block"
    : `${fmtInt(otherInBlock)} other tx${otherInBlock === 1 ? "" : "s"} in block`;

  const fifthCard = contractId
    ? statCard("Gas", gas || maxGas ? fmtInt(gas || maxGas) : "—", "contract execution")
    : isBurn
      ? statCard("Burned", burnLabel, "public burn amount")
      : tx.multisig
        ? statCard("Multisig", "yes", "threshold in payload")
        : txType === "transfer"
          ? statCard("Transfers", fmtInt(tx.transfer_count as number), "receivers encrypted")
          : statCard("Version", `v${num(tx.version)}`, "payload format");

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Transaction <span class="mint mono">${shortHash(hash, 12)}</span></h2>
        <div class="blk-meta">
          <span class="badge ${txType}">${txType}</span>
          ${hasResult ? `<span class="badge ${result === "ok" ? "ok" : "fail"}">${result}</span>` : ""}
          ${tx.encrypted ? '<span class="badge priv">encrypted</span>' : ""}
          ${tx.multisig ? '<span class="badge">multisig</span>' : ""}
          <span class="blk-when">${fmtTime(ts)} · ${ago(ts)}</span>
        </div>
        <div class="hash-row">
          <span class="hashline mono">${esc(tx.hash as string)}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${esc(tx.hash as string)}', this)">copy</button>
        </div>
      </div>
      ${topo > 0 ? `<div class="blk-nav"><a class="btn ghost" href="/block/${topo}" title="Open containing block">Block ›</a></div>` : ""}
    </div>
    <div class="cards blk-cards">
      ${statCard("Fee", atomic(fee, 6) + " XEL", feeRate ? `${feeRate} fee rate` : "network fee")}
      ${statCard("Size", fmtInt(size) + " bytes", size ? `${fmt(size / 1024)} KB on-chain` : "—")}
      ${statCard("Block", topo > 0 ? `<a href="/block/${topo}">#${fmtInt(topo)}</a>` : "—", blockSub)}
      ${statCard("Confirmations", maxTopo !== null && topo > 0 ? fmtInt(Math.max(0, maxTopo - topo)) : "—", maxTopo !== null ? `network tip #${fmtInt(maxTopo)}` : "")}
      ${fifthCard}
    </div>
  </div>`;

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Type</td><td><span class="badge ${txType}">${txType}</span>${tx.multisig ? ' <span class="badge">multisig</span>' : ""}</td></tr>
    <tr><td>Sender</td><td>${sender ? `<a class="mono" href="/account/${sender}">${shortHash(sender, 10)}</a>${entityTag(sender)} <button class="copybtn" type="button" onclick="blkCopy('${sender}', this)">copy</button>` : "—"}</td></tr>
    ${acct && num(acct.tx_count) > 0 ? `<tr><td>Sender history</td><td><a href="/account/${sender}">${fmtInt(acct.tx_count as number)} observed sent txs</a> · last active ${ago(num(acct.last_active))}</td></tr>` : ""}
    ${isBurn ? `<tr><td>Burned</td><td><span class="mint">${burnLabel}</span> <span style="color:var(--text-dim)">public burn amount</span></td></tr>` : ""}
    <tr><td>Timestamp</td><td>${fmtTime(ts)}</td></tr>
    <tr><td>Age</td><td>${ago(ts)}</td></tr>
    <tr><td>Version</td><td>v${num(tx.version)}</td></tr>
    <tr><td>Privacy</td><td>${isBurn
      ? '<span class="badge burn">public burn</span> <span style="color:var(--text-dim)">burn amount &amp; asset are public; balances stay encrypted</span>'
      : '<span class="badge priv">encrypted</span> <span style="color:var(--text-dim)">amounts &amp; receivers hidden</span>'}</td></tr>
  </table></div>`;

  const statusPanel = `<div class="panel"><h2>Status &amp; Cost</h2><table class="kv">
    <tr><td>Result</td><td>${hasResult ? `<span class="badge ${result === "ok" ? "ok" : "fail"}">${result}</span>` : '<span class="badge">not recorded</span>'}</td></tr>
    <tr><td>Block</td><td><a href="/block/${topo}"><span class="mint">#${fmtInt(topo)}</span></a>${blockHash ? ` <span class="hash">${shortHash(blockHash, 6)}</span>` : ""}</td></tr>
    <tr><td>Confirmations</td><td>${conf}</td></tr>
    <tr><td>Fee</td><td>${atomic(fee, 6)} XEL${feeRate ? ` <span style="color:var(--text-dim)">· ${feeRate}</span>` : ""}</td></tr>
    <tr><td>Size</td><td>${fmtInt(size)} bytes${size ? ` (${fmt(size / 1024)} KB)` : ""}</td></tr>
  </table></div>`;

  const contractPanel = contractId ? `<div class="panel"><h2>Contract Execution</h2><table class="kv">
    <tr><td>Contract</td><td><a class="mono" href="/contracts/${esc(contractId)}">${shortHash(contractId, 12)}</a> <button class="copybtn" type="button" onclick="blkCopy('${esc(contractId)}', this)">copy</button></td></tr>
    ${gas || maxGas ? `<tr><td>Gas</td><td>${fmtInt(gas || maxGas)}${maxGas && gas && maxGas !== gas ? ` <span style="color:var(--text-dim)">· max ${fmtInt(maxGas)}</span>` : ""}</td></tr>` : ""}
    ${contract ? `
      ${num(contract.invoke_count) ? `<tr><td>Invokes seen</td><td>${fmtInt(contract.invoke_count as number)}</td></tr>` : ""}
      ${contract.deployer ? `<tr><td>Deployer</td><td><a class="mono" href="/account/${esc(contract.deployer as string)}">${shortHash(contract.deployer as string, 10)}</a></td></tr>` : ""}
      ${num(contract.deploy_topo) ? `<tr><td>Deployed at</td><td><a href="/block/${num(contract.deploy_topo)}">#${fmtInt(contract.deploy_topo as number)}</a></td></tr>` : ""}` : ""}
  </table></div>` : "";

  const assetRowsHtml = assetRows.map((a) => `<tr>
    <td><span class="mono">${shortHash(a.asset_id, 10)}</span> <button class="copybtn" type="button" onclick="blkCopy('${esc(a.asset_id)}', this)">copy</button></td>
    <td>${a.name ? esc(a.name) : "—"}</td>
    <td>${a.symbol ? esc(a.symbol) : "—"}</td>
    <td class="num">${a.decimals !== null && a.decimals !== undefined ? fmtInt(a.decimals) : "—"}</td>
  </tr>`).join("");

  const assetsPanel = assetRows.length
    ? `<div class="panel"><h2>Assets Involved <span style="color:var(--text-dim)">(${assetRows.length})</span></h2>
       <div class="tablewrap"><table>
         <thead><tr><th>Asset ID</th><th>Name</th><th>Symbol</th><th class="num">Decimals</th></tr></thead>
         <tbody>${assetRowsHtml}</tbody></table></div>
       </div>`
    : "";

  const siblingsPanel = siblings.length
    ? `<div class="panel"><h2>More in Block #${fmtInt(topo)}${blockTxCount ? ` <span style="color:var(--text-dim)">${fmtInt(blockTxCount)} txs total</span>` : ""}</h2>
       <div class="tablewrap"><table>
         <thead><tr><th>Hash</th><th>Type</th><th>Sender</th><th class="num">Fee (XEL)</th><th class="num">Size</th><th>Result</th></tr></thead>
         <tbody>${siblings.map((s) => {
           const h = String(s.hash ?? "");
           return `<tr>
             <td><a class="mono" href="/tx/${esc(h)}">${shortHash(h, 12)}</a></td>
             <td><span class="badge ${esc(s.tx_type)}">${esc(s.tx_type)}</span></td>
             <td><a class="mono" href="/account/${esc(s.sender as string)}">${shortHash(s.sender as string, 8)}</a>${entityTag(s.sender as string)}</td>
             <td class="num">${atomic(num(s.fee), 6)}</td>
             <td class="num">${fmtInt(num(s.size))} B</td>
             <td>${s.result ? `<span class="badge ${s.result === "ok" ? "ok" : "fail"}">${esc(s.result)}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
           </tr>`; }).join("")}
         </tbody></table></div>
       ${otherInBlock && otherInBlock > siblings.length ? `<p class="tx-more"><a href="/block/${topo}">View block #${fmtInt(topo)} for all ${fmtInt(otherInBlock + 1)} transactions →</a></p>` : ""}
       </div>`
    : "";

  const content = `${hero}
    <div class="grid-2">${overview}${statusPanel}</div>
    ${contractPanel}
    ${assetsPanel}
    ${siblingsPanel}
    <div class="tx-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>${isBurn
        ? "Burn transactions are public on Xelis: the burned amount and asset are visible to everyone. Wallet balances and transfer amounts stay encrypted."
        : "Xelis is private by design: transfer amounts, receivers and balances are encrypted for everyone — including this explorer. This page shows only the public metadata indexed from the chain."}</span>
    </div>
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`TX ${shortHash(hash, 8)}`, content, "/transactions"));
});
