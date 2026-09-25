import { isLiveEnabled } from "./prefs";

export function initLiveStatus(): void {
  const dot = document.getElementById("ws-dot");
  const label = document.getElementById("ws-label");
  const status = document.getElementById("ws-status");
  if (!dot || !label || !status) return;

  const dotEl = dot;
  const labelEl = label;
  const statusEl = status;
  let retry = 0;
  let ws: WebSocket | null = null;
  let timer: number | undefined;
  let active = false;

  function connect(): void {
    if (!active) return;
    statusEl.classList.add("connecting");
    statusEl.classList.remove("off");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      statusEl.classList.remove("off", "connecting");
      dotEl.classList.remove("off");
      labelEl.textContent = "live";
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; topoheight?: number };
        if (msg.type === "new_block" && msg.topoheight) {
          const el = document.getElementById("stat-topo");
          if (el) el.textContent = msg.topoheight.toLocaleString("en-US");
        }
        // Let pages that mirror node state (e.g. /live) refresh on tip changes.
        window.dispatchEvent(new CustomEvent("xelis:chain-tip", { detail: msg }));
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (!active) return;
      statusEl.classList.add("off");
      statusEl.classList.remove("connecting");
      dotEl.classList.add("off");
      labelEl.textContent = "reconnecting";
      retry = Math.min(retry + 1, 6);
      timer = window.setTimeout(connect, Math.pow(2, retry) * 1000);
    };
    ws.onerror = () => ws?.close();
  }

  function start(): void {
    if (active) return;
    active = true;
    retry = 0;
    connect();
  }

  function stop(): void {
    active = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    try {
      ws?.close();
    } catch {
      // already closed
    }
    ws = null;
    statusEl.classList.add("off");
    statusEl.classList.remove("connecting");
    dotEl.classList.add("off");
    labelEl.textContent = "paused";
  }

  if (isLiveEnabled()) start();
  else stop();

  window.addEventListener("xelis:live-change", (ev) => {
    const enabled = (ev as CustomEvent<{ enabled?: boolean }>).detail?.enabled;
    if (enabled) start();
    else stop();
  });
}
