import { Hono } from "hono";
import type { Env } from "../app";
import { layout, statCard } from "../../client/layout";
import { fmt, fmtBytes, fmtInt } from "../../client/format";
import { rpc } from "../xelis";
import { esc, flaggedText, logErr, num } from "./shared";

export const network = new Hono<{ Bindings: Env }>();

interface CountryRow {
  country: string;
  country_code: string;
  peers: number;
}
interface VersionRow {
  version: string;
  peer_count: number;
  pruned_count: number;
}
interface TagRow {
  tag: string;
  peers: number;
}
interface CityRow {
  city: string;
  country: string;
  country_code: string;
  latitude: number;
  longitude: number;
  peers: number;
}
interface Snapshot {
  ts: number;
  total: number;
  hidden: number;
  pruned: number;
  lagging: number;
  stale: number;
  divergent: number;
  avg_lag: number;
  avg_peer_view: number;
  avg_conn_age: number;
  new_conns: number;
  bytes_recv: number;
  bytes_sent: number;
}

interface HardFork {
  changelog?: string | null;
  height?: number;
  version?: number;
  version_requirement?: string | null;
}

interface DevFeeThreshold {
  height?: number;
  fee_percentage?: number;
}

const emptyRow = (cols: number): string =>
  `<tr><td colspan="${cols}" style="color:var(--text-dim)">No data yet.</td></tr>`;

