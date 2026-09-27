import { fmtInt } from "./format";

interface CountryDatum {
  code: string;
  name: string;
  peers: number;
}
interface CityDatum {
  city: string;
  country: string;
  code: string;
  lat: number;
  lon: number;
  peers: number;
}
interface MapData {
  date: string;
  total: number;
  cities: CityDatum[];
  countries: CountryDatum[];
}
interface Pt {
  x: number;
  y: number;
  peers: number;
  name: string;
}
interface Cluster {
  x: number;
  y: number;
  peers: number;
  members: Pt[];
}

const SVG_NS = "http://www.w3.org/2000/svg";
const D2R = Math.PI / 180;
// Mercator fit to the vendored MapSVG/amCharts world SVG (viewBox 0 0 1010 666).
// Calibrated against ~120 capitals: max residual ~4 map units (<0.5% of width).
const project = (lat: number, lon: number): { x: number; y: number } => ({
  x: 2.7722 * lon + 476.61,
  y: -2.8314 * (Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2)) / D2R) + 465.6,
});

// Two views of the same vendored per-country SVG:
//   1. choropleth coloured by peer count, and
//   2. a "node locations" map that plots one point per geolocated country at the
//      country's visual centroid, merging nearby points into weighted clusters.
// The SVG is imported lazily so its (large) geometry is only fetched on /network.
export function initNetwork(): void {
  const host = document.getElementById("world-map");
  const dataEl = document.getElementById("net-map-data");
  if (!host || !dataEl) return;

  let data: MapData;
  try {
    data = JSON.parse(dataEl.textContent ?? "null") as MapData;
  } catch {
    return;
  }
  if (!data || !Array.isArray(data.countries)) return;

  void import("./world-map.svg?raw")
    .then(({ default: svg }) => {
      host.innerHTML = svg;
      const map = host.querySelector("svg");
      if (!map) return;

      const byCode = new Map<string, CountryDatum>();
      for (const c of data.countries) {
        const key = (c.code || "").trim().toLowerCase();
        if (key) byCode.set(key, c);
      }

      renderChoropleth(host, map, byCode, data);

      const clusterHost = document.getElementById("world-map-clusters");
      if (clusterHost) {
        clusterHost.innerHTML = svg;
        const clusterMap = clusterHost.querySelector("svg");
        if (clusterMap) renderClusters(clusterHost, clusterMap, byCode, data.cities ?? []);
      }
    })
    .catch(() => { /* map asset unavailable */ });
}

function attachTooltip(host: HTMLElement): HTMLElement {
  const tip = document.createElement("div");
  tip.className = "map-tip";
  tip.hidden = true;
  host.appendChild(tip);
  return tip;
}

function placeTooltip(host: HTMLElement, tip: HTMLElement, x: number, y: number): void {
  const r = host.getBoundingClientRect();
  tip.style.left = `${x - r.left}px`;
  tip.style.top = `${y - r.top}px`;
}

function bindTooltip(el: SVGElement, host: HTMLElement, tip: HTMLElement, text: string): void {
  el.addEventListener("mouseenter", (ev) => {
    tip.textContent = text;
    tip.hidden = false;
    placeTooltip(host, tip, ev.clientX, ev.clientY);
  });
  el.addEventListener("mousemove", (ev) => placeTooltip(host, tip, ev.clientX, ev.clientY));
  el.addEventListener("mouseleave", () => { tip.hidden = true; });
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    tip.textContent = text;
    tip.hidden = false;
    placeTooltip(host, tip, r.left + r.width / 2, r.top);
  });
  el.addEventListener("blur", () => { tip.hidden = true; });
}

function renderChoropleth(host: HTMLElement, svgEl: SVGSVGElement, byCode: Map<string, CountryDatum>, data: MapData): void {
  const max = Math.max(1, ...data.countries.map((c) => c.peers));
  const total = data.total || data.countries.reduce((a, c) => a + c.peers, 0);
  const tip = attachTooltip(host);

  let observedPeers = 0;
  for (const path of Array.from(svgEl.querySelectorAll<SVGPathElement>("path[id]"))) {
    const c = byCode.get((path.id || "").toLowerCase());
    if (!c) {
      path.classList.add("map-unobserved");
      continue;
    }
    path.classList.add(`map-l${Math.max(1, Math.min(5, Math.ceil((c.peers / max) * 5)))}`);
    path.setAttribute("data-peers", String(c.peers));
    path.setAttribute("tabindex", "0");
    const pct = total ? ((c.peers / total) * 100).toFixed(1) : "0.0";
    const text = `${c.name} — ${fmtInt(c.peers)} peer${c.peers === 1 ? "" : "s"} (${pct}%)`;
    path.setAttribute("aria-label", text);
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = text;
    path.appendChild(title);
    observedPeers += c.peers;
    bindTooltip(path, host, tip, text);
  }

  const legend = document.getElementById("map-legend");
  if (legend) {
    const unresolved = Math.max(0, total - observedPeers);
    legend.innerHTML = `
      <span class="map-legend-title">fewer</span>
      ${[1, 2, 3, 4, 5].map((l) => `<span class="map-swatch map-l${l}"></span>`).join("")}
      <span class="map-legend-title">more</span>
      <span class="map-swatch map-unobserved"></span>
      <span class="map-legend-note">not observed${unresolved > 0 ? ` · ${fmtInt(unresolved)} unresolved` : ""}</span>`;
  }
}

