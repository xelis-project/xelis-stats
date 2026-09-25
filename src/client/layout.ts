import { XEL_LOGO } from "./format";
import { icons } from "./icons";
import { mainScriptUrl } from "./entry-url";
import appCss from "./style.css?inline";
import flatpickrCss from "flatpickr/dist/flatpickr.min.css?inline";
import uplotCss from "uplot/dist/uPlot.min.css?inline";

// HTML-escape every untrusted value before interpolating it into a template.
export const escHtml = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string));

export function layout(title: string, content: string, active: string, bodyClass = ""): string {
  const nav = [
    ["/", "Dashboard"],
    ["/blocks", "Blocks"],
    ["/transactions", "Transactions"],
    ["/accounts", "Accounts"],
    ["/assets", "Assets"],
    ["/contracts", "Contracts"],
    ["/market", "Market"],
    ["/miners", "Miners"],
    ["/charts", "Charts"],
  ]
    .map(([href, name]) => `<a href="${href}" class="${active === href ? "active" : ""}">${name}</a>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escHtml(title)} · Xelis Stats</title>
  <meta name="description" content="Xelis blockchain statistics, market data and explorer" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <script>try{var s=localStorage,d=document.documentElement;if(s.getItem("xelis:reveal-flags")==="1")d.classList.add("reveal-flags");if(s.getItem("xelis:density")==="compact")d.classList.add("density-compact");if(s.getItem("xelis:reduce-motion")==="1")d.classList.add("reduce-motion");}catch(e){}</script>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Jura:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet" />
  <style>${flatpickrCss}${uplotCss}${appCss}</style>
  <script type="module" src="${mainScriptUrl}"></script>
</head>
<body class="${escHtml(bodyClass)}">
  <div id="app">
    <header class="site">
      <a class="logo" href="/"><svg width="22" height="21" viewBox="0 0 778 743" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M388.909 742.872L777.817 353.964L424.056 0.202599L478.809 132.737L700.036 353.964L388.909 665.091L77.7817 353.964L299.507 129.121L353.964 0L0 353.964L388.909 742.872Z"/><path d="M388.909 665.091L353.964 0L299.507 129.121L388.909 665.091Z"/><path d="M424.056 0.202599L388.909 665.091L478.809 132.737L424.056 0.202599Z"/></svg><span>XELIS&nbsp;<span style="color:var(--mint)">STATS</span></span></a>
      <nav id="site-nav"><div class="nav-clip"><div class="nav-grid">${nav}</div><div class="nav-foot"><a href="/api/docs">API</a><a href="/status">Status</a></div></div></nav>
      <button class="searchbox" type="button" onclick="openSearch()" aria-label="Search">${icons.search}<span>Search</span><kbd>Ctrl K</kbd></button>
      <a class="btn ghost icon-btn" href="/settings" title="Settings" aria-label="Settings">${icons.settings}</a>
      <div class="status connecting" id="ws-status"><span class="dot" id="ws-dot"></span><span id="ws-label">connecting</span></div>
      <button class="menu-toggle btn ghost icon-btn" type="button" onclick="toggleNav()" aria-label="Menu" aria-expanded="false" aria-controls="site-nav"><span class="ict-open">${icons.menu}</span><span class="ict-close">${icons.close}</span></button>
    </header>
    <div class="nav-backdrop" aria-hidden="true" onclick="closeNav()"></div>
    <main id="main">${content}</main>
    <footer class="site">
      <a class="footer-brand" href="/">${XEL_LOGO}<span>XELIS&nbsp;<span style="color:var(--mint)">STATS</span></span></a>
      <nav class="footer-links">
        <a href="/api/docs">API</a>
        <a href="/status">Status</a>
        <a href="/settings">Settings</a>
      </nav>
      <div class="footer-copy">© ${new Date().getFullYear()} Xelis Stats · Data from the Xelis network</div>
    </footer>
    <div class="search-overlay" id="search-overlay" hidden>
      <div class="search-pop" role="dialog" aria-modal="true">
        <form class="searchbox" onsubmit="return handleSearch(event)">
          <input id="global-search" placeholder="Search block / tx / address…" autocomplete="off" />
          <button type="button" class="search-close" onclick="closeSearch()" aria-label="Close">${icons.close}</button>
        </form>
        <div class="search-hint">Press <kbd>Enter</kbd> to search — block height, hash or address</div>
      </div>
    </div>
  </div>
  <script>
    function setNav(open) {
      var h = document.querySelector("header.site");
      if (!h) return;
      h.classList.toggle("menu-open", open);
      document.body.classList.toggle("nav-open", open);
      var b = h.querySelector(".menu-toggle");
      if (b) b.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) {
        var first = h.querySelector(".nav-grid a");
        if (first) first.focus();
      } else if (b && document.activeElement && h.contains(document.activeElement)) {
        b.focus();
      }
    }
    function toggleNav() { setNav(!document.querySelector("header.site").classList.contains("menu-open")); }
    function closeNav() { setNav(false); }
    var siteNav = document.getElementById("site-nav");
    if (siteNav) siteNav.addEventListener("click", function (e) { if (e.target.closest("a")) closeNav(); });
    function openSearch() {
      var o = document.getElementById("search-overlay");
      o.hidden = false;
      requestAnimationFrame(function () { o.classList.add("open"); });
      document.getElementById("global-search").focus();
    }
    function closeSearch() {
      var o = document.getElementById("search-overlay");
      o.classList.remove("open");
      o.hidden = true;
      document.getElementById("global-search").value = "";
    }
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSearch(); }
      if (e.key === "Escape") { closeNav(); closeSearch(); }
    });
    document.getElementById("search-overlay").addEventListener("click", function (e) {
      if (e.target === this) closeSearch();
    });
    function handleSearch(e) {
      e.preventDefault();
      var q = document.getElementById("global-search").value.trim();
      if (!q) return false;
      if (/^\\d+$/.test(q)) { location.href = "/block/" + q; return false; }
      location.href = "/search/" + encodeURIComponent(q);
      return false;
    }
  </script>
</body>
</html>`;
}

export function statCard(label: string, value: string, sub = "", small = false, id = ""): string {
  return `<div class="card"><div class="label">${label}</div><div class="value ${small ? "small" : ""}" ${id ? `id="${id}"` : ""}>${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}

export function notFound(what: string): string {
  return `<div class="err404"><h1>404</h1><p style="margin-top:1rem;color:var(--text-dim)">${escHtml(what)} not found</p><p style="margin-top:2rem"><a class="btn" href="/">${icons.arrowLeft} Dashboard</a></p></div>`;
}

export { XEL_LOGO };