network.get("/network", async (c) => {
  const db = c.env.DB;
  let date = new Date().toISOString().slice(0, 10);
  let countries: CountryRow[] = [];
  let snapshot: Snapshot | null = null;
  let versions: VersionRow[] = [];
  let tags: TagRow[] = [];
  let cities: CityRow[] = [];

  try {
    const drow = await db.prepare(
      "SELECT COALESCE((SELECT MAX(date) FROM daily_peer_countries), date('now')) AS d"
    ).first<{ d: string }>();
    date = drow?.d ?? date;

    const [crows, latest, vrows, trows, cityRows] = await Promise.all([
      db.prepare(
        "SELECT country, country_code, peers FROM daily_peer_countries WHERE date = ? ORDER BY peers DESC"
      ).bind(date).all<CountryRow>().then((r) => r.results ?? []),
      db.prepare("SELECT * FROM peer_snapshots ORDER BY ts DESC LIMIT 1").first<Snapshot>(),
      db.prepare(
        "SELECT version, peer_count, pruned_count FROM node_versions WHERE date = (SELECT MAX(date) FROM node_versions) ORDER BY peer_count DESC LIMIT 20"
      ).all<VersionRow>().then((r) => r.results ?? []),
      db.prepare(
        "SELECT tag, peers FROM daily_peer_tags WHERE date = (SELECT MAX(date) FROM daily_peer_tags) ORDER BY peers DESC LIMIT 10"
      ).all<TagRow>().then((r) => r.results ?? []),
      // Fall back to an empty list so the page still renders the country map
      // if the city table is not present (e.g. an older database).
      db.prepare(
        "SELECT city, country, country_code, latitude, longitude, peers FROM daily_peer_cities WHERE date = ? ORDER BY peers DESC"
      ).bind(date).all<CityRow>().then((r) => r.results ?? []).catch(() => [] as CityRow[]),
    ]);

    countries = crows;
    snapshot = latest ? { ...latest, ts: Number(latest.ts) } : null;
    versions = vrows;
    tags = trows;
    cities = cityRows;
  } catch (err) {
    logErr("page/network", err);
  }

  // Hard forks and dev fee thresholds from the node.
  let hardForks: HardFork[] = [];
  let devFees: DevFeeThreshold[] = [];
  try {
    const [hf, df] = await Promise.all([
      rpc<HardFork[]>("get_hard_forks", undefined, c.env.XELIS_NODE).catch(() => [] as HardFork[]),
      rpc<DevFeeThreshold[]>("get_dev_fee_thresholds", undefined, c.env.XELIS_NODE).catch(() => [] as DevFeeThreshold[]),
    ]);
    hardForks = Array.isArray(hf) ? hf : [];
    devFees = Array.isArray(df) ? df : [];
  } catch (err) {
    logErr("page/network", err);
  }
  const total = countries.reduce((sum, r) => sum + num(r.peers), 0);
  const mapped = countries.filter((r) => (r.country_code ?? "").trim() !== "");
  const mappedTotal = mapped.reduce((sum, r) => sum + num(r.peers), 0);
  const unknown = total - mappedTotal;

  // Embedded for the client-side map colouring. "<" is neutralised so a country
  // name can never terminate the script element.
  const mapJson = JSON.stringify({
    date,
    total,
    cities: cities.map((c) => ({
      city: c.city,
      country: c.country,
      code: (c.country_code ?? "").trim(),
      lat: num(c.latitude),
      lon: num(c.longitude),
      peers: num(c.peers),
    })),
    countries: mapped.map((r) => ({
      code: (r.country_code ?? "").trim(),
      name: r.country,
      peers: num(r.peers),
    })),
  }).replace(/</g, "\\u003c");

  const s = snapshot;
  const nic = new Intl.NumberFormat("en-US");

  const forkRows = hardForks.length
    ? [...hardForks]
        .sort((a, b) => (b.height ?? -Infinity) - (a.height ?? -Infinity))
        .map((f) => `<tr>
        <td class="num">${f.height != null ? `<a href="/block/${num(f.height)}"><span class="mint">${fmtInt(num(f.height))}</span></a>` : "—"}</td>
        <td class="num">v${fmtInt(num(f.version))}</td>
        <td>${f.changelog ? esc(String(f.changelog)) : "—"}</td>
        <td class="mono">${f.version_requirement ? esc(String(f.version_requirement)) : "—"}</td>
      </tr>`).join("")
    : emptyRow(4);

  const devFeeRows = devFees.length
    ? devFees.map((d) => `<tr>
        <td class="num">${d.height != null ? fmtInt(num(d.height)) : "—"}</td>
        <td class="num">${fmtInt(num(d.fee_percentage))}%</td>
      </tr>`).join("")
    : emptyRow(2);

  const forkPanels = `<div class="grid-2" style="align-items:start">
    <div class="panel">
      <div class="panel-head"><h2>Hard forks</h2></div>
      <div class="tablewrap"><table>
        <thead><tr><th class="num">Height</th><th class="num">Version</th><th>Changelog</th><th>Requires</th></tr></thead>
        <tbody>${forkRows}</tbody>
      </table></div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Dev fee thresholds</h2></div>
      <div class="tablewrap"><table>
        <thead><tr><th class="num">From height</th><th class="num">Dev fee</th></tr></thead>
        <tbody>${devFeeRows}</tbody>
      </table></div>
    </div>
  </div>`;

  const cards = `<div class="cards">
    ${statCard("Peers", fmtInt(s?.total), s ? `${fmtInt(s.hidden)} hidden · ${fmtInt(s.pruned)} pruned` : "", false, "net-peers")}
    ${statCard("Lagging", fmtInt(s?.lagging), s ? `${fmtInt(s.stale)} stale · ${fmtInt(s.divergent)} divergent` : "", false)}
    ${statCard("Avg lag", s ? `${fmt(num(s.avg_lag), 1)} blocks` : "—", s ? `${num(s.avg_peer_view).toFixed(1)} avg peer view` : "")}
    ${statCard("New conns (1h)", fmtInt(s?.new_conns), s ? `${nic.format(num(s.avg_conn_age))}s avg conn age` : "")}
    ${statCard("Traffic", fmtBytes(s?.bytes_recv), s ? `${fmtBytes(s.bytes_sent)} out` : "")}
    ${statCard("GeoIP coverage", total ? `${((mappedTotal / total) * 100).toFixed(1)}%` : "—", `${mapped.length} countries · ${unknown} unresolved`)}
  </div>`;

  const countryRows = countries.length
    ? countries.map((r, i) => {
        const code = (r.country_code ?? "").trim();
        const label = code
          ? `${esc(r.country)} <span class="badge">${esc(code.toUpperCase())}</span>`
          : `${esc(r.country)} <span class="badge livesrc">unresolved</span>`;
        const share = total ? (num(r.peers) / total) * 100 : 0;
        return `<tr>
          <td class="num">${i + 1}</td>
          <td>${label}</td>
          <td class="num">${fmtInt(num(r.peers))}</td>
          <td class="num">${share.toFixed(1)}%</td>
        </tr>`;
      }).join("")
    : emptyRow(4);

  const cityPeers = cities.reduce((sum, r) => sum + num(r.peers), 0);
  const unknownCity = Math.max(0, total - cityPeers);
  const cityRows = cities.map((r, i) => {
    const code = (r.country_code ?? "").trim();
    const label = code
      ? `${esc(r.city)} <span class="badge">${esc(code.toUpperCase())}</span>`
      : `${esc(r.city)} <span class="badge livesrc">unresolved</span>`;
    const share = total ? (num(r.peers) / total) * 100 : 0;
    return `<tr>
      <td class="num">${i + 1}</td>
      <td>${label}</td>
      <td class="num">${fmtInt(num(r.peers))}</td>
      <td class="num">${share.toFixed(1)}%</td>
    </tr>`;
  });
  if (unknownCity > 0) {
    const share = total ? (unknownCity / total) * 100 : 0;
    cityRows.push(`<tr>
      <td class="num">${cities.length + 1}</td>
      <td>Unknown <span class="badge livesrc">unresolved</span></td>
      <td class="num">${fmtInt(unknownCity)}</td>
      <td class="num">${share.toFixed(1)}%</td>
    </tr>`);
  }
  const locationRows = cityRows.length ? cityRows.join("") : emptyRow(4);

  const versionRows = versions.length
    ? versions.map((v) => `<tr>
        <td class="mono">${esc(v.version)}</td>
        <td class="num">${fmtInt(num(v.peer_count))}</td>
        <td class="num">${fmtInt(num(v.pruned_count))}</td>
      </tr>`).join("")
    : emptyRow(3);

  const tagRows = tags.length
    ? tags.map((t) => `<tr><td>${flaggedText(t.tag)}</td><td class="num">${fmtInt(num(t.peers))}</td></tr>`).join("")
    : emptyRow(2);

  const content = `
    <div class="panel">
      <div class="panel-head"><h2>Peer network <span style="color:var(--text-dim)">${esc(date)}</span></h2></div>
      ${cards}
    </div>

    <div class="grid-2" style="align-items:start">
      <div class="panel">
        <div class="panel-head"><h2>Node versions</h2></div>
        <div class="tablewrap"><table>
          <thead><tr><th>Version</th><th class="num">Peers</th><th class="num">Pruned</th></tr></thead>
          <tbody>${versionRows}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Peer tags</h2></div>
        <div class="tablewrap"><table>
          <thead><tr><th>Tag</th><th class="num">Peers</th></tr></thead>
          <tbody>${tagRows}</tbody>
        </table></div>
      </div>
    </div>

    <div class="grid-2" style="align-items:start">
      <div class="panel">
        <div class="panel-head"><h2>Peer concentration</h2></div>
        <div id="world-map" class="world-map" role="img" aria-label="World map of peers by country">
          <noscript><p style="color:var(--text-dim)">Enable JavaScript to see the map, or use the table below.</p></noscript>
        </div>
        <div class="map-legend" id="map-legend"></div>
        <div class="tablewrap scroll-y" style="margin-top:1rem"><table>
          <thead><tr><th class="num">#</th><th>Country</th><th class="num">Peers</th><th class="num">Share</th></tr></thead>
          <tbody>${countryRows}</tbody>
        </table></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Node locations</h2></div>
        <div id="world-map-clusters" class="world-map world-map-clusters" role="img" aria-label="World map of peer locations clustered by city">
          <noscript><p style="color:var(--text-dim)">Enable JavaScript to see the map.</p></noscript>
        </div>
        <div class="map-legend" id="cluster-legend"></div>
        <div class="tablewrap scroll-y" style="margin-top:1rem"><table>
          <thead><tr><th class="num">#</th><th>City</th><th class="num">Peers</th><th class="num">Share</th></tr></thead>
          <tbody>${locationRows}</tbody>
        </table></div>
      </div>
    </div>

    ${forkPanels}

    <script type="application/json" id="net-map-data">${mapJson}</script>`;

  return c.html(layout("Network", content, "/network"));
});
