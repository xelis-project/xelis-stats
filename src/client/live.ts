export function initLiveStatus(): void {
  const dot = document.getElementById("ws-dot");
  const label = document.getElementById("ws-label");
  const status = document.getElementById("ws-status");
  if (!dot || !label || !status) return;

  const dotEl = dot;
  const labelEl = label;
  const statusEl = status;
  let retry = 0;

  function connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
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
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      statusEl.classList.add("off");
      statusEl.classList.remove("connecting");
      dotEl.classList.add("off");
      labelEl.textContent = "reconnecting";
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, Math.pow(2, retry) * 1000);
    };
    ws.onerror = () => ws.close();
  }

  connect();
}
