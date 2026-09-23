import { Hono } from "hono";
import type { Env } from "../app";
import { layout, notFound, statCard } from "../../client/layout";
import { fmt, fmtInt, fmtPct, shortHash, fmtTime, ago, atomic, atomicPrecise } from "../../client/format";
import { rpc } from "../xelis";
import { PAGE_SIZE, pager, esc, entityTag, resultBadge, blkCopyScript, num } from "./shared";

export const blockDetail = new Hono<{ Bindings: Env }>();

blockDetail.get("/block/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  let block: Record<string, unknown> | undefined;
  try {
    if (/^\d+$/.test(id)) {
      block = (await db.prepare("SELECT * FROM blocks WHERE topoheight = ? OR height = ?").bind(Number(id), Number(id)).first()) ?? undefined;
    } else {
      block = (await db.prepare("SELECT * FROM blocks WHERE hash = ?").bind(id).first()) ?? undefined;
    }
  } catch { /* db not ready */ }

  let source: "indexed" | "live" = "indexed";
  if (!block) {
    // fallback: live node lookup
    try {
      const b = /^\d+$/.test(id)
        ? await rpc<Record<string, unknown>>("get_block_at_topoheight", { topoheight: Number(id) }, c.env.XELIS_NODE)
        : await rpc<Record<string, unknown>>("get_block_by_hash", { hash: id }, c.env.XELIS_NODE);
      if (b) { block = b; source = "live"; }
    } catch { /* not found anywhere */ }
  }

  if (!block) return c.html(layout("Not found", notFound("Block"), "/blocks"));

  // normalize indexed rows and live-node JSON into one shape
  const arr = (v: unknown): string[] => {
    const parsed = Array.isArray(v) ? v : (() => { try { return JSON.parse(String(v ?? "[]")) as unknown; } catch { return []; } })();
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  };
  const view = {
    topo: num(block.topoheight),
    height: num(block.height),
    hash: String(block.hash ?? id),
    ts: num(block.ts ?? block.timestamp),
    version: num(block.version),
    nonce: num(block.nonce),
    difficulty: num(block.difficulty),
    size: num(block.size ?? block.total_size_in_bytes),
    type: esc(block.block_type ?? "normal"),
    orphan: !!block.is_orphan,
    miner: String(block.miner_address ?? block.miner ?? ""),
    minerReward: num(block.miner_reward),
    devReward: num(block.dev_reward),
    burned: num(block.burned ?? block.total_fees_burned),
    fees: num(block.fee_total ?? block.total_fees),
    cumDifficulty: String(block.cum_difficulty ?? block.cumulative_difficulty ?? ""),
    tips: arr(block.tips),
    txHashes: arr(block.txs_hashes),
  };
  const txCount = num(block.tx_count) || view.txHashes.length;

  let prevTs: number | null = null;
  let maxTopo: number | null = null;
  try {
    if (view.topo > 0) prevTs = (await db.prepare("SELECT ts FROM blocks WHERE topoheight = ?").bind(view.topo - 1).first<{ ts: number }>())?.ts ?? null;
    maxTopo = (await db.prepare("SELECT MAX(topoheight) AS m FROM blocks").first<{ m: number }>())?.m ?? null;
  } catch { /* db unavailable */ }

  // ts units are milliseconds (daemon timestamps)
  const blockTime = prevTs !== null && view.ts > prevTs ? Math.round((view.ts - prevTs) / 1000) : null;
  const hashrate = blockTime && view.difficulty ? view.difficulty / blockTime : null;
  const totalReward = view.minerReward + view.devReward;
  const avgFee = txCount > 0 ? view.fees / txCount : null;

  // reward context: 24h network average and this miner's activity
  let avgReward24h: number | null = null;
  let minerBlocks24h: number | null = null;
  try {
    const agg = await db.prepare(
      "SELECT AVG(miner_reward + dev_reward) AS avg_reward, SUM(CASE WHEN miner_address = ? THEN 1 ELSE 0 END) AS miner_blocks FROM blocks WHERE ts > ?"
    ).bind(view.miner, Date.now() - 86400_000).first<{ avg_reward: number | null; miner_blocks: number | null }>();
    if (agg) {
      avgReward24h = Number(agg.avg_reward) || null;
      minerBlocks24h = Number(agg.miner_blocks) || 0;
    }
  } catch { /* db unavailable */ }
  const feePerByte = view.size > 0 ? view.fees / view.size : null; // atomic XEL per byte

  const splitSum = Math.max(1, view.minerReward + view.devReward + view.burned);
  const pct = (v: number) => `${((v / splitSum) * 100).toFixed(1)}%`;

  const dim = (label: string) => `<span class="btn ghost disabled" aria-disabled="true">${label}</span>`;
  const nav = `<div class="blk-nav">
    ${view.topo > 0 ? `<a class="btn ghost" href="/block/${view.topo - 1}" title="Previous block">‹ Prev</a>` : dim("‹ Prev")}
    ${maxTopo === null || view.topo < maxTopo ? `<a class="btn ghost" href="/block/${view.topo + 1}" title="Next block">Next ›</a>` : dim("Next ›")}
  </div>`;

  const typeBadge = `<span class="badge ${view.type.toLowerCase()}">${view.type}</span>${view.orphan ? ' <span class="badge fail">orphan</span>' : ""}`;

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Block <span class="mint">#${fmtInt(view.topo)}</span></h2>
        <div class="blk-meta">
          ${typeBadge}
          ${source === "live" ? '<span class="badge livesrc">live node</span>' : ""}
          <span class="blk-when">${fmtTime(view.ts)} · ${ago(view.ts)}</span>
        </div>
        <div class="hash-row">
          <span class="hashline mono">${view.hash}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${view.hash}', this)">copy</button>
        </div>
      </div>
      ${nav}
    </div>
    <div class="cards blk-cards">
      ${statCard("Transactions", fmtInt(txCount), avgFee !== null ? `avg ${atomicPrecise(avgFee)} / tx` : "no transactions")}
      ${statCard("Size", `${fmt(view.size / 1024)} KB`, `${fmtInt(view.size)} bytes`)}
      ${statCard("Difficulty", fmt(view.difficulty), hashrate ? `≈ ${fmt(hashrate)} H/s est. hashrate` : "network difficulty")}
      ${statCard("Block Time", blockTime !== null ? `${fmtInt(blockTime)}s` : "—", "since previous block")}
      ${statCard("DAG Tips", fmtInt(view.tips.length), "parent blocks in the DAG")}
    </div>
  </div>`;

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Topoheight</td><td>${fmtInt(view.topo)}</td></tr>
    <tr><td>Height</td><td>${fmtInt(view.height)}</td></tr>
    <tr><td>Timestamp</td><td>${fmtTime(view.ts)}</td></tr>
    <tr><td>Age</td><td>${ago(view.ts)}</td></tr>
    ${blockTime !== null ? `<tr><td>Block Time</td><td>${fmtInt(blockTime)}s since previous</td></tr>` : ""}
    <tr><td>Version</td><td>${fmtInt(view.version)}</td></tr>
    <tr><td>Nonce</td><td><span class="mono">${view.nonce}</span></td></tr>
    <tr><td>Size</td><td>${fmtInt(view.size)} bytes (${fmt(view.size / 1024)} KB)</td></tr>
    <tr><td>Difficulty</td><td>${fmtInt(view.difficulty)}</td></tr>
    ${view.cumDifficulty ? `<tr><td>Cumulative Difficulty</td><td><span class="mono">${view.cumDifficulty}</span></td></tr>` : ""}
    <tr><td>Block Type</td><td>${typeBadge}</td></tr>
    <tr><td>Miner</td><td>${view.miner ? `<a class="mono" href="/miner/${view.miner}">${shortHash(view.miner, 10)}</a>` : "—"}</td></tr>
    <tr><td>DAG Tips</td><td>${fmtInt(view.tips.length)}</td></tr>
  </table></div>`;

  const rwSeg = (cls: string, name: string, amt: number) =>
    `<div class="seg ${cls}" style="width:${(amt / splitSum) * 100}%" title="${name} — ${atomicPrecise(amt)} XEL (${pct(amt)})"></div>`;
  const rwRow = (name: string, cls: string, amt: number) => `<div class="rw-row">
      <span class="rw-name"><span class="rw-swatch ${cls}"></span>${name}</span>
      <span class="rw-right"><span class="rw-pct">${pct(amt)}</span><span class="rw-amt">${atomicPrecise(amt)} <span class="unit">XEL</span></span></span>
    </div>`;

  const rewards = `<div class="panel rw-panel"><h2>Rewards &amp; Fees</h2>
    <div class="rw-total">
      <span class="rt-label">Total Reward</span>
      <span class="rt-value">${atomicPrecise(totalReward)} <span class="unit">XEL</span></span>
      <span class="rt-sub">emitted for this block</span>
    </div>
    <div class="rewardbar" title="Reward split: miner / dev / burned">
      ${rwSeg("miner", "Miner reward", view.minerReward)}
      ${rwSeg("dev", "Dev reward", view.devReward)}
      ${rwSeg("burned", "Fees burned", view.burned)}
    </div>
    <div class="rw-rows">
      ${rwRow("Miner reward", "miner", view.minerReward)}
      ${rwRow("Dev reward", "dev", view.devReward)}
      ${rwRow("Fees burned", "burned", view.burned)}
    </div>
    <div class="rw-fees">
      <div class="rw-chip"><div class="t">Fees Collected</div><div class="v">${atomicPrecise(view.fees)} <span class="unit">XEL</span></div></div>
      <div class="rw-chip"><div class="t">Avg Fee / tx</div><div class="v">${avgFee !== null ? `${atomicPrecise(avgFee)} <span class="unit">XEL</span>` : "—"}</div><div class="s">${txCount > 0 ? `across ${fmtInt(txCount)} tx${txCount === 1 ? "" : "s"}` : "no transactions"}</div></div>
      <div class="rw-chip"><div class="t">Fees Burned</div><div class="v">${atomicPrecise(view.burned)} <span class="unit">XEL</span></div></div>
    </div>
    <div class="rw-fees ctx">
      <div class="rw-chip"><div class="t">24h Avg Reward</div><div class="v">${avgReward24h !== null ? `${atomicPrecise(avgReward24h)} <span class="unit">XEL</span>` : "—"}</div>${avgReward24h ? `<div class="s">this block ${fmtPct(((totalReward - avgReward24h) / avgReward24h) * 100)}</div>` : ""}</div>
      <div class="rw-chip"><div class="t">Miner Blocks · 24h</div><div class="v">${minerBlocks24h !== null ? fmtInt(minerBlocks24h) : "—"}</div><div class="s">${view.miner ? shortHash(view.miner, 8) : "no miner address"}</div></div>
      <div class="rw-chip"><div class="t">Fee per Byte</div><div class="v">${feePerByte !== null && view.fees > 0 ? `${atomicPrecise(feePerByte)} <span class="unit">XEL</span>` : "—"}</div><div class="s">collected fees ÷ block size</div></div>
    </div>
  </div>`;

  const tipsHtml = view.tips.length
    ? `<div class="panel"><h2>DAG Tips <span style="color:var(--text-dim)">(parent blocks)</span></h2><div class="tips-list">${view.tips.map((h) =>
        `<div class="tip-item"><a class="mono" href="/block/${h}">${shortHash(h, 12)}</a></div>`).join("")}</div></div>`
    : "";

  // join block tx hashes against the tx index for richer rows (chunked: D1 param limit)
  const known = new Map<string, { tx_type: string; fee: number; size: number; result: string | null; sender: string }>();
  try {
    for (let i = 0; i < view.txHashes.length; i += 90) {
      const chunk = view.txHashes.slice(i, i + 90);
      const rows = await db.prepare(
        `SELECT hash, tx_type, fee, size, result, sender FROM tx_index WHERE hash IN (${chunk.map(() => "?").join(",")})`
      ).bind(...chunk).all<{ hash: string; tx_type: string; fee: number; size: number; result: string | null; sender: string }>();
      for (const r of rows.results ?? []) known.set(r.hash, r);
    }
  } catch { /* db unavailable */ }

  const hasTxHashes = view.txHashes.length > 0;
  const txRows = hasTxHashes
    ? view.txHashes.map((h) => {
        const t = known.get(h);
        return `<tr>
          <td><a class="mono" href="/tx/${h}">${shortHash(h, 12)}</a></td>
          ${t
            ? `<td><span class="badge ${esc(t.tx_type)}">${esc(t.tx_type)}</span></td>
               <td><a class="mono" href="/account/${t.sender}">${shortHash(t.sender, 8)}</a>${entityTag(t.sender)}</td>
               <td class="num">${atomic(t.fee, 6)}</td>
               <td class="num">${fmtInt(t.size)} B</td>
               <td>${resultBadge(t.result)}</td>`
            : `<td colspan="5"><span class="badge">live node</span> <span style="color:var(--text-dim)">not indexed yet</span></td>`}
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--text-dim)">No transactions in this block${txCount > 0 ? " (hashes not stored)" : ""}.</td></tr>`;

  const txs = txCount > 0 || hasTxHashes
    ? `<div class="panel"><h2>Transactions (${fmtInt(hasTxHashes ? view.txHashes.length : txCount)})</h2><div class="tablewrap"><table>
        <thead><tr><th>Hash</th><th>Type</th><th>Sender</th><th class="num">Fee (XEL)</th><th class="num">Size</th><th>Result</th></tr></thead>
        <tbody>${txRows}</tbody></table></div></div>`
    : "";

  const content = `${hero}
    <div class="grid-2">${overview}${rewards}</div>
    ${tipsHtml}
    ${txs}
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`Block ${fmtInt(view.topo)}`, content, "/blocks"));
});
