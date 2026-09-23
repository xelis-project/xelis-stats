import { Hono } from "hono";
import type { Env } from "./app";
import { layout, notFound, statCard } from "../client/layout";
import { fmt, fmtInt, fmtPct, shortHash, fmtTime, ago, atomic, atomicPrecise } from "../client/format";
import { knownEntity } from "./entities";
import { srvSort, BLOCK_COLS, TX_COLS, ACCT_COLS, TOP_COLS } from "./sort";
import { filterButton, filterPop, filterField, selectOpts } from "./filters";

export const pages = new Hono<{ Bindings: Env }>();

const PAGE_SIZE = 25;

function pager(base: string, page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const href = (p: number) => `${base}${base.includes("?") ? "&" : "?"}page=${p}`;
  const nums: (number | "…")[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 2) nums.push(p);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  const dim = (label: string) => `<span class="btn ghost disabled" aria-disabled="true">${label}</span>`;
  return `<div class="pager">
    ${page > 1 ? `<a class="btn ghost" href="${href(1)}">« First</a>` : dim("« First")}
    ${page > 1 ? `<a class="btn ghost" href="${href(page - 1)}">‹ Prev</a>` : dim("‹ Prev")}
    ${nums.map((p) => p === "…"
      ? `<span class="pager-dots">…</span>`
      : p === page
        ? `<span class="btn mint" aria-current="page">${p}</span>`
        : `<a class="btn ghost" href="${href(p)}">${p}</a>`).join("")}
    ${page < totalPages ? `<a class="btn ghost" href="${href(page + 1)}">Next ›</a>` : dim("Next ›")}
    ${page < totalPages ? `<a class="btn ghost" href="${href(totalPages)}">Last »</a>` : dim("Last »")}
    <span class="pager-info">Page ${fmtInt(page)} of ${fmtInt(totalPages)}</span>
  </div>`;
}

// ---------- blocks ----------

