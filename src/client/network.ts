import { fmtInt } from "./format";

interface CountryDatum {
  code: string;
  name: string;
  peers: number;
}
interface MapData {
  date: string;
  total: number;
  countries: CountryDatum[];
}

// Colour a vendored per-country SVG by peer count. The SVG is imported lazily so
// its (large) geometry is only fetched on /network, never on other pages.
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
      const svgEl = host.querySelector("svg");
      if (!svgEl) return;

      const byCode = new Map<string, CountryDatum>();
      for (const c of data.countries) {
        const key = (c.code || "").trim().toLowerCase();
        if (key) byCode.set(key, c);
      }
      const max = Math.max(1, ...data.countries.map((c) => c.peers));
      const total = data.total || data.countries.reduce((a, c) => a + c.peers, 0);

      const tooltip = document.createElement("div");
      tooltip.className = "map-tip";
      tooltip.hidden = true;
      host.appendChild(tooltip);

      const hostRect = () => host.getBoundingClientRect();
      const label = (c: CountryDatum): string => {
        const pct = total ? ((c.peers / total) * 100).toFixed(1) : "0.0";
        return `${c.name} — ${fmtInt(c.peers)} peer${c.peers === 1 ? "" : "s"} (${pct}%)`;
      };

      let observedPeers = 0;
      const paths = Array.from(svgEl.querySelectorAll<SVGPathElement>("path[id]"));
      for (const path of paths) {
        const c = byCode.get((path.id || "").toLowerCase());
        if (!c) {
          path.classList.add("map-unobserved");
          continue;
        }
        path.classList.add(`map-l${Math.max(1, Math.min(5, Math.ceil((c.peers / max) * 5)))}`);
        path.setAttribute("data-peers", String(c.peers));
        path.setAttribute("tabindex", "0");
        const text = label(c);
        path.setAttribute("aria-label", text);
        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.textContent = text;
        path.appendChild(title);
        observedPeers += c.peers;

        const place = (x: number, y: number): void => {
          const r = hostRect();
          tooltip.style.left = `${x - r.left}px`;
          tooltip.style.top = `${y - r.top}px`;
        };
        path.addEventListener("mouseenter", (ev) => {
          tooltip.textContent = text;
          tooltip.hidden = false;
          place(ev.clientX, ev.clientY);
        });
        path.addEventListener("mousemove", (ev) => place(ev.clientX, ev.clientY));
        path.addEventListener("mouseleave", () => { tooltip.hidden = true; });
        path.addEventListener("focus", () => {
          const r = path.getBoundingClientRect();
          tooltip.textContent = text;
          tooltip.hidden = false;
          place(r.left + r.width / 2, r.top);
        });
        path.addEventListener("blur", () => { tooltip.hidden = true; });
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
    })
    .catch(() => { /* map asset unavailable */ });
}
