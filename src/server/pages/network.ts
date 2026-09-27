import { Hono } from "hono";
import type { Env } from "../app";
import { layout, statCard } from "../../client/layout";
import { fmtBytes, fmtInt } from "../../client/format";
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

const emptyRow = (cols: number): string =>
  `<tr><td colspan="${cols}" style="color:var(--text-dim)">No data yet.</td></tr>`;

network.get("/network", async (c) => {
  const db = c.env.DB;
  let date = new Date().toISOString().slice(0, 10);
  let countries: CountryRow[] = [];
  let snapshot: Snapshot | null = null;
  let versions: VersionRow[] = [];
  let tags: TagRow[] = [];

  try {
    const drow = await db.prepare(
      "SELECT COALESCE((SELECT MAX(date) FROM daily_peer_countries), date('now')) AS d"
    ).first<{ d: string }>();
    date = drow?.d ?? date;

    const [crows, latest, vrows, trows] = await Promise.all([
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
    ]);

    countries = crows;
    snapshot = latest ? { ...latest, ts: Number(latest.ts) } : null;
    versions = vrows;
    tags = trows;
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
    countries: mapped.map((r) => ({
      code: (r.country_code ?? "").trim(),
      name: r.country,
      peers: num(r.peers),
    })),
  }).replace(/</g, "\\u003c");

  const s = snapshot;
  const nic = new Intl.NumberFormat("en-US");
  const cards = `<div class="cards">
    ${statCard("Peers", fmtInt(s?.total), s ? `${fmtInt(s.hidden)} hidden · ${fmtInt(s.pruned)} pruned` : "", false, "net-peers")}
    ${statCard("Lagging", fmtInt(s?.lagging), s ? `${fmtInt(s.stale)} stale · ${fmtInt(s.divergent)} divergent` : "", false)}
    ${statCard("Avg latency", s ? `${nic.format(num(s.avg_lag))} ms` : "—", s ? `${num(s.avg_peer_view).toFixed(1)} avg peer view` : "")}
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
      <div class="grid-2">
        <div>
          <h3 class="sub-h">Node versions</h3>
          <div class="tablewrap"><table>
            <thead><tr><th>Version</th><th class="num">Peers</th><th class="num">Pruned</th></tr></thead>
            <tbody>${versionRows}</tbody>
          </table></div>
        </div>
        <div>
          <h3 class="sub-h">Peer tags</h3>
          <div class="tablewrap"><table>
            <thead><tr><th>Tag</th><th class="num">Peers</th></tr></thead>
            <tbody>${tagRows}</tbody>
          </table></div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Peer concentration <span style="color:var(--text-dim)">${fmtInt(mappedTotal)} geolocated peers · ${esc(date)}</span></h2></div>
      <div class="grid-2">
        <div>
          <h3 class="sub-h">Country choropleth</h3>
          <div id="world-map" class="world-map" role="img" aria-label="World map of peers by country">
            <noscript><p style="color:var(--text-dim)">Enable JavaScript to see the map, or use the table below.</p></noscript>
          </div>
          <div class="map-legend" id="map-legend"></div>
        </div>
        <div>
          <h3 class="sub-h">Node locations <span class="map-sub">clustered country centroids</span></h3>
          <div id="world-map-clusters" class="world-map world-map-clusters" role="img" aria-label="World map of peer locations clustered by country">
            <noscript><p style="color:var(--text-dim)">Enable JavaScript to see the map, or use the table below.</p></noscript>
          </div>
          <div class="map-legend" id="cluster-legend"></div>
        </div>
      </div>
      <div class="tablewrap scroll-y" style="margin-top:1rem"><table>
        <thead><tr><th class="num">#</th><th>Country</th><th class="num">Peers</th><th class="num">Share</th></tr></thead>
        <tbody>${countryRows}</tbody>
      </table></div>
    </div>

    <script type="application/json" id="net-map-data">${mapJson}</script>`;

  return c.html(layout("Network", content, "/network"));
});