function renderClusters(host: HTMLElement, svgEl: SVGSVGElement, byCode: Map<string, CountryDatum>, cities: CityDatum[]): void {
  const pts: Pt[] = [];
  const usingCities = cities.some((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  if (usingCities) {
    for (const c of cities) {
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
      const { x, y } = project(c.lat, c.lon);
      pts.push({ x, y, peers: c.peers, name: `${c.city}, ${c.country}` });
    }
  } else {
    // Fallback for days captured before the city rollup: one point per country
    // at its SVG path centre.
    for (const path of Array.from(svgEl.querySelectorAll<SVGPathElement>("path[id]"))) {
      const c = byCode.get((path.id || "").toLowerCase());
      if (!c) continue;
      let bbox: DOMRect;
      try {
        bbox = path.getBBox();
      } catch {
        continue;
      }
      if (!bbox || (!bbox.width && !bbox.height)) continue;
      pts.push({ x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2, peers: c.peers, name: c.name });
    }
  }
  if (!pts.length) return;

  // Greedy merge of nearby points in the SVG's own coordinate space, seeded by
  // the largest peers so a cluster centre is pulled toward the busiest node.
  const RADIUS = usingCities ? 18 : 26;
  const clusters: Cluster[] = [];
  for (const p of [...pts].sort((a, b) => b.peers - a.peers)) {
    let best: Cluster | null = null;
    let bestD = Infinity;
    for (const cl of clusters) {
      const d = Math.hypot(cl.x - p.x, cl.y - p.y);
      if (d < bestD) { bestD = d; best = cl; }
    }
    if (best && bestD <= RADIUS) {
      const n = best.peers + p.peers;
      best.x = (best.x * best.peers + p.x * p.peers) / n;
      best.y = (best.y * best.peers + p.y * p.peers) / n;
      best.peers = n;
      best.members.push(p);
    } else {
      clusters.push({ x: p.x, y: p.y, peers: p.peers, members: [p] });
    }
  }

  const layer = document.createElementNS(SVG_NS, "g");
  layer.setAttribute("class", "cluster-layer");
  const tip = attachTooltip(host);
  const maxCluster = Math.max(...clusters.map((c) => c.peers));
  const unit = usingCities ? "cities" : "countries";

  for (const cl of clusters) {
    const node = document.createElementNS(SVG_NS, "circle");
    node.setAttribute("cx", cl.x.toFixed(2));
    node.setAttribute("cy", cl.y.toFixed(2));
    node.setAttribute("r", (3 + 13 * Math.sqrt(cl.peers / maxCluster)).toFixed(2));
    node.setAttribute("class", "cluster-dot");
    node.setAttribute("tabindex", "0");

    const members = [...cl.members].sort((a, b) => b.peers - a.peers);
    const names = members.slice(0, 3).map((m) => m.name).join(", ") + (members.length > 3 ? ` +${members.length - 3} more` : "");
    const text = members.length > 1
      ? `${members.length} ${unit} · ${fmtInt(cl.peers)} peers — ${names}`
      : `${members[0].name} — ${fmtInt(cl.peers)} peer${cl.peers === 1 ? "" : "s"}`;
    node.setAttribute("aria-label", text);
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = text;
    node.appendChild(title);
    bindTooltip(node, host, tip, text);
    layer.appendChild(node);
  }
  svgEl.appendChild(layer);

  const legend = document.getElementById("cluster-legend");
  if (legend) {
    legend.innerHTML = `
      <span class="map-swatch cluster-swatch"></span>
      <span class="map-legend-note">${clusters.length} cluster${clusters.length === 1 ? "" : "s"} · ${pts.length} ${unit} · bubble size = peers</span>`;
  }
}
