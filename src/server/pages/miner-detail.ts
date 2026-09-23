import { Hono } from "hono";
import type { Env } from "../app";
import { layout, statCard } from "../../client/layout";
import { fmt, fmtInt, shortHash, fmtTime, ago, atomic } from "../../client/format";
import { esc, entityTag, blkCopyScript, num } from "./shared";

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

  const dailyBlocks = num(dailyMiner?.ball);
  const dailyRewards = num(dailyMiner?.rall);
  const blockCount = num(allTime?.c);
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
            ["First seen", fmtTime(num(acct.first_seen))],
            ["Last active", `${fmtTime(num(acct.last_active))} (${ago(num(acct.last_active))})`],
            ["Observed sent txs", fmtInt(num(acct.tx_count))],
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
        { label: "Last day", blocks: num(dailyMiner?.b1), rewards: num(dailyMiner?.r1), share: share(num(dailyMiner?.b1), num(dailyNet?.b1)) },
        { label: "Last 7 days", blocks: num(dailyMiner?.b7), rewards: num(dailyMiner?.r7), share: share(num(dailyMiner?.b7), num(dailyNet?.b7)) },
        { label: "Last 30 days", blocks: num(dailyMiner?.b30), rewards: num(dailyMiner?.r30), share: share(num(dailyMiner?.b30), num(dailyNet?.b30)) },
        { label: "All-time", blocks: dailyBlocks, rewards: dailyRewards, share: share(dailyBlocks, num(dailyNet?.ball)) },
      ]
    : [
        { label: "Last 24h", blocks: num(winMiner?.b1), rewards: num(winMiner?.r1), share: share(num(winMiner?.b1), num(winNet?.b1)) },
        { label: "Last 7 days", blocks: num(winMiner?.b7), rewards: num(winMiner?.r7), share: share(num(winMiner?.b7), num(winNet?.b7)) },
        { label: "Last 30 days", blocks: num(winMiner?.b30), rewards: num(winMiner?.r30), share: share(num(winMiner?.b30), num(winNet?.b30)) },
        { label: "Indexed window", blocks: num(winMiner?.ball), rewards: num(winMiner?.rall), share: share(num(winMiner?.ball), num(winNet?.ball)) },
      ];
  const share30 = periods[2].share;
  const totals: MinerTotals = useDaily
    ? { blocks: dailyBlocks, rewards: dailyRewards }
    : { blocks: num(winMiner?.ball), rewards: num(winMiner?.rall) };

  // ---- all-time rank among observed miners ----
  try {
    if (useDaily) {
      const r = await db.prepare(
        "SELECT COUNT(*) AS ahead FROM (SELECT address, SUM(blocks_found) s FROM daily_miners GROUP BY address) WHERE s > ?"
      ).bind(totals.blocks).first<{ ahead: number }>();
      const t = await db.prepare("SELECT COUNT(*) AS n FROM (SELECT address FROM daily_miners GROUP BY address)").first<{ n: number }>();
      rank = num(r?.ahead) + 1;
      totalMiners = num(t?.n);
    } else if (blockCount > 0) {
      const r = await db.prepare(
        "SELECT COUNT(*) AS ahead FROM (SELECT COUNT(*) c FROM blocks WHERE miner_address != '' GROUP BY miner_address) WHERE c > ?"
      ).bind(blockCount).first<{ ahead: number }>();
      const t = await db.prepare(
        "SELECT COUNT(*) AS n FROM (SELECT miner_address FROM blocks WHERE miner_address != '' GROUP BY miner_address)"
      ).first<{ n: number }>();
      rank = num(r?.ahead) + 1;
      totalMiners = num(t?.n);
    }
  } catch { /* rank unavailable */ }

  // ---- daily series for charts (last 90 days) ----
  let series: { date: string; blocks: number; rewards: number }[] = seriesRows
    .map((r) => ({ date: String(r.date ?? ""), blocks: num(r.blocks_found), rewards: num(r.rewards_earned) }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .reverse();
  if (!series.length) {
    try {
      const rows = await db.prepare(
        `SELECT date(ts/1000,'unixepoch') date, COUNT(*) b, SUM(miner_reward) r
         FROM blocks WHERE miner_address = ? AND ts > ? GROUP BY 1 ORDER BY 1`
      ).bind(address, now - 90 * DAY).all<Record<string, unknown>>().then((r) => r.results ?? []);
      series = rows.map((r) => ({ date: String(r.date ?? ""), blocks: num(r.b), rewards: num(r.r) }))
        .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date));
    } catch { /* series unavailable */ }
  }
  const seriesBlocks: MinerChartPoint[] = series.map((p) => ({ date: p.date, value: p.blocks }));
  const seriesRewards: MinerChartPoint[] = series.map((p) => ({ date: p.date, value: p.rewards / 1e8 }));
  const hasSeries = seriesBlocks.some((p) => p.value > 0) || seriesRewards.some((p) => p.value > 0);

  const hashRate = num(hash24?.ad) > 0 && num(hash24?.c) > 0 ? (num(hash24?.ad) * num(hash24?.c)) / 86400 : null;
  const lastBlock = recent[0];
  const lastTopo = lastBlock ? num(lastBlock.topoheight) : null;
  const lastTs = lastBlock ? num(lastBlock.ts) : (dailyMiner?.d1 ? Date.parse(String(dailyMiner.d1) + "T00:00:00Z") : null);
  const sinceLabel = useDaily
    ? (dailyMiner?.d0 ? `since ${String(dailyMiner.d0)}` : "")
    : (allTime?.f ? `since ${fmtTime(num(allTime.f)).slice(0, 10)}` : "");
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
        ["First seen", fmtTime(num(acct.first_seen))],
        ["Last active", `${fmtTime(num(acct.last_active))} (${ago(num(acct.last_active))})`],
        ["Observed sent txs", fmtInt(num(acct.tx_count))],
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
        const topo = num(b.topoheight);
        const type = esc(b.block_type ?? "normal");
        const hash = String(b.hash ?? "");
        return `<tr>
          <td><a href="/block/${topo}"><span class="mint">${fmtInt(topo)}</span></a></td>
          <td><a class="mono" href="/block/${esc(hash)}">${shortHash(hash, 10)}</a></td>
          <td>${fmtTime(num(b.ts))}</td>
          <td class="num">${fmtInt(num(b.tx_count))}</td>
          <td class="num">${fmt(num(b.difficulty))}</td>
          <td class="num">${atomic(num(b.miner_reward))}</td>
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
