import { Hono } from "hono";
import type { Env } from "../app";
import { layout, statCard } from "../../client/layout";
import { icons } from "../../client/icons";
import { fmt, fmtInt, shortHash, fmtTime, ago, atomic } from "../../client/format";
import { srvSort, BLOCK_COLS } from "../sort";
import { filterButton, filterPop, filterField, selectOpts } from "../filters";
import { esc, jsq, entityTag, blkCopyScript, num, PAGE_SIZE, pager, clampInt, logErr } from "./shared";
import { topNRaw, countRaw, mergeAgg } from "../shards";

interface MinerTotals {
  blocks: number;
  rewards: number;
}
interface MinerPeriod extends MinerTotals {
  label: string;
  share: number | null;
}
interface MinerChartPoint { date: string; value: number }

export const minerDetail = new Hono<{ Bindings: Env }>();

minerDetail.get("/miner/:address", async (c) => {
  const address = c.req.param("address");
  const addr = esc(address);
  const db = c.env.DB;

  const DAY = 86400_000;
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const anchorDay = (d: string | null | undefined): string => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today);

  // blocks table: pagination + filters (block type, min txs) + SQL sorting
  const page = clampInt(c.req.query("page"), 1, 100_000);
  const typeRaw = (c.req.query("type") ?? "").toLowerCase();
  const bType = ["normal", "side", "sync"].includes(typeRaw) ? typeRaw[0].toUpperCase() + typeRaw.slice(1) : "";
  const minTxsRaw = Number(c.req.query("min_txs") ?? "");
  const minTxs = Number.isFinite(minTxsRaw) && minTxsRaw > 0 ? Math.floor(minTxsRaw) : 0;
  const basePath = `/miner/${addr}`;
  const srt = srvSort((nm) => c.req.query(nm), BLOCK_COLS, "topo", "topoheight", (s) => {
    const p = new URLSearchParams();
    if (bType) p.set("type", bType);
    if (minTxs) p.set("min_txs", String(minTxs));
    if (s) for (const [k, v] of new URLSearchParams(s)) p.set(k, v);
    const q = p.toString();
    return q ? `${basePath}?${q}` : basePath;
  });

  let acct: Record<string, unknown> | undefined;
  let anchor = today;
  let dailyMiner: Record<string, unknown> | null = null;
  let dailyNet: Record<string, unknown> | null = null;
  let hash24: Record<string, unknown> | null = null;
  let seriesRows: Record<string, unknown>[] = [];
  let lastBlock: Record<string, unknown> | null = null;
  let pageRows: Record<string, unknown>[] = [];
  let filteredTotal: number | null = null;
  let rank: number | null = null;
  let totalMiners: number | null = null;

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

    // SUM(difficulty) instead of AVG: merged in JS as sd/c
    hash24 = await mergeAgg(c.env,
      "SELECT SUM(difficulty) sd, COUNT(*) c FROM blocks WHERE miner_address = ? AND ts > ?",
      [address, now - DAY], { sum: ["sd", "c"] });
    lastBlock = (await topNRaw(c.env, {
      table: "blocks",
      select: "topoheight, ts",
      order: "topoheight DESC",
      limit: 1,
      extra: { sql: "miner_address = ?", binds: [address] },
      floorCol: "topoheight",
    }))[0] ?? null;
    const bconds = ["miner_address = ?"];
    const cbinds: unknown[] = [address];
    if (bType) { bconds.push("UPPER(block_type) = UPPER(?)"); cbinds.push(bType); }
    if (minTxs) { bconds.push("tx_count >= ?"); cbinds.push(minTxs); }
    const bextra = { sql: bconds.join(" AND "), binds: cbinds };
    // unfiltered total reuses the all-time rollup count
    filteredTotal = bconds.length === 1 ? num(dailyMiner?.ball) : await countRaw(c.env, { table: "blocks", extra: bextra, floorCol: "topoheight" });
    pageRows = await topNRaw(c.env, {
      table: "blocks",
      select: "topoheight, hash, ts, tx_count, difficulty, miner_reward, block_type",
      order: srt.order,
      limit: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      extra: bextra,
      floorCol: "topoheight",
    });
    seriesRows = await db.prepare(
      `SELECT date, blocks_found, rewards_earned FROM daily_miners
       WHERE address = ? AND date > date(?, '-90 days') ORDER BY date DESC LIMIT 90`
    ).bind(address, anchor).all<Record<string, unknown>>().then((r) => r.results ?? []);
  } catch (err) { logErr("page/miner", err); }

  const dailyBlocks = num(dailyMiner?.ball);
  const dailyRewards = num(dailyMiner?.rall);
  // a miner is an address with daily rollup rows; raw blocks are never used as
  // a fallback, so an address absent from daily_miners has no mining activity
  const isMiner = dailyBlocks > 0;

  const copyNote = `<script>${blkCopyScript}</script>`;
  const lockNote = `<div class="tx-note">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Mining data is public on-chain: block production, rewards and difficulty are indexed here. Balances, transfers and receivers remain encrypted and are never inferred.</span>
    </div>`;

  if (!isMiner) {
    const acctKv = acct
      ? [
            ...[["Label", entityTag(address).trim() || '<span style="color:var(--text-dim)">—</span>']],
            ["First seen", fmtTime(num(acct.first_seen))],
            ["Last active", `${fmtTime(num(acct.last_active))} (${ago(num(acct.last_active))})`],
            ["Observed sent txs", fmtInt(num(acct.tx_count))],
          ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")
      : "";
    const content = `<div class="panel blk-hero">
      <div class="blk-head">
        <div class="blk-id">
          <h2 class="blk-title">Miner <span class="mint mono" style="font-size:0.72em">${esc(shortHash(address, 10))}</span></h2>
          <div class="blk-meta">
            ${entityTag(address)}
            <span class="badge">no mining activity</span>
            <span class="blk-when">address has not been observed producing blocks</span>
          </div>
          <div class="hash-row">
            <span class="hashline mono">${addr}</span>
            <button class="copybtn" type="button" onclick="blkCopy('${jsq(address)}', this)">copy</button>
          </div>
        </div>
        <div class="blk-nav"><a class="btn ghost" href="/account/${addr}" title="Sender activity for this address">Account ${icons.chevronRight}</a></div>
      </div>
    </div>
    <div class="panel"><h2>No Mining Activity</h2>
      <p style="color:var(--text-dim)">No mining activity indexed for this address. It may be a regular sender account, or it mined before daily rollups began.</p>
      ${acct ? `<table class="kv">${acctKv}</table>` : ""}
      <p style="margin-top:1rem"><a class="btn ghost" href="/miners">Back to miner leaderboard ${icons.arrowRight}</a></p>
    </div>
    ${copyNote}`;
    return c.html(layout(`Miner ${esc(shortHash(address, 8))}`, content, "/miners"));
  }

  // ---- period breakdown from daily rollups ----
  const share = (b: number, net: number): number | null => (net > 0 ? (b / net) * 100 : null);
  const periods: MinerPeriod[] = [
    { label: "Last day", blocks: num(dailyMiner?.b1), rewards: num(dailyMiner?.r1), share: share(num(dailyMiner?.b1), num(dailyNet?.b1)) },
    { label: "Last 7 days", blocks: num(dailyMiner?.b7), rewards: num(dailyMiner?.r7), share: share(num(dailyMiner?.b7), num(dailyNet?.b7)) },
    { label: "Last 30 days", blocks: num(dailyMiner?.b30), rewards: num(dailyMiner?.r30), share: share(num(dailyMiner?.b30), num(dailyNet?.b30)) },
    { label: "All-time", blocks: dailyBlocks, rewards: dailyRewards, share: share(dailyBlocks, num(dailyNet?.ball)) },
  ];
  const share30 = periods[2].share;
  const totals: MinerTotals = { blocks: dailyBlocks, rewards: dailyRewards };

  // ---- all-time rank among observed miners ----
  try {
    const r = await db.prepare(
      "SELECT COUNT(*) AS ahead FROM (SELECT address, SUM(blocks_found) s FROM daily_miners GROUP BY address) WHERE s > ?"
    ).bind(totals.blocks).first<{ ahead: number }>();
    const t = await db.prepare("SELECT COUNT(*) AS n FROM (SELECT address FROM daily_miners GROUP BY address)").first<{ n: number }>();
    rank = num(r?.ahead) + 1;
    totalMiners = num(t?.n);
  } catch { /* rank unavailable */ }

  // ---- daily series for charts (last 90 days) ----
  const series: { date: string; blocks: number; rewards: number }[] = seriesRows
    .map((r) => ({ date: String(r.date ?? ""), blocks: num(r.blocks_found), rewards: num(r.rewards_earned) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .reverse();
  const seriesBlocks: MinerChartPoint[] = series.map((p) => ({ date: p.date, value: p.blocks }));
  const seriesRewards: MinerChartPoint[] = series.map((p) => ({ date: p.date, value: p.rewards / 1e8 }));
  const hasSeries = seriesBlocks.some((p) => p.value > 0) || seriesRewards.some((p) => p.value > 0);

  const hashAvg = num(hash24?.c) > 0 ? num(hash24?.sd) / num(hash24?.c) : 0;
  const hashRate = hashAvg > 0 && num(hash24?.c) > 0 ? (hashAvg * num(hash24?.c)) / 86400 : null;
  const lastTopo = lastBlock ? num(lastBlock.topoheight) : null;
  const lastTs = lastBlock ? num(lastBlock.ts) : (dailyMiner?.d1 ? Date.parse(String(dailyMiner.d1) + "T00:00:00Z") : null);
  const sinceLabel = dailyMiner?.d0 ? `since ${String(dailyMiner.d0)}` : "";
  const blocksSub = `all-time${sinceLabel ? ` · ${sinceLabel}` : ""}`;
  const sourceNote = `Daily miner rollups anchored on ${anchor}.`;

  const hero = `<div class="panel blk-hero">
    <div class="blk-head">
      <div class="blk-id">
        <h2 class="blk-title">Miner <span class="mint mono" style="font-size:0.72em">${esc(shortHash(address, 10))}</span></h2>
        <div class="blk-meta">
          ${rank !== null ? `<span class="badge rank">Rank #${fmtInt(rank)}${totalMiners ? ` of ${fmtInt(totalMiners)}` : ""}</span>` : ""}
          ${share30 !== null ? `<span class="badge">${share30.toFixed(1)}% of blocks · 30d</span>` : ""}
          ${entityTag(address)}
          <span class="blk-when">${lastTs ? `last block ${ago(lastTs)}` : "no recent blocks in window"}</span>
        </div>
        <div class="hash-row">
          <span class="hashline mono">${addr}</span>
          <button class="copybtn" type="button" onclick="blkCopy('${jsq(address)}', this)">copy</button>
        </div>
      </div>
      <div class="blk-nav">
        <a class="btn ghost" href="/account/${addr}" title="Sender activity for this address">Account ${icons.chevronRight}</a>
        <a class="btn ghost" href="/miners" title="Miner leaderboard">Leaderboard ${icons.chevronRight}</a>
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
        ["First seen", fmtTime(num(acct.first_seen))],
        ["Last active", `${fmtTime(num(acct.last_active))} (${ago(num(acct.last_active))})`],
        ["Observed sent txs", fmtInt(num(acct.tx_count))],
      ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")
    : "";
  const account = `<div class="panel"><h2>Sender Activity</h2>
    ${acct
      ? `<table class="kv">${acctRows}</table>`
      : `<p style="color:var(--text-dim)">This address has not been observed sending transactions in the indexed data — miners can stay payment-only for a long time.</p>`}
    <p style="margin-top:1rem"><a href="/account/${addr}">Full account page ${icons.arrowRight}</a></p>
  </div>`;

  pageRows = pageRows.slice(0, PAGE_SIZE);
  const bTotal = filteredTotal ?? 0;
  const totalPages = Math.max(1, Math.ceil(bTotal / PAGE_SIZE));
  const blockRows = pageRows.length
    ? pageRows.map((b) => {
        const topo = num(b.topoheight);
        const type = esc(b.block_type ?? "normal");
        const hash = String(b.hash ?? "");
        return `<tr>
          <td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>
          <td><a class="mono" href="/block/${esc(hash)}">${esc(shortHash(hash, 10))}</a></td>
          <td>${fmtTime(num(b.ts))}</td>
          <td class="num">${fmtInt(num(b.tx_count))}</td>
          <td class="num">${fmt(num(b.difficulty))}</td>
          <td class="num">${atomic(num(b.miner_reward))}</td>
          <td><span class="badge ${type.toLowerCase()}">${type}</span></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="7" style="color:var(--text-dim)">${bType || minTxs ? "No blocks match the applied filters for this address." : "No blocks mined by this address inside the indexed window."}</td></tr>`;
  const fActive = !!bType || minTxs > 0;
  const fFields = `
    ${filterField("Block type", `<select name="type">${selectOpts(["Normal", "Side", "Sync"], bType, "all types")}</select>`)}
    ${filterField("Min transactions", `<input type="number" name="min_txs" min="0" step="1" placeholder="e.g. 2" value="${minTxs || ""}" />`)}
  `;
  const fPop = filterPop("f-miner-blocks", basePath, fFields, {
    hidden: srt.qs ? { sort: srt.key, dir: srt.dir } : {},
    reset: `${basePath}${srt.qs ? `?${srt.qs}` : ""}`,
  });
  const blocksPanel = `<div class="panel">
    <div class="panel-head">
      <h2>Blocks Mined <span style="color:var(--text-dim)">${fmtInt(bTotal)} total</span></h2>
      ${filterButton("f-miner-blocks", fActive)}
      ${fPop}
    </div>
    <div class="tablewrap"><table data-srvsort="1">
      <thead><tr>${srt.th("topo", "Block")}${srt.th("hash", "Hash")}${srt.th("time", "Time")}${srt.th("txs", "Txs", true)}${srt.th("difficulty", "Difficulty", true)}${srt.th("reward", "Reward (XEL)", true)}${srt.th("type", "Type")}</tr></thead>
      <tbody>${blockRows}</tbody>
    </table></div>
    ${pager(srt.link(srt.key, srt.dir), page, totalPages)}
  </div>`;

  const seriesJson = JSON.stringify({ blocks: seriesBlocks, rewards: seriesRewards }).replace(/</g, "\\u003c");
  const content = `${hero}
    ${charts}
    <div class="grid-2">${breakdown}${account}</div>
    ${blocksPanel}
    ${lockNote}
    ${copyNote}
    ${hasSeries ? `<script type="application/json" id="miner-series">${seriesJson}</script>` : ""}`;
  return c.html(layout(`Miner ${esc(shortHash(address, 8))}`, content, "/miners"));
});
