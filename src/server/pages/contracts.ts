import { Hono } from "hono";
import type { Env } from "../app";
import { layout, notFound, statCard } from "../../client/layout";
import { fmtInt, shortHash, fmtTime, ago, atomic } from "../../client/format";
import { srvSort } from "../sort";
import { filterButton, filterPop, filterField } from "../filters";
import { esc, entityTag, blkCopyScript, num } from "./shared";

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
      <h2>Contracts <span style="color:var(--text-dim)">showing ${fmtInt(rows.length)} of indexed</span></h2>
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

  let ct: Record<string, unknown> | undefined;
  let invokes: Record<string, unknown>[] = [];
  try {
    ct = (await db.prepare("SELECT * FROM contracts WHERE contract_id = ?").bind(id).first()) ?? undefined;
    invokes = await db.prepare(
      `SELECT hash, block_topo, ts, fee, result, sender FROM tx_index WHERE contract_id = ? ORDER BY block_topo DESC LIMIT 25`
    ).bind(id).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* db not ready */ }

  if (!ct) return c.html(layout("Not found", notFound("Contract"), "/contracts"));

  const invokeCount = num(ct.invoke_count);
  const gasTotal = num(ct.gas_total);
  const deployTopo = num(ct.deploy_topo);
  const deployer = String(ct.deployer ?? "");
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
      ${statCard("Deployer", deployer ? `<a class="mono" href="/account/${esc(deployer)}">${shortHash(deployer, 8)}</a>` : "—", "account that deployed")}
      ${statCard("Deployed", deployTopo > 0 ? `<a href="/block/${deployTopo}">#${fmtInt(deployTopo)}</a>` : "—", "deploy tx block")}
      ${statCard("Last Invoke", lastTs ? ago(lastTs) : "—", lastTs ? fmtTime(lastTs) : "not observed")}
    </div>
  </div>`;

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Contract ID</td><td><span class="mono">${esc(deployHash)}</span> <button class="copybtn" type="button" onclick="blkCopy('${esc(deployHash)}', this)">copy</button></td></tr>
    <tr><td>Deployer</td><td>${deployer ? `<a class="mono" href="/account/${esc(deployer)}">${shortHash(deployer, 10)}</a>${entityTag(deployer)} <button class="copybtn" type="button" onclick="blkCopy('${esc(deployer)}', this)">copy</button>` : "—"}</td></tr>
    ${deployTopo > 0 ? `<tr><td>Deployed at</td><td><a href="/block/${deployTopo}"><span class="mint">#${fmtInt(deployTopo)}</span></a></td></tr>` : ""}
    <tr><td>Invokes seen</td><td>${invokeCount > 0 ? fmtInt(invokeCount) : "—"}</td></tr>
    <tr><td>Gas total</td><td>${gasTotal > 0 ? fmtInt(gasTotal) : "—"}</td></tr>
    ${num(ct.events_count) ? `<tr><td>Events seen</td><td>${fmtInt(ct.events_count as number)}</td></tr>` : ""}
  </table></div>`;

  const invokeRows = invokes.length
    ? invokes.map((t) => {
        const h = String(t.hash ?? "");
        const result = t.result ? String(t.result) : "";
        return `<tr>
          <td><a class="mono" href="/tx/${esc(h)}">${shortHash(h, 12)}</a></td>
          <td><a href="/block/${num(t.block_topo)}"><span class="mint">${fmtInt(num(t.block_topo))}</span></a></td>
          <td>${fmtTime(num(t.ts))}</td>
          <td><a class="mono" href="/account/${esc(t.sender as string)}">${shortHash(t.sender as string, 8)}</a>${entityTag(t.sender as string)}</td>
          <td class="num">${atomic(num(t.fee), 6)}</td>
          <td>${result ? `<span class="badge ${result === "ok" ? "ok" : "fail"}">${esc(result)}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--text-dim)">No indexed invocations for this contract yet.</td></tr>`;

  const invokesPanel = `<div class="panel"><h2>Recent Invocations ${invokes.length ? `<span style="color:var(--text-dim)">latest ${fmtInt(invokes.length)}</span>` : ""}</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Hash</th><th>Block</th><th>Time</th><th>Sender</th><th class="num">Fee (XEL)</th><th>Result</th></tr></thead>
      <tbody>${invokeRows}</tbody>
    </table></div>
  </div>`;

  const content = `${hero}
    ${overview}
    ${invokesPanel}
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`Contract ${shortHash(deployHash, 8)}`, content, "/contracts"));
});