pages.get("/blocks", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  // table filters: block type (case-insensitive, like /api/blocks) + min txs
  const typeRaw = (c.req.query("type") ?? "").toLowerCase();
  const type = ["normal", "side", "sync"].includes(typeRaw) ? typeRaw[0].toUpperCase() + typeRaw.slice(1) : "";
  const minTxsRaw = Number(c.req.query("min_txs") ?? "");
  const minTxs = Number.isFinite(minTxsRaw) && minTxsRaw > 0 ? Math.floor(minTxsRaw) : 0;
  const db = c.env.DB;
  const srt = srvSort((n) => c.req.query(n), BLOCK_COLS, "topo", "topoheight DESC", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (minTxs) p.set("min_txs", String(minTxs));
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/blocks?${q}` : "/blocks";
  });
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (type) { conds.push("UPPER(block_type) = UPPER(?)"); binds.push(type); }
  if (minTxs) { conds.push("tx_count >= ?"); binds.push(minTxs); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  let rows: Record<string, unknown>[];
  let total = 0;
  try {
    total = await db.prepare(`SELECT COUNT(*) AS n FROM blocks ${where}`).bind(...binds).first<{ n: number }>().then((r) => r?.n ?? 0);
    rows = await db.prepare(`SELECT * FROM blocks ${where} ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch {
    rows = [];
  }
  const hasMore = rows.length > PAGE_SIZE;
  rows = rows.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const body = rows.length
    ? rows.map((b) => {
        const topo = b.topoheight as number;
        const ts = b.ts as number;
        const orphan = b.is_orphan ? ' <span class="badge fail">orphan</span>' : "";
        const type = esc(String(b.block_type ?? "normal"));
        return `<tr>
          <td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>
          <td><span class="hash">${shortHash(b.hash as string)}</span></td>
          <td>${fmtTime(ts)}</td>
          <td class="num">${fmtInt(b.tx_count as number)}</td>
          <td class="num">${fmt((b.difficulty as number) ?? 0)}</td>
          <td class="num">${atomic(b.miner_reward as number)}</td>
          <td><span class="badge ${type.toLowerCase()}">${type}</span>${orphan}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No indexed blocks yet — historical backfill pending. Live data unavailable until D1 import.</td></tr>`;

  const fActive = !!type || minTxs > 0;
  const fFields = `
    ${filterField("Block type", `<select name="type">${selectOpts(["Normal", "Side", "Sync"], type, "all types")}</select>`)}
    ${filterField("Min transactions", `<input type="number" name="min_txs" min="0" step="1" placeholder="e.g. 2" value="${minTxs || ""}" />`)}
  `;
  const fPop = filterPop("f-blocks", "/blocks", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/blocks${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Blocks <span style="color:var(--text-dim)">${fmtInt(total)} total</span></h2>
      ${filterButton("f-blocks", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr>${srt.th("topo", "Topo")}${srt.th("hash", "Hash")}${srt.th("time", "Time")}${srt.th("txs", "Txs", true)}${srt.th("difficulty", "Difficulty", true)}${srt.th("reward", "Reward (XEL)", true)}${srt.th("type", "Type")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;
  return c.html(layout("Blocks", content, "/blocks"));
});

// ---------- accounts ----------

pages.get("/accounts", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  // legacy ?sort=active|txs|first URLs map onto the same columns and defaults
  const minTxsRaw = Number(c.req.query("min_txs") ?? "");
  const minTxs = Number.isFinite(minTxsRaw) && minTxsRaw > 0 ? Math.floor(minTxsRaw) : 0;
  const srt = srvSort((n) => c.req.query(n), ACCT_COLS, "last", "address", (s) => {
    const p = new URLSearchParams();
    if (minTxs) p.set("min_txs", String(minTxs));
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/accounts?${q}` : "/accounts";
  });
  const db = c.env.DB;
  let rows: Record<string, unknown>[];
  let total = 0;
  try {
    const where = minTxs ? "WHERE tx_count >= ?" : "";
    const binds = minTxs ? [minTxs] : [];
    total = await db.prepare(`SELECT COUNT(*) AS n FROM accounts ${where}`).bind(...binds).first<{ n: number }>().then((r) => r?.n ?? 0);
    rows = await db.prepare(`SELECT address, first_seen, last_active, tx_count FROM accounts ${where} ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch {
    rows = [];
  }
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fFields = `
    ${filterField("Min sent txs", `<input type="number" name="min_txs" min="0" step="1" placeholder="e.g. 10" value="${minTxs || ""}" />`)}
  `;
  const fPop = filterPop("f-accounts", "/accounts", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/accounts${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((a) => {
        const addr = a.address as string;
        const e = knownEntity(addr);
        return `<tr>
          <td><a href="/account/${addr}"><span class="hash">${shortHash(addr)}</span></a>${e ? ` <span class="badge entity ${esc(e.kind)}">${esc(e.label)}</span>` : ""}</td>
          <td>${fmtTime(a.first_seen as number)}</td>
          <td>${ago((a.last_active as number) ?? null)}</td>
          <td class="num">${fmtInt(a.tx_count as number)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="4" style="color:var(--text-dim)">No observed accounts yet.</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Accounts <span style="color:var(--text-dim)">${fmtInt(total)} observed</span></h2>
      ${filterButton("f-accounts", minTxs > 0)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr>${srt.th("address", "Address")}${srt.th("first", "First seen")}${srt.th("last", "Last active")}${srt.th("txs", "Txs", true)}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;
  return c.html(layout("Accounts", content, "/accounts"));
});

// ---------- block detail ----------

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

const entityTag = (address: string): string => {
  const e = knownEntity(address);
  return e ? ` <span class="badge entity ${esc(e.kind)}">${esc(e.label)}</span>` : "";
};

// result is NULL for rows backfilled before the column existed
const resultBadge = (result: unknown): string =>
  `<span class="badge ${result === "ok" ? "ok" : result ? "fail" : ""}">${esc(result ?? "unknown")}</span>`;

const blkCopyScript = `function blkCopy(txt,btn){var flip=function(){var t=btn.textContent;btn.textContent="copied";btn.classList.add("done");setTimeout(function(){btn.textContent=t;btn.classList.remove("done");},1200);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(flip);}else{var i=document.createElement("textarea");i.value=txt;document.body.appendChild(i);i.select();try{document.execCommand("copy");}catch(e){}document.body.removeChild(i);flip();}}`;

pages.get("/block/:id", async (c) => {
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
      const { rpc } = await import("./xelis");
      const b = /^\d+$/.test(id)
        ? await rpc<Record<string, unknown>>("get_block_at_topoheight", { topoheight: Number(id) }, c.env.XELIS_NODE)
        : await rpc<Record<string, unknown>>("get_block_by_hash", { hash: id }, c.env.XELIS_NODE);
      if (b) { block = b; source = "live"; }
    } catch { /* not found anywhere */ }
  }

  if (!block) return c.html(layout("Not found", notFound("Block"), "/blocks"));

  // normalize indexed rows and live-node JSON into one shape
  const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
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

// ---------- transactions ----------

pages.get("/transactions", async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const TX_TYPES = ["transfer", "burn", "invoke_contract", "deploy_contract", "multisig"];
  const rawType = c.req.query("type") ?? "";
  const type = TX_TYPES.includes(rawType) ? rawType : "";
  const result = c.req.query("result") === "ok" || c.req.query("result") === "fail" ? c.req.query("result")! : "";
  const db = c.env.DB;
  const srt = srvSort((n) => c.req.query(n), TX_COLS, "block", "hash", (s) => {
    const p = new URLSearchParams();
    if (type) p.set("type", type);
    if (result) p.set("result", result);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/transactions?${q}` : "/transactions";
  });

  let rows: Record<string, unknown>[] = [];
  let total = 0;
  try {
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (type) { conds.push("tx_type = ?"); binds.push(type); }
    if (result === "ok") { conds.push("result = ?"); binds.push("ok"); }
    if (result === "fail") { conds.push("result IS NOT NULL AND result <> ?"); binds.push("ok"); }
    const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
    total = await db.prepare(`SELECT COUNT(*) AS n FROM tx_index ${where}`).bind(...binds).first<{ n: number }>().then((r) => r?.n ?? 0);
    rows = await db.prepare(`SELECT * FROM tx_index ${where} ORDER BY ${srt.order} LIMIT ? OFFSET ?`)
      .bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* db not ready */ }
  const hasMore = rows.length > PAGE_SIZE;
  rows = rows.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fActive = !!type || !!result;
  const fFields = `
    ${filterField("Transaction type", `<select name="type">${selectOpts(TX_TYPES, type, "all types")}</select>`)}
    ${filterField("Result", `<select name="result"><option value=""${result === "" ? " selected" : ""}>any result</option><option value="ok"${result === "ok" ? " selected" : ""}>executed ok</option><option value="fail"${result === "fail" ? " selected" : ""}>failed</option></select>`)}
  `;
  const fPop = filterPop("f-txs", "/transactions", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/transactions${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((t) => `<tr>
        <td><a class="mono" href="/tx/${t.hash}">${shortHash(t.hash as string)}</a></td>
        <td><a href="/block/${t.block_topo}"><span class="mint">${fmtInt(t.block_topo as number)}</span></a></td>
        <td>${fmtTime(t.ts as number)}</td>
        <td><span class="badge ${t.tx_type}">${t.tx_type as string}</span></td>
        <td><a class="mono" href="/account/${t.sender}">${shortHash(t.sender as string, 8)}</a>${entityTag(t.sender as string)}</td>
        <td class="num">${atomic(t.fee as number, 6)}</td>
        <td>${resultBadge(t.result)}</td>
      </tr>`).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No indexed transactions yet — backfill pending.</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Transactions <span style="color:var(--text-dim)">${fmtInt(total)} total</span></h2>
      ${filterButton("f-txs", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th>Hash</th>${srt.th("block", "Block")}${srt.th("time", "Time")}${srt.th("type", "Type")}${srt.th("sender", "Sender")}${srt.th("fee", "Fee (XEL)", true)}${srt.th("result", "Result")}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;
  return c.html(layout("Transactions", content, "/transactions"));
});

pages.get("/tx/:hash", async (c) => {
  const hash = c.req.param("hash");
  const db = c.env.DB;
  const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
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
      const { rpc } = await import("./xelis");
      const t = await rpc<Record<string, unknown>>("get_transaction", { hash }, c.env.XELIS_NODE);
      if (t) {
        const data = (t.data ?? {}) as Record<string, unknown>;
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
          </div>
        </div>`;

        const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
          <tr><td>Type</td><td><span class="badge ${type.toLowerCase()}">${type}</span></td></tr>
          <tr><td>Sender</td><td>${source ? `<a class="mono" href="/account/${esc(source)}">${shortHash(source, 10)}</a>${entityTag(source)} <button class="copybtn" type="button" onclick="blkCopy('${esc(source)}', this)">copy</button>` : "—"}</td></tr>
          <tr><td>Block</td><td>${blockTopo > 0 ? `<a href="/block/${blockTopo}"><span class="mint">#${fmtInt(blockTopo)}</span></a>` : blockHash ? `<a class="mono" href="/block/${esc(blockHash)}">${shortHash(blockHash, 10)}</a>` : '<span class="badge">unconfirmed</span>'}</td></tr>
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

  const conf = maxTopo !== null && topo > 0 ? fmtInt(Math.max(0, maxTopo - topo)) : "—";
  const otherInBlock = blockTxCount !== null ? Math.max(0, blockTxCount - 1) : null;
  const hasResult = tx.result !== null && tx.result !== undefined && tx.result !== "";
  const blockSub = otherInBlock === null ? ""
    : otherInBlock === 0 ? "only tx in block"
    : `${fmtInt(otherInBlock)} other tx${otherInBlock === 1 ? "" : "s"} in block`;

  const fifthCard = contractId
    ? statCard("Gas", gas || maxGas ? fmtInt(gas || maxGas) : "—", "contract execution")
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
    <tr><td>Timestamp</td><td>${fmtTime(ts)}</td></tr>
    <tr><td>Age</td><td>${ago(ts)}</td></tr>
    <tr><td>Version</td><td>v${num(tx.version)}</td></tr>
    <tr><td>Privacy</td><td><span class="badge priv">encrypted</span> <span style="color:var(--text-dim)">amounts &amp; receivers hidden</span></td></tr>
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
      <span>Xelis is private by design: transfer amounts, receivers and balances are encrypted for everyone — including this explorer. This page shows only the public metadata indexed from the chain.</span>
    </div>
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`TX ${shortHash(hash, 8)}`, content, "/transactions"));
});

// ---------- account ----------

pages.get("/account/:address", async (c) => {
  const address = c.req.param("address");
  const db = c.env.DB;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

  let acct: Record<string, unknown> | undefined;
  let txs: Record<string, unknown>[] = [];
  let agg: Record<string, unknown> | null = null;
  let types: Record<string, unknown>[] = [];
  let mined = 0;
  let minedAll = 0;
  let maxTopo: number | null = null;
  try {
    acct = (await db.prepare("SELECT * FROM accounts WHERE address = ?").bind(address).first()) ?? undefined;
    txs = await db.prepare("SELECT * FROM tx_index WHERE sender = ? ORDER BY block_topo DESC LIMIT 25")
      .bind(address).all<Record<string, unknown>>().then((r) => r.results ?? []);
    agg = await db.prepare(
      `SELECT COUNT(*) c, SUM(fee) fees, AVG(fee) avg_fee, MIN(ts) first_tx, MAX(ts) last_tx,
              SUM(encrypted) enc, SUM(CASE WHEN result = 'ok' THEN 1 ELSE 0 END) ok
       FROM tx_index WHERE sender = ?`
    ).bind(address).first();
    types = await db.prepare(
      "SELECT tx_type, COUNT(*) c FROM tx_index WHERE sender = ? GROUP BY tx_type ORDER BY c DESC"
    ).bind(address).all<Record<string, unknown>>().then((r) => r.results ?? []);
    mined = await db.prepare("SELECT COUNT(*) AS c FROM blocks WHERE miner_address = ?").bind(address)
      .first<{ c: number }>().then((r) => r?.c ?? 0);
    minedAll = await db.prepare("SELECT SUM(blocks_found) AS c FROM daily_miners WHERE address = ?").bind(address)
      .first<{ c: number | null }>().then((r) => Number(r?.c) || 0);
    maxTopo = (await db.prepare("SELECT MAX(topoheight) AS m FROM blocks").first<{ m: number | null }>())?.m ?? null;
  } catch { /* db not ready */ }

  const txCount = n(acct?.tx_count) || n(agg?.c);
  const fees = n(agg?.fees);
  const avgFee = n(agg?.avg_fee);
  const firstTx = n(agg?.first_tx);
  const lastTx = n(agg?.last_tx);
  const firstSeen = n(acct?.first_seen) || firstTx;
  const lastActive = n(acct?.last_active) || lastTx;
  const okCount = n(agg?.ok);
  const encCount = n(agg?.enc);
  const okPct = txCount > 0 ? (okCount / txCount) * 100 : null;
  const minedTotal = minedAll > 0 ? minedAll : mined;

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
        <h2 class="blk-title">Account <span class="mint mono" style="font-size:0.72em">${shortHash(address, 10)}</span></h2>
        <div class="blk-meta">
          ${entityBadge}
          ${txCount > 0 ? `<span class="badge">${fmtInt(txCount)} sent tx${txCount === 1 ? "" : "s"}</span>` : '<span class="badge">no observed activity</span>'}
          ${minedTotal > 0 ? `<span class="badge ok">miner</span>` : ""}
          <span class="blk-when">${lastActive ? `last active ${ago(lastActive)}` : "never observed"}</span>
        </div>
        <div class="hash-row">
          <span class="hashline mono">${esc(address)}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${esc(address)}', this)">copy</button>
        </div>
      </div>
      <div class="blk-nav">
        ${minedTotal > 0 ? `<a class="btn ghost" href="/miner/${esc(address)}" title="Mining profile for this address">Miner ›</a>` : ""}
        <a class="btn ghost" href="/accounts" title="All observed accounts">Accounts ›</a>
      </div>
    </div>
    <div class="cards blk-cards">
      ${statCard("Sent Txs", txCount > 0 ? fmtInt(txCount) : "—", txCount > 0 ? "observed since indexing" : "no sends indexed")}
      ${statCard("Fees Paid", txCount > 0 ? `${atomic(fees, 4)} XEL` : "—", avgFee > 0 ? `avg ${atomic(avgFee, 6)} / tx` : "public metadata only")}
      ${statCard("First Seen", firstSeen ? fmtTime(firstSeen) : "—", firstSeen ? ago(firstSeen) : "not in indexed data")}
      ${statCard("Last Active", lastActive ? ago(lastActive) : "—", lastActive ? fmtTime(lastActive) : "")}
      ${statCard("Blocks Mined", minedTotal > 0 ? fmtInt(minedTotal) : "—", minedTotal > 0 ? (minedAll > 0 ? "all-time rollups" : "indexed window") : "payment-only account")}
    </div>
  </div>`;

  const overview = `<div class="panel"><h2>Overview</h2><table class="kv">
    <tr><td>Address</td><td><span class="mono">${esc(address)}</span> <button class="copybtn" type="button" onclick="blkCopy('${esc(address)}', this)">copy</button></td></tr>
    <tr><td>Label</td><td>${labelValue}</td></tr>
    <tr><td>First seen</td><td>${firstSeen ? fmtTime(firstSeen) : "—"}</td></tr>
    <tr><td>Last active</td><td>${lastActive ? `${fmtTime(lastActive)} (${ago(lastActive)})` : "—"}</td></tr>
    <tr><td>Observed sent txs</td><td>${txCount > 0 ? fmtInt(txCount) : "—"}</td></tr>
  </table></div>`;

  const typeRows = types.length
    ? types.map((t) => {
        const type = esc(t.tx_type ?? "other");
        const cnt = n(t.c);
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
      ${maxTopo !== null && lastTx ? `<tr><td>Confirmations</td><td>${fmtInt(Math.max(0, maxTopo - n(txs[0]?.block_topo)))} <span style="color:var(--text-dim)">since last send</span></td></tr>` : ""}
    </table>
  </div>`;

  const txRows = txs.length
    ? txs.map((t) => {
        const hash = String(t.hash ?? "");
        const result = t.result ? String(t.result) : "";
        return `<tr>
          <td><a class="mono" href="/tx/${esc(hash)}">${shortHash(hash, 10)}</a></td>
          <td><a href="/block/${n(t.block_topo)}"><span class="mint">${fmtInt(n(t.block_topo))}</span></a></td>
          <td>${fmtTime(n(t.ts))}</td>
          <td><span class="badge ${esc(t.tx_type ?? "other")}">${esc(t.tx_type ?? "other")}</span></td>
          ${result ? `<td><span class="badge ${result === "ok" ? "ok" : "fail"}">${esc(result)}</span></td>` : '<td><span style="color:var(--text-dim)">—</span></td>'}
          <td class="num">${atomic(n(t.fee), 6)}</td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" style="color:var(--text-dim)">No indexed transactions from this address (backfill pending or address inactive).</td></tr>`;

  const history = `<div class="panel"><h2>History ${txs.length ? `<span style="color:var(--text-dim)">latest ${fmtInt(txs.length)}</span>` : ""}</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Hash</th><th>Block</th><th>Time</th><th>Type</th><th>Result</th><th class="num">Fee (XEL)</th></tr></thead>
      <tbody>${txRows}</tbody>
    </table></div>
  </div>`;

  const content = `${hero}
    <div class="grid-2">${overview}${activity}</div>
    ${history}
    <div class="tx-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Sender-observation page: shows this address's publicly visible sending activity. Xelis balances, transfer amounts and receivers are encrypted and never shown.</span>
    </div>
    <script>${blkCopyScript}</script>`;
  return c.html(layout(`Account ${shortHash(address, 6)}`, content, ""));
});

// ---------- market page ----------

pages.get("/market", async (c) => {
  const content = `
    <div class="panel"><h2>XEL Markets</h2>
      <div id="market-cards" class="cards">${Array.from({ length: 5 }, () =>
        '<div class="card sk-card"><span class="sk-bar sk-cl"></span><span class="sk-bar sk-cv"></span></div>').join("")}</div>
      <div class="tablewrap"><table id="market-table">
        <thead><tr><th>Exchange</th><th>Market</th><th class="num">Last</th><th class="num">24h %</th><th class="num">High</th><th class="num">Low</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Vol (XEL)</th><th class="num">Vol (USDT)</th><th>Updated</th></tr></thead>
        <tbody>${Array.from({ length: 6 }, (_, i) =>
          `<tr class="sk-tr"><td colspan="11"><div class="sk-row"><span class="sk-bar sk-c1"></span><span class="sk-bar sk-c2" style="width:${i % 2 ? 9 : 13}%"></span></div></td></tr>`).join("")}</tbody>
      </table></div>
      <h3 class="sub-h">Volume share</h3>
      <div id="market-volshare" class="volshare"></div>
      <div id="market-volshare-legend" class="volshare-legend"></div>
    </div>
    <div class="panel"><h2>Price history</h2><div id="u-price-history" style="min-height:260px"><div class="w-skel sk-chart">${[42, 66, 38, 74, 55, 84, 61, 90, 70, 52, 78, 46].map((h) => `<span class="sk-bar sk-col" style="height:${h}%"></span>`).join("")}</div></div></div>`;
  return c.html(layout("Market", content, "/market"));
});

// ---------- miners ----------

pages.get("/miners", async (c) => {
  const period = c.req.query("period") ?? "day";
  const date = c.req.query("date") ?? "";
  const db = c.env.DB;
  const srt = srvSort((n) => c.req.query(n), TOP_COLS.miners, "blocks", "address", (s) => {
    const p = new URLSearchParams();
    p.set("period", period);
    if (date) p.set("date", date);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `/miners?${q}` : "/miners";
  });

  // Day views anchor on the latest day that actually has data so the
  // leaderboard stays populated while live indexing lags behind "today".
  let resolvedDay = "";
  const latestDay = async (): Promise<string> => {
    if (resolvedDay) return resolvedDay;
    const row = await db.prepare(
      "SELECT COALESCE((SELECT MAX(date) FROM daily_miners), (SELECT date(MAX(ts)/1000,'unixepoch') FROM blocks), date('now')) AS d"
    ).first<{ d: string }>();
    resolvedDay = row?.d ?? new Date().toISOString().slice(0, 10);
    return resolvedDay;
  };

  let rows: Record<string, unknown>[] = [];
  try {
    if (period === "all") {
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners GROUP BY address ORDER BY ${srt.order} LIMIT 50`)
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    } else if (period === "month") {
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners WHERE date LIKE ? || '%' GROUP BY address ORDER BY ${srt.order} LIMIT 50`)
        .bind(date || new Date().toISOString().slice(0, 7))
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    } else if (period === "week") {
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners WHERE date > date(?, '-7 days') GROUP BY address ORDER BY ${srt.order} LIMIT 50`)
        .bind(date || new Date().toISOString().slice(0, 10))
        .all<Record<string, unknown>>().then((r) => r.results ?? []);
    } else {
      const day = date || await latestDay();
      rows = await db.prepare(`SELECT address, SUM(blocks_found) blocks, SUM(rewards_earned) rewards
        FROM daily_miners WHERE date = ? GROUP BY address ORDER BY ${srt.order} LIMIT 50`)
        .bind(day).all<Record<string, unknown>>().then((r) => r.results ?? []);
    }
    // fallback: derive from the blocks table when daily rollups have no rows yet
    if (!rows.length) {
      const conds: string[] = ["miner_address != ''"];
      const args: unknown[] = [];
      if (date) { conds.push("date(ts/1000,'unixepoch') = ?"); args.push(date); }
      else if (period === "day") { conds.push("date(ts/1000,'unixepoch') = ?"); args.push(await latestDay()); }
      else if (period === "week") { conds.push("ts > ?"); args.push(Date.now() - 7 * 86400_000); }
      else if (period === "month") { conds.push("ts > ?"); args.push(Date.now() - 30 * 86400_000); }
      rows = await db.prepare(`SELECT miner_address address, COUNT(*) blocks, SUM(miner_reward) rewards
        FROM blocks WHERE ${conds.join(" AND ")} GROUP BY miner_address ORDER BY ${srt.order} LIMIT 50`)
        .bind(...args).all<Record<string, unknown>>().then((r) => r.results ?? []).catch(() => []);
    }
  } catch { /* db not ready */ }

  const dateHint = period === "month" ? "YYYY-MM" : period === "day" || period === "week" ? "YYYY-MM-DD" : "";

  const periodOpts = ["day", "week", "month", "all"].map((p) =>
    `<option value="${p}" ${period === p ? "selected" : ""}>${p}</option>`).join("");

  const body = rows.length
    ? rows.map((r, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td><a class="mono" href="/miner/${r.address}">${shortHash(r.address as string, 10)}</a>${entityTag(r.address as string)}</td>
        <td class="num">${fmtInt(r.blocks as number)}</td>
        <td class="num">${fmt((r.rewards as number) / 1e8)}</td>
      </tr>`).join("")
    : `<tr><td colspan="4" style="color:var(--text-dim)">No indexed miners yet — backfill pending.</td></tr>`;

  const fActive = period !== "day" || !!date;
  const fFields = `
    ${filterField("Period", `<select name="period">${periodOpts}</select>`)}
    ${dateHint ? filterField(`Anchor date <span class="f-hint">(${dateHint})</span>`, `<input type="text" name="date" data-datepicker placeholder="${dateHint}" value="${date || (period === "day" ? resolvedDay : "")}" />`) : ""}
  `;
  const fPop = filterPop("f-miners", "/miners", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/miners${srt.qs ? `?${srt.qs}` : ""}`,
  });

const content = `<div class="panel">
    <div class="panel-head">
      <h2>Miner leaderboard</h2>
      ${filterButton("f-miners", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr><th class="num">#</th>${srt.th("address", "Miner")}${srt.th("blocks", "Blocks", true)}${srt.th("rewards", "Rewards (XEL)", true)}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </div>`;
  return c.html(layout("Miners", content, "/miners"));
});

// ---------- miner detail ----------

interface MinerTotals {
  blocks: number;
  rewards: number;
}
interface MinerPeriod extends MinerTotals {
  label: string;
  share: number | null;
}
interface MinerChartPoint { date: string; value: number }

pages.get("/miner/:address", async (c) => {
  const address = c.req.param("address");
  const addr = esc(address);
  const db = c.env.DB;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

  const DAY = 86400_000;
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const anchorDay = (d: string | null | undefined): string => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today);

  let acct: Record<string, unknown> | undefined;
  let anchor = today;
  let dailyMiner: Record<string, unknown> | null = null;
  let dailyNet: Record<string, unknown> | null = null;
  let winMiner: Record<string, unknown> | null = null;
  let winNet: Record<string, unknown> | null = null;
  let allTime: Record<string, unknown> | null = null;
  let hash24: Record<string, unknown> | null = null;
  let seriesRows: Record<string, unknown>[] = [];
  let recent: Record<string, unknown>[] = [];
  let rank: number | null = null;
  let totalMiners: number | null = null;

  const winAgg = `SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) b1,
      SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) b7,
      SUM(CASE WHEN ts > ? THEN 1 ELSE 0 END) b30,
      COUNT(*) ball,
      SUM(CASE WHEN ts > ? THEN miner_reward ELSE 0 END) r1,
      SUM(CASE WHEN ts > ? THEN miner_reward ELSE 0 END) r7,
      SUM(CASE WHEN ts > ? THEN miner_reward ELSE 0 END) r30,
      SUM(miner_reward) rall`;
  const dayAgg = `SUM(CASE WHEN date = ? THEN blocks_found ELSE 0 END) b1,
      SUM(CASE WHEN date > date(?, '-7 days') THEN blocks_found ELSE 0 END) b7,
      SUM(CASE WHEN date > date(?, '-30 days') THEN blocks_found ELSE 0 END) b30,
      SUM(blocks_found) ball,
      SUM(CASE WHEN date = ? THEN rewards_earned ELSE 0 END) r1,
      SUM(CASE WHEN date > date(?, '-7 days') THEN rewards_earned ELSE 0 END) r7,
      SUM(CASE WHEN date > date(?, '-30 days') THEN rewards_earned ELSE 0 END) r30,
      SUM(rewards_earned) rall`;

  try {
    acct = (await db.prepare("SELECT label, first_seen, last_active, tx_count FROM accounts WHERE address = ?")
      .bind(address).first()) ?? undefined;
    const a = await db.prepare("SELECT MAX(date) AS d FROM daily_miners").first<{ d: string | null }>();
    anchor = anchorDay(a?.d);

    dailyMiner = await db.prepare(
      `SELECT ${dayAgg}, MIN(date) d0, MAX(date) d1 FROM daily_miners WHERE address = ?`
    ).bind(anchor, anchor, anchor, anchor, anchor, anchor, address).first();
    dailyNet = await db.prepare(
      `SELECT ${dayAgg} FROM daily_miners`
    ).bind(anchor, anchor, anchor, anchor, anchor, anchor).first();

    winMiner = await db.prepare(
      `SELECT ${winAgg} FROM blocks WHERE miner_address = ?`
    ).bind(now - DAY, now - 7 * DAY, now - 30 * DAY, now - DAY, now - 7 * DAY, now - 30 * DAY, address).first();
    winNet = await db.prepare(
      `SELECT ${winAgg} FROM blocks`
    ).bind(now - DAY, now - 7 * DAY, now - 30 * DAY, now - DAY, now - 7 * DAY, now - 30 * DAY).first();

    allTime = await db.prepare(
      "SELECT COUNT(*) c, SUM(miner_reward) r, MIN(ts) f, MAX(ts) l FROM blocks WHERE miner_address = ?"
    ).bind(address).first();
    hash24 = await db.prepare(
      "SELECT AVG(difficulty) ad, COUNT(*) c FROM blocks WHERE miner_address = ? AND ts > ?"
    ).bind(address, now - DAY).first();
    recent = await db.prepare(
      `SELECT topoheight, hash, ts, tx_count, difficulty, miner_reward, block_type
       FROM blocks WHERE miner_address = ? ORDER BY topoheight DESC LIMIT 25`
    ).bind(address).all<Record<string, unknown>>().then((r) => r.results ?? []);
    seriesRows = await db.prepare(
      `SELECT date, blocks_found, rewards_earned FROM daily_miners
       WHERE address = ? AND date > date(?, '-90 days') ORDER BY date DESC LIMIT 90`
    ).bind(address, anchor).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* db not ready — page falls back to empty state */ }

  const dailyBlocks = n(dailyMiner?.ball);
  const dailyRewards = n(dailyMiner?.rall);
  const blockCount = n(allTime?.c);
  const useDaily = dailyBlocks > 0;
  const isMiner = useDaily || blockCount > 0;

  const copyNote = `<script>${blkCopyScript}</script>`;
  const lockNote = `<div class="tx-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Mining data is public on-chain: block production, rewards and difficulty are indexed here. Balances, transfers and receivers remain encrypted and are never inferred.</span>
    </div>`;

  if (!isMiner) {
    const acctKv = acct
      ? [
            ...[["Label", entityTag(address).trim() || '<span style="color:var(--text-dim)">—</span>']],
            ["First seen", fmtTime(n(acct.first_seen))],
            ["Last active", `${fmtTime(n(acct.last_active))} (${ago(n(acct.last_active))})`],
            ["Observed sent txs", fmtInt(n(acct.tx_count))],
          ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")
      : "";
    const content = `<div class="panel blk-hero">
      <div class="blk-head">
        <div class="blk-id">
          <h2 class="blk-title">Miner <span class="mint mono" style="font-size:0.72em">${shortHash(address, 10)}</span></h2>
          <div class="blk-meta">
            ${entityTag(address)}
            <span class="badge">no mining activity</span>
            <span class="blk-when">address has not been observed producing blocks</span>
          </div>
          <div class="hash-row">
            <span class="hashline mono">${addr}</span>
            <button class="copybtn" type="button" onclick="blkCopy('${addr}', this)">copy</button>
          </div>
        </div>
        <div class="blk-nav"><a class="btn ghost" href="/account/${addr}" title="Sender activity for this address">Account ›</a></div>
      </div>
    </div>
    <div class="panel"><h2>No Mining Activity</h2>
      <p style="color:var(--text-dim)">No blocks indexed for this address. It may be a regular sender account, or it mined before the indexed window/backfill covered this period.</p>
      ${acct ? `<table class="kv">${acctKv}</table>` : ""}
      <p style="margin-top:1rem"><a class="btn ghost" href="/miners">Back to miner leaderboard →</a></p>
    </div>
    ${copyNote}`;
    return c.html(layout(`Miner ${shortHash(address, 8)}`, content, "/miners"));
  }

  // ---- period breakdown (daily rollups preferred, recent blocks as fallback) ----
  const share = (b: number, net: number): number | null => (net > 0 ? (b / net) * 100 : null);
  const periods: MinerPeriod[] = useDaily
    ? [
        { label: "Last day", blocks: n(dailyMiner?.b1), rewards: n(dailyMiner?.r1), share: share(n(dailyMiner?.b1), n(dailyNet?.b1)) },
        { label: "Last 7 days", blocks: n(dailyMiner?.b7), rewards: n(dailyMiner?.r7), share: share(n(dailyMiner?.b7), n(dailyNet?.b7)) },
        { label: "Last 30 days", blocks: n(dailyMiner?.b30), rewards: n(dailyMiner?.r30), share: share(n(dailyMiner?.b30), n(dailyNet?.b30)) },
        { label: "All-time", blocks: dailyBlocks, rewards: dailyRewards, share: share(dailyBlocks, n(dailyNet?.ball)) },
      ]
    : [
        { label: "Last 24h", blocks: n(winMiner?.b1), rewards: n(winMiner?.r1), share: share(n(winMiner?.b1), n(winNet?.b1)) },
        { label: "Last 7 days", blocks: n(winMiner?.b7), rewards: n(winMiner?.r7), share: share(n(winMiner?.b7), n(winNet?.b7)) },
        { label: "Last 30 days", blocks: n(winMiner?.b30), rewards: n(winMiner?.r30), share: share(n(winMiner?.b30), n(winNet?.b30)) },
        { label: "Indexed window", blocks: n(winMiner?.ball), rewards: n(winMiner?.rall), share: share(n(winMiner?.ball), n(winNet?.ball)) },
      ];
  const share30 = periods[2].share;
  const totals: MinerTotals = useDaily
    ? { blocks: dailyBlocks, rewards: dailyRewards }
    : { blocks: n(winMiner?.ball), rewards: n(winMiner?.rall) };

  // ---- all-time rank among observed miners ----
  try {
    if (useDaily) {
      const r = await db.prepare(
        "SELECT COUNT(*) AS ahead FROM (SELECT address, SUM(blocks_found) s FROM daily_miners GROUP BY address) WHERE s > ?"
      ).bind(totals.blocks).first<{ ahead: number }>();
      const t = await db.prepare("SELECT COUNT(*) AS n FROM (SELECT address FROM daily_miners GROUP BY address)").first<{ n: number }>();
      rank = n(r?.ahead) + 1;
      totalMiners = n(t?.n);
    } else if (blockCount > 0) {
      const r = await db.prepare(
        "SELECT COUNT(*) AS ahead FROM (SELECT COUNT(*) c FROM blocks WHERE miner_address != '' GROUP BY miner_address) WHERE c > ?"
      ).bind(blockCount).first<{ ahead: number }>();
      const t = await db.prepare(
        "SELECT COUNT(*) AS n FROM (SELECT miner_address FROM blocks WHERE miner_address != '' GROUP BY miner_address)"
      ).first<{ n: number }>();
      rank = n(r?.ahead) + 1;
      totalMiners = n(t?.n);
    }
  } catch { /* rank unavailable */ }

  // ---- daily series for charts (last 90 days) ----
  let series: { date: string; blocks: number; rewards: number }[] = seriesRows
    .map((r) => ({ date: String(r.date ?? ""), blocks: n(r.blocks_found), rewards: n(r.rewards_earned) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .reverse();
  if (!series.length) {
    try {
      const rows = await db.prepare(
        `SELECT date(ts/1000,'unixepoch') date, COUNT(*) b, SUM(miner_reward) r
         FROM blocks WHERE miner_address = ? AND ts > ? GROUP BY 1 ORDER BY 1`
      ).bind(address, now - 90 * DAY).all<Record<string, unknown>>().then((r) => r.results ?? []);
      series = rows.map((r) => ({ date: String(r.date ?? ""), blocks: n(r.b), rewards: n(r.r) }))
        .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
    } catch { /* series unavailable */ }
  }
  const seriesBlocks: MinerChartPoint[] = series.map((p) => ({ date: p.date, value: p.blocks }));
  const seriesRewards: MinerChartPoint[] = series.map((p) => ({ date: p.date, value: p.rewards / 1e8 }));
  const hasSeries = seriesBlocks.some((p) => p.value > 0) || seriesRewards.some((p) => p.value > 0);

  const hashRate = n(hash24?.ad) > 0 && n(hash24?.c) > 0 ? (n(hash24?.ad) * n(hash24?.c)) / 86400 : null;
  const lastBlock = recent[0];
  const lastTopo = lastBlock ? n(lastBlock.topoheight) : null;
  const lastTs = lastBlock ? n(lastBlock.ts) : (dailyMiner?.d1 ? Date.parse(String(dailyMiner.d1) + "T00:00:00Z") : null);
  const sinceLabel = useDaily
    ? (dailyMiner?.d0 ? `since ${String(dailyMiner.d0)}` : "")
    : (allTime?.f ? `since ${fmtTime(n(allTime.f)).slice(0, 10)}` : "");
  const blocksSub = useDaily
    ? `all-time${sinceLabel ? ` · ${sinceLabel}` : ""}`
    : `indexed window${sinceLabel ? ` · ${sinceLabel}` : ""}`;
  const sourceNote = useDaily
    ? `Daily miner rollups anchored on ${anchor}.`
    : "No daily rollups for this address yet — period figures come from the indexed block window only.";

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Miner <span class="mint mono" style="font-size:0.72em">${shortHash(address, 10)}</span></h2>
        <div class="blk-meta">
          ${rank !== null ? `<span class="badge rank">Rank #${fmtInt(rank)}${totalMiners ? ` of ${fmtInt(totalMiners)}` : ""}</span>` : ""}
          ${share30 !== null ? `<span class="badge">${share30.toFixed(1)}% of blocks · 30d</span>` : ""}
          ${entityTag(address)}
          <span class="blk-when">${lastTs ? `last block ${ago(lastTs)}` : "no recent blocks in window"}</span>
        </div>
        <div class="hash-row">
          <span class="hashline mono">${addr}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${addr}', this)">copy</button>
        </div>
      </div>
      <div class="blk-nav">
        <a class="btn ghost" href="/account/${addr}" title="Sender activity for this address">Account ›</a>
        <a class="btn ghost" href="/miners" title="Miner leaderboard">Leaderboard ›</a>
      </div>
    </div>
    ${share30 !== null ? `<div class="miner-share" title="Share of blocks produced in the last 30 days">
      <span class="ms-label">Share of blocks · 30d</span>
      <div class="rewardbar"><div class="seg miner" style="width:${Math.min(100, share30).toFixed(2)}%"></div></div>
      <span class="ms-label">${share30.toFixed(2)}%</span>
    </div>` : ""}
    <div class="cards blk-cards">
      ${statCard("Blocks Found", fmtInt(totals.blocks), blocksSub)}
      ${statCard("Rewards Earned", `${atomic(totals.rewards)} XEL`, "miner rewards only · dev reward excluded")}
      ${statCard("Network Share", share30 !== null ? `${share30.toFixed(2)}%` : "—", "of all blocks · 30d")}
      ${statCard("Est. Hashrate", hashRate !== null ? `${fmt(hashRate)} H/s` : "—", "24h · difficulty ÷ time")}
      ${statCard("Last Block", lastTopo !== null ? `<a href="/block/${lastTopo}">#${fmtInt(lastTopo)}</a>` : "—", lastTs ? ago(lastTs) : "not in indexed window")}
    </div>
  </div>`;

  const charts = hasSeries
    ? `<div class="grid-2">
      <div class="panel"><h2>Blocks Mined <span style="color:var(--text-dim)">per day · 90d</span></h2><div id="u-miner-blocks" class="chart" style="min-height:260px"></div></div>
      <div class="panel"><h2>Rewards <span style="color:var(--text-dim)">XEL per day · 90d</span></h2><div id="u-miner-rewards" class="chart" style="min-height:260px"></div></div>
    </div>`
    : `<div class="panel"><h2>Daily Activity</h2><p style="color:var(--text-dim)">No daily activity recorded for this address yet.</p></div>`;

  const periodRows = periods.map((p) => `<tr>
    <td>${p.label}</td>
    <td class="num">${fmtInt(p.blocks)}</td>
    <td class="num">${atomic(p.rewards)}</td>
    <td class="num">${p.share !== null ? `${p.share.toFixed(2)}%` : "—"}</td>
  </tr>`).join("");

  const breakdown = `<div class="panel"><h2>Activity by Period</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Period</th><th class="num">Blocks</th><th class="num">Rewards (XEL)</th><th class="num">Network share</th></tr></thead>
      <tbody>${periodRows}</tbody>
    </table></div>
    <p style="color:var(--text-dim);font-size:1.15rem;margin-top:0.8rem">${sourceNote}</p>
  </div>`;

  const acctRows = acct
    ? [
        ["Label", acct.label ? esc(acct.label) : "—"],
        ["First seen", fmtTime(n(acct.first_seen))],
        ["Last active", `${fmtTime(n(acct.last_active))} (${ago(n(acct.last_active))})`],
        ["Observed sent txs", fmtInt(n(acct.tx_count))],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")
    : "";
  const account = `<div class="panel"><h2>Sender Activity</h2>
    ${acct
      ? `<table class="kv">${acctRows}</table>`
      : `<p style="color:var(--text-dim)">This address has not been observed sending transactions in the indexed data — miners can stay payment-only for a long time.</p>`}
    <p style="margin-top:1rem"><a href="/account/${addr}">Full account page →</a></p>
  </div>`;

  const blockRows = recent.length
    ? recent.map((b) => {
        const topo = n(b.topoheight);
        const type = esc(b.block_type ?? "normal");
        const hash = String(b.hash ?? "");
        return `<tr>
          <td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>
          <td><a class="mono" href="/block/${esc(hash)}">${shortHash(hash, 10)}</a></td>
          <td>${fmtTime(n(b.ts))}</td>
          <td class="num">${fmtInt(n(b.tx_count))}</td>
          <td class="num">${fmt(n(b.difficulty))}</td>
          <td class="num">${atomic(n(b.miner_reward))}</td>
          <td><span class="badge ${type.toLowerCase()}">${type}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">No blocks mined by this address inside the indexed window.</td></tr>`;
  const blocksPanel = `<div class="panel"><h2>Recent Blocks Mined ${recent.length ? `<span style="color:var(--text-dim)">latest ${fmtInt(recent.length)}</span>` : ""}</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>Block</th><th>Hash</th><th>Time</th><th class="num">Txs</th><th class="num">Difficulty</th><th class="num">Reward (XEL)</th><th>Type</th></tr></thead>
      <tbody>${blockRows}</tbody>
    </table></div>
  </div>`;

  const seriesJson = JSON.stringify({ blocks: seriesBlocks, rewards: seriesRewards }).replace(/</g, "\\u003c");
  const content = `${hero}
    ${charts}
    <div class="grid-2">${breakdown}${account}</div>
    ${blocksPanel}
    ${lockNote}
    ${copyNote}
    ${hasSeries ? `<script type="application/json" id="miner-series">${seriesJson}</script>` : ""}`;
  return c.html(layout(`Miner ${shortHash(address, 8)}`, content, "/miners"));
});

// ---------- charts hub ----------

// metrics with special filters
const FEE_METRICS: Record<string, string> = { fees: "avg", "fees-median": "median", "fee-p90": "p90", "fees-p99": "p99" };
const MARKET_METRICS = new Set(["price", "quote-volume"]);

pages.get("/charts", async (c) => {
  const metric = c.req.query("metric") ?? "txs";
  const range = c.req.query("range") ?? "90d";
  const interval = c.req.query("interval") ?? "day";
  // strict YYYY-MM-DD validation doubles as HTML-attribute sanitization
  const isDate = (v: string | undefined) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDate(c.req.query("from")) ? c.req.query("from")! : "";
  const to = isDate(c.req.query("to")) ? c.req.query("to")! : "";
  const custom = range === "custom";
  const cum = c.req.query("cum") === "1";
  const log = c.req.query("log") === "1";
  const chartType = c.req.query("type") === "bar" ? "bar" : "line";

  const metrics: Array<[string, string]> = [
    ["txs", "Transactions/day"], ["accounts", "Accounts growth"], ["miners", "Miners"],
    ["hashrate", "Hashrate"], ["transfers", "Transfers"], ["fees", "Fees"],
    ["supply", "Supply"], ["market-cap", "Market Cap"], ["block-types", "Block types"],
    ["fees-rewards", "Fees vs rewards"], ["decentralization", "Decentralization"],
    ["peers", "Peer count"], ["peers-pruned", "Pruned peers"], ["peers-lagging", "Lagging peers"],
    ["peers-stale", "Stale peers"], ["peers-divergent", "Divergent peers"], ["peer-lag", "Avg peer lag"],
    ["peers-hidden", "Hidden peers"], ["peers-new", "New connections"], ["peer-age", "Connection age"],
    ["peer-view", "Peer visibility"], ["peer-traffic-in", "Peer traffic in"], ["peer-traffic-out", "Peer traffic out"],
  ];
  const metricOpts = metrics.map(([m, name]) => `<option value="${m}" ${metric === m ? "selected" : ""}>${name}</option>`).join("");
  const rangeOpts = ["7d", "30d", "90d", "1y", "all", "custom"].map((r) => `<option value="${r}" ${range === r ? "selected" : ""}>${r === "custom" ? "custom period" : r}</option>`).join("");
  const intervalOpts = ["day", "week", "month", "year"].map((i) => `<option value="${i}" ${interval === i ? "selected" : ""}>${i}</option>`).join("");

  const feeStatOpts = ["fees", "fees-median", "fee-p90", "fees-p99"].map((m) => `<option value="${m}" ${metric === m ? "selected" : ""}>${FEE_METRICS[m]}</option>`).join("");

  const exchangeParam = (c.req.query("exchange") ?? "").replace(/[^\w .-]/g, "").slice(0, 64);
  let exchanges: string[] = [];
  try {
    const rows = await c.env.DB.prepare("SELECT DISTINCT exchange FROM market_snapshots ORDER BY exchange").all<{ exchange: string }>();
    exchanges = (rows.results ?? []).map((r) => r.exchange).filter((e) => e && e.length <= 64);
  } catch { /* db not ready */ }
  const exchange = exchanges.includes(exchangeParam) ? exchangeParam : "";
  const exchangeOpts = ['<option value="">all exchanges</option>', ...exchanges.map((e) => `<option value="${e}" ${exchange === e ? "selected" : ""}>${e}</option>`)].join("");

  const compareParam = c.req.query("compare") ?? "";
  const compare = metrics.some(([m]) => m === compareParam) && compareParam !== metric ? compareParam : "";
  const compareOpts = ['<option value="">no compare</option>', ...metrics.filter(([m]) => m !== metric).map(([m, name]) => `<option value="${m}" ${compare === m ? "selected" : ""}>${name}</option>`)].join("");

  const periodQuery = custom
    ? new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()
    : `range=${range}`;
  const csvQuery = new URLSearchParams(periodQuery);
  csvQuery.set("interval", interval);
  csvQuery.set("format", "csv");
  if (MARKET_METRICS.has(metric) && exchange) csvQuery.set("exchange", exchange);
  const csvHref = `/api/history/${metric}?${csvQuery.toString()}`;

  const content = `
    <div class="panel">
      <div style="display:flex;gap:0.8rem;margin-bottom:1rem;align-items:center;flex-wrap:wrap">
        <select id="sel-metric" title="Metric">${metricOpts}</select>
        <select id="sel-feestat" title="Fee statistic" ${FEE_METRICS[metric] ? "" : "hidden"}>${feeStatOpts}</select>
        <select id="sel-range" title="Period">${rangeOpts}</select>
        <input type="text" class="period" data-datepicker id="inp-from" value="${from}" aria-label="Period start" ${custom ? "" : "hidden"} />
        <span aria-hidden="true" id="period-sep" ${custom ? "" : "hidden"}>→</span>
        <input type="text" class="period" data-datepicker id="inp-to" value="${to}" aria-label="Period end" ${custom ? "" : "hidden"} />
        <select id="sel-interval" title="Bucket interval">${intervalOpts}</select>
        <select id="sel-exchange" title="Exchange" ${MARKET_METRICS.has(metric) ? "" : "hidden"}>${exchangeOpts}</select>
        <select id="sel-compare" title="Overlay a second metric">${compareOpts}</select>
        <label class="chk" title="Show running total instead of per-bucket value"><input type="checkbox" id="chk-cum" ${cum ? "checked" : ""}/> cum</label>
        <label class="chk" title="Logarithmic Y axis"><input type="checkbox" id="chk-log" ${log ? "checked" : ""}/> log</label>
        <select id="sel-type" title="Chart type">
          <option value="line" ${chartType === "line" ? "selected" : ""}>line</option>
          <option value="bar" ${chartType === "bar" ? "selected" : ""}>bar</option>
        </select>
        <a class="btn ghost" id="btn-csv" href="${csvHref}">CSV</a>
      </div>
      <div id="u-chart" style="height:320px"></div>
    </div>`;
  return c.html(layout("Charts", content, "/charts"));
});

// ---------- assets & contracts ----------

pages.get("/assets", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 64);
  const srt = srvSort((n) => c.req.query(n), {
    asset: { sql: "asset_id", def: "asc" },
    name: { sql: "name", def: "asc" },
    symbol: { sql: "symbol", def: "asc" },
    decimals: { sql: "decimals", def: "asc" },
    first: { sql: "first_seen_topo", def: "desc" },
  }, "first", "asset_id", (s) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const qs = p.toString();
    return qs ? `/assets?${qs}` : "/assets";
  });
  let rows: Record<string, unknown>[] = [];
  try {
    const where = q ? "WHERE (name LIKE ? OR symbol LIKE ? OR asset_id LIKE ?)" : "";
    const binds = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
    rows = await c.env.DB.prepare(`SELECT * FROM assets ${where} ORDER BY ${srt.order} LIMIT 100`)
      .bind(...binds).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* table empty or missing */ }

  const fFields = `
    ${filterField("Search", `<input type="text" name="q" placeholder="name, symbol or asset id" value="${esc(q)}" maxlength="64" />`)}
  `;
  const fPop = filterPop("f-assets", "/assets", fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `/assets${srt.qs ? `?${srt.qs}` : ""}`,
  });

  const body = rows.length
    ? rows.map((a) => `<tr>
        <td><span class="mono">${shortHash(a.asset_id as string, 8)}</span></td>
        <td>${(a.name as string) ?? "—"}</td>
        <td>${(a.symbol as string) ?? "—"}</td>
        <td class="num">${fmtInt(a.decimals as number)}</td>
        <td class="num">${fmtInt(a.first_seen_topo as number)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" style="color:var(--text-dim)">No assets indexed yet (populated during tx detail pass).</td></tr>`;

  const content = `<div class="panel">
    <div class="panel-head">
      <h2>Assets <span style="color:var(--text-dim)">showing ${fmtInt(rows.length)} of indexed</span></h2>
      ${filterButton("f-assets", !!q)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
    <thead><tr>${srt.th("asset", "Asset ID")}${srt.th("name", "Name")}${srt.th("symbol", "Symbol")}${srt.th("decimals", "Decimals", true)}${srt.th("first", "First seen (topo)", true)}</tr></thead>
    <tbody>${body}</tbody></table></div></div>`;
  return c.html(layout("Assets", content, "/assets"));
});

pages.get("/contracts", async (c) => {
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

pages.get("/contracts/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const n = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

  let ct: Record<string, unknown> | undefined;
  let invokes: Record<string, unknown>[] = [];
  try {
    ct = (await db.prepare("SELECT * FROM contracts WHERE contract_id = ?").bind(id).first()) ?? undefined;
    invokes = await db.prepare(
      `SELECT hash, block_topo, ts, fee, result, sender FROM tx_index WHERE contract_id = ? ORDER BY block_topo DESC LIMIT 25`
    ).bind(id).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch { /* db not ready */ }

  if (!ct) return c.html(layout("Not found", notFound("Contract"), "/contracts"));

  const invokeCount = n(ct.invoke_count);
  const gasTotal = n(ct.gas_total);
  const deployTopo = n(ct.deploy_topo);
  const deployer = String(ct.deployer ?? "");
  const deployHash = String(ct.contract_id ?? id);
  const lastTs = invokes.length ? n(invokes[0].ts) : null;

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
    ${n(ct.events_count) ? `<tr><td>Events seen</td><td>${fmtInt(ct.events_count as number)}</td></tr>` : ""}
  </table></div>`;

  const invokeRows = invokes.length
    ? invokes.map((t) => {
        const h = String(t.hash ?? "");
        const result = t.result ? String(t.result) : "";
        return `<tr>
          <td><a class="mono" href="/tx/${esc(h)}">${shortHash(h, 12)}</a></td>
          <td><a href="/block/${n(t.block_topo)}"><span class="mint">${fmtInt(n(t.block_topo))}</span></a></td>
          <td>${fmtTime(n(t.ts))}</td>
          <td><a class="mono" href="/account/${esc(t.sender as string)}">${shortHash(t.sender as string, 8)}</a>${entityTag(t.sender as string)}</td>
          <td class="num">${atomic(n(t.fee), 6)}</td>
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

// ---------- assets & contracts nav additions handled in layout ----------

// ---------- search ----------

pages.get("/search/:query", async (c) => {
  const q = decodeURIComponent(c.req.param("query"));
  const db = c.env.DB;
  // heuristic routing
  if (/^\d+$/.test(q)) return c.redirect(`/block/${q}`);
  if (q.startsWith("xel:")) {
    // miner addresses get the mining profile; everyone else the account page
    try {
      const inWindow = await db.prepare("SELECT 1 AS m FROM blocks WHERE miner_address = ? LIMIT 1").bind(q).first();
      const inRollups = inWindow ? null : await db.prepare("SELECT 1 AS m FROM daily_miners WHERE address = ? LIMIT 1").bind(q).first();
      if (inWindow || inRollups) return c.redirect(`/miner/${q}`);
    } catch { /* db not ready */ }
    return c.redirect(`/account/${q}`);
  }
  // try tx hash
  try {
    const tx = await db.prepare("SELECT hash FROM tx_index WHERE hash = ?").bind(q).first();
    if (tx) return c.redirect(`/tx/${q}`);
    const block = await db.prepare("SELECT topoheight FROM blocks WHERE hash = ?").bind(q).first();
    if (block) return c.redirect(`/block/${block.topoheight}`);
    const acct = await db.prepare("SELECT address FROM accounts WHERE address = ?").bind(q).first();
    if (acct) return c.redirect(`/account/${q}`);
    const ct = await db.prepare("SELECT contract_id FROM contracts WHERE contract_id = ?").bind(q).first();
    if (ct) return c.redirect(`/contracts/${q}`);
  } catch { /* db not ready */ }
  return c.html(layout("Search", notFound(`"${q.slice(0, 20)}"`), ""));
});

