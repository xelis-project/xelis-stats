import { Hono } from "hono";
import type { Env } from "../app";
import { layout, notFound, statCard } from "../../client/layout";
import { fmtInt, shortHash, fmtTime, ago, atomic } from "../../client/format";
import { srvSort } from "../sort";
import { filterButton, filterPop, filterField } from "../filters";
import { rpc } from "../xelis";
import { esc, entityTag, blkCopyScript, num, PAGE_SIZE, pager } from "./shared";
import { fetchStorage, storageBatchHtml, storageCard, storageHeadText, storageScript } from "./storage";

export const contracts = new Hono<{ Bindings: Env }>();

contracts.get("/contracts", async (c) => {
  const minInvRaw = Number(c.req.query("min_invokes") ?? "");
  const minInv = Number.isFinite(minInvRaw) && minInvRaw > 0 ? Math.floor(minInvRaw) : 0;
  const srt = srvSort((n) => c.req.query(n), {
    contract: { sql: "contract_id", def: "asc" },
    deployer: { sql: "deployer", def: "asc" },
    deployed: { sql: "deploy_topo", def: "desc" },
    invokes: { sql: "invoke_count", def: "desc" },
    gas: { sql: "gas_total", def: "desc" },
  }, "deployed", "contract_id", (s) => {
    const p = new URLSearchParams();
    if (minInv) p.set("min_invokes", String(minInv));
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/contracts?${q}` : "/contracts";
  });
  let rows: Record<string, unknown>[] = [];
  try {
    const where = minInv ? "WHERE invoke_count >= ?" : "";
    const binds = minInv ? [minInv] : [];
    rows = await c.env.DB.prepare(`SELECT * FROM contracts ${where} ORDER BY ${srt.order} LIMIT 100`)
      .bind(...binds).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* not ready */ }
  let onChainCount: number | null = null;
  try {
    onChainCount = await rpc<number>("count_contracts");
  } catch { /* node unreachable */ }
  const showing = onChainCount !== null ? `showing ${fmtInt(rows.length)} of ${fmtInt(onChainCount)} on-chain` : `showing ${fmtInt(rows.length)} of indexed`;

  const fFields = `
    ${filterField("Min invokes", `<input type="number" name="min_invokes" min="0" step="1" placeholder="e.g. 5" value="${minInv || ""}" />`)}
  `;
  const fPop = filterPop("f-contracts", "/contracts", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/contracts${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((ct) => `<tr>
        <td><a class="mono" href="/contracts/${ct.contract_id}">${shortHash(ct.contract_id as string, 10)}</a></td>
        <td><a class="mono" href="/account/${ct.deployer}">${shortHash(ct.deployer as string, 8)}</a></td>
        <td class="num">${fmtInt(ct.deploy_topo as number)}</td>
        <td class="num">${fmtInt(ct.invoke_count as number)}</td>
        <td class="num">${fmtInt(ct.gas_total as number)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:var(--text-dim)">No contracts indexed yet (populated during tx detail pass).</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Contracts <span style="color:var(--text-dim)">${showing}</span></h2>
      ${filterButton("f-contracts", minInv > 0)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
    <thead><tr>${srt.th("contract", "Contract")}${srt.th("deployer", "Deployer")}${srt.th("deployed", "Deployed (topo)", true)}${srt.th("invokes", "Invokes", true)}${srt.th("gas", "Gas", true)}</tr></thead>
    <tbody>${body}</tbody></table></div></div>`;
  return c.html(layout("Contracts", content, "/contracts"));
});

contracts.get("/contracts/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);

  let ct: Record<string, unknown> | undefined;
  let invokes: Record<string, unknown>[] = [];
  let invokeTotal = 0;
  try {
    ct = (await db.prepare("SELECT * FROM contracts WHERE contract_id = ?").bind(id).first()) ?? undefined;
    invokeTotal = (await db.prepare("SELECT COUNT(*) AS n FROM tx_index WHERE contract_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;
    invokes = await db.prepare(
      `SELECT hash, block_topo, ts, fee, executed, sender FROM tx_index WHERE contract_id = ? ORDER BY block_topo DESC LIMIT ? OFFSET ?`
    ).bind(id, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* db not ready */ }

  if (!ct) return c.html(layout("Not found", notFound("Contract"), "/contracts"));

  // live on-chain enrichment (best effort)
  let moduleTopo: number | null = null;
  let codeSize: number | null = null;
  let moduleRaw: unknown = null;
  let entries: { key: unknown; value: unknown }[] = [];
  let storageMore = false;
  type Bal = { asset: string; balance: number | null; topo: number | null };
  let balances: Bal[] = [];
  try {
    const mod = await rpc<{ topoheight: number; version: { data?: { module?: unknown } } }>("get_contract_module", { contract: id });
    moduleTopo = num(mod.topoheight) || null;
    moduleRaw = mod.version?.data?.module ?? null;
    const raw = JSON.stringify(moduleRaw);
    codeSize = raw.length;
  } catch { /* no module / node unreachable */ }
  try {
    ({ entries, more: storageMore } = await fetchStorage(id, 0));
  } catch { /* none */ }
  try {
    const assets = await rpc<string[]>("get_contract_assets", { contract: id, skip: 0, maximum: 10 });
    balances = await Promise.all(assets.map(async (asset): Promise<Bal> => {
      try {
        const b = await rpc<{ data: number; topoheight: number }>("get_contract_balance", { contract: id, asset });
        return { asset, balance: num(b.data), topo: num(b.topoheight) };
      } catch { return { asset, balance: null, topo: null }; }
    }));
  } catch { /* none */ }
  const xel = "0000000000000000000000000000000000000000000000000000000000000000";
  const deployer = String(ct.deployer ?? "");

  // contract hash == deploy tx hash: resolve the deployer on-chain when the
  // index missed the deploy tx, then backfill the DB
  let liveDeployer = "";
  let liveDeployTopo: number | null = null;
  let deployFee: number | null = null;
  if (!deployer) {
    try {
      const dt = await rpc<Record<string, unknown>>("get_transaction", { hash: id });
      const data = (dt.data ?? {}) as Record<string, unknown>;
      if (data.deploy_contract) {
        liveDeployer = String(dt.source ?? "");
        liveDeployTopo = num(dt.executed_in_topoheight) || null;
        deployFee = num(dt.fee_paid ?? dt.fee) || null;
        if (liveDeployer) {
          try {
            await db.prepare("UPDATE contracts SET deployer = ?, deploy_topo = ? WHERE contract_id = ? AND (deployer = '' OR deployer IS NULL)")
              .bind(liveDeployer, liveDeployTopo ?? 0, id).run();
          } catch { /* db not writable */ }
        }
      }
    } catch { /* node unreachable */ }
  }

  const invokeCount = num(ct.invoke_count);
  const gasTotal = num(ct.gas_total);
  const shownDeployer = deployer || liveDeployer;
  const deployTopo = num(ct.deploy_topo) || liveDeployTopo || 0;
  const deployHash = String(ct.contract_id ?? id);
  const lastTs = invokes.length ? num(invokes[0].ts) : null;

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Contract <span class="mint mono" style="font-size:0.72em">${shortHash(deployHash, 12)}</span></h2>
        <div class="blk-meta">
          ${invokeCount > 0 ? `<span class="badge">${fmtInt(invokeCount)} invoke${invokeCount === 1 ? "" : "s"}</span>` : '<span class="badge">no invokes observed</span>'}
          ${lastTs ? `<span class="blk-when">last invoked ${ago(lastTs)}</span>` : ""}
        </div>
        <div class="hash-row">
          <span class="hashline mono">${esc(deployHash)}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${esc(deployHash)}', this)">copy</button>
        </div>
      </div>
      <div class="blk-nav"><a class="btn ghost" href="/contracts" title="All indexed contracts">Contracts ›</a></div>
    </div>
    <div class="cards blk-cards">
      ${statCard("Invokes", invokeCount > 0 ? fmtInt(invokeCount) : "—", "indexed contract calls")}
      ${statCard("Gas Total", gasTotal > 0 ? fmtInt(gasTotal) : "—", "sum of max_gas across invokes")}
      ${statCard("Deployer", shownDeployer ? `<a class="mono" href="/account/${esc(shownDeployer)}">${shortHash(shownDeployer, 8)}</a>` : "—", shownDeployer && !deployer ? "resolved on-chain" : "account that deployed")}
      ${statCard("Deployed", deployTopo > 0 ? `<a href="/block/${deployTopo}">#${fmtInt(deployTopo)}</a>` : "—", "deploy tx block")}
      ${statCard("Last Invoke", lastTs ? ago(lastTs) : "—", lastTs ? fmtTime(lastTs) : "not observed")}
    </div>
  </div>`;

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Contract ID</td><td><span class="mono">${esc(deployHash)}</span> <button class="copybtn" type="button" onclick="blkCopy('${esc(deployHash)}', this)">copy</button></td></tr>
    <tr><td>Deployer</td><td>${shownDeployer ? `<a class="mono" href="/account/${esc(shownDeployer)}">${shortHash(shownDeployer, 10)}</a>${entityTag(shownDeployer)} <button class="copybtn" type="button" onclick="blkCopy('${esc(shownDeployer)}', this)">copy</button>${!deployer ? ' <span style="color:var(--text-dim)">(resolved on-chain)</span>' : ""}` : "—"}</td></tr>
    ${deployTopo > 0 || moduleTopo ? `<tr><td>Deployed at</td><td>${deployTopo > 0 ? `<a href="/block/${deployTopo}"><span class="mint">#${fmtInt(deployTopo)}</span></a> <span style="color:var(--text-dim)">(indexed)</span>` : ""}${moduleTopo ? ` <a href="/block/${moduleTopo}"><span class="mint">#${fmtInt(moduleTopo)}</span></a> <span style="color:var(--text-dim)">(on-chain)</span>` : ""}</td></tr>` : ""}
    ${codeSize ? `<tr><td>Module code</td><td><span class="mono">~${fmtInt(codeSize)} bytes (serialized)</span></td></tr>` : ""}
    ${deployFee ? `<tr><td>Deploy fee</td><td>${atomic(deployFee, 6)} XEL</td></tr>` : ""}
    <tr><td>Invokes seen</td><td>${invokeCount > 0 ? fmtInt(invokeCount) : "—"}</td></tr>
    <tr><td>Gas total</td><td>${gasTotal > 0 ? fmtInt(gasTotal) : "—"}</td></tr>
    ${num(ct.events_count) ? `<tr><td>Events seen</td><td>${fmtInt(ct.events_count as number)}</td></tr>` : ""}
    ${balances.length ? `<tr><td>Assets held</td><td>${fmtInt(balances.length)}</td></tr>` : ""}
    ${entries.length ? `<tr><td>Storage entries</td><td><a href="#storage">${storageMore ? `${fmtInt(entries.length)}+` : fmtInt(entries.length)}</a></td></tr>` : ""}
  </table></div>`;

  const balRows = balances.length
    ? balances.map((b) => {
        const amount = b.balance !== null ? `<td class="num">${b.asset === xel ? atomic(b.balance, 6) : fmtInt(b.balance)}</td>` : `<td class="num" style="color:var(--text-dim)">—</td>`;
        const assetCell = b.asset === xel
          ? `<span class="badge">XEL</span>`
          : `<a class="mono" href="/asset/${esc(b.asset)}">${shortHash(b.asset, 10)}</a>`;
        return `<tr><td>${assetCell}</td>${amount}<td class="num">${b.topo ? `<a href="/block/${b.topo}">${fmtInt(b.topo)}</a>` : "—"}</td></tr>`;
      }).join("")
    : "";
  const balancesPanel = balances.length ? `<div class="panel"><h2>Balances</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Asset</th><th class="num">Amount</th><th class="num">Updated (topo)</th></tr></thead>
      <tbody>${balRows}</tbody>
    </table></div>
  </div>` : "";

  const storagePanel = entries.length ? `<div class="panel" id="storage">
    <h2>Contract Storage <span style="color:var(--text-dim)">${storageHeadText(entries.length, storageMore)}</span></h2>
    <div class="stg-list" id="stg-list" data-contract="${esc(deployHash)}">${entries.map((e) => storageCard(e.key, e.value)).join("")}</div>
    ${storageMore ? `<div class="stg-more-row"><button class="btn ghost" type="button" id="stg-more">Load more entries</button></div>` : ""}
  </div>` : "";

  // bytecode viewer: collapsible dump of the compiled module chunks
  let bytecodePanel = "";
  if (moduleRaw) {
    let chunks = 0;
    try { chunks = ((moduleRaw as { chunks?: unknown[] }).chunks ?? []).length; } catch { /* malformed */ }
    let dump = "";
    try { dump = JSON.stringify(moduleRaw, null, 2); } catch { /* malformed */ }
    const truncated = dump.length > 40000;
    if (truncated) dump = dump.slice(0, 40000) + "\n… truncated";
    bytecodePanel = `<div class="panel"><h2>Bytecode <span style="color:var(--text-dim)">${chunks} chunks · serialized ~${fmtInt(codeSize ?? 0)} bytes</span></h2>
      <details><summary style="cursor:pointer">Show compiled module</summary>
        <pre class="json-pre">${esc(dump)}</pre>
      </details>
    </div>`;
  }

  const invokeRows = invokes.length
    ? invokes.map((t) => {
        const h = String(t.hash ?? "");
        const result = t.executed === 1 ? "executed" : t.executed === 0 ? "unexecuted" : "";
        return `<tr>
          <td><a class="mono" href="/tx/${esc(h)}">${shortHash(h, 12)}</a></td>
          <td><a href="/block/${num(t.block_topo)}"><span class="mint">${fmtInt(num(t.block_topo))}</span></a></td>
          <td>${fmtTime(num(t.ts))}</td>
          <td><a class="mono" href="/account/${esc(t.sender as string)}">${shortHash(t.sender as string, 8)}</a>${entityTag(t.sender as string)}</td>
          <td class="num">${atomic(num(t.fee), 6)}</td>
          <td>${result ? `<span class="badge ${result === "executed" ? "ok" : "fail"}">${result}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--text-dim)">No indexed invocations for this contract yet.</td></tr>`;

  const totalPages = Math.max(1, Math.ceil(invokeTotal / PAGE_SIZE));
  const pagerBase = `/contracts/${encodeURIComponent(deployHash)}`;
  const invokesPanel = `<div class="panel"><h2>Invocations ${invokeTotal ? `<span style="color:var(--text-dim)">${fmtInt(invokeTotal)} indexed</span>` : ""}</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Hash</th><th>Block</th><th>Time</th><th>Sender</th><th class="num">Fee (XEL)</th><th>Execution</th></tr></thead>
      <tbody>${invokeRows}</tbody>
    </table></div>
    ${pager(pagerBase, page, totalPages)}
  </div>`;

  const content = `${hero}
    ${overview}
    ${balancesPanel}
    ${storagePanel}
    ${bytecodePanel}
    ${invokesPanel}
    ${entries.length ? storageScript(deployHash, entries.length) : ""}
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`Contract ${shortHash(deployHash, 8)}`, content, "/contracts"));
});

// HTML fragment of the next storage batch, appended by the load-more script
contracts.get("/contracts/:id/storage", async (c) => {
  const id = c.req.param("id");
  const skipRaw = Number(c.req.query("skip") ?? 0);
  const skip = Number.isFinite(skipRaw) && skipRaw > 0 ? Math.floor(skipRaw) : 0;
  const { entries, more } = await fetchStorage(id, skip);
  return c.html(storageBatchHtml(entries, more));
});
