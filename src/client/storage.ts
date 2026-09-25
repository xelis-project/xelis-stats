// Contract storage panel behaviour: client-side search + value-type filter over
// the loaded entries, "load more" paging from the node RPC fragment endpoint,
// copy actions, a decoded/raw view toggle and expand/collapse-all.
//
// The server renders each entry as <details class="stg-entry"> with the decoded
// tree, a hidden pretty-printed raw JSON block and a hidden raw key block; this
// module only reads and augments the DOM and never re-parses the node wire format.

interface Rec {
  entry: HTMLDetailsElement;
  text: string;
  vk: string;
}

function copyText(text: string, btn: HTMLElement): void {
  const done = (): void => {
    const prev = btn.textContent;
    btn.textContent = "copied";
    btn.classList.add("done");
    window.setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove("done");
    }, 1200);
  };
  const fallback = (): void => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    document.body.removeChild(ta);
    done();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}

export function initStorage(): void {
  const list = document.getElementById("stg-list");
  if (!list) return;

  const search = document.getElementById("stg-search") as HTMLInputElement | null;
  const typeSel = document.getElementById("stg-type") as HTMLSelectElement | null;
  const countEl = document.getElementById("stg-count");
  const moreRow = document.getElementById("stg-more-row");
  const moreBtn = document.getElementById("stg-more") as HTMLButtonElement | null;
  const expandBtn = document.getElementById("stg-expand");
  const collapseBtn = document.getElementById("stg-collapse");

  const recs: Rec[] = [];
  let hasMore = moreRow ? !moreRow.hidden : false;

  // index a scope's entries once; searchable text skips the raw JSON block so
  // long byte dumps don't bloat the index
  const index = (scope: ParentNode): void => {
    for (const el of Array.from(scope.querySelectorAll<HTMLDetailsElement>("details.stg-entry"))) {
      if (el.dataset.stgIndexed) continue;
      el.dataset.stgIndexed = "1";
      const head = el.querySelector(".stg-head");
      const decoded = el.querySelector(".stg-decoded");
      recs.push({
        entry: el,
        text: `${head?.textContent ?? ""} ${decoded?.textContent ?? ""}`.toLowerCase(),
        vk: el.dataset.vk ?? "",
      });
    }
  };

  const typeOptions = (): void => {
    if (!typeSel) return;
    const kinds = new Set<string>();
    for (const r of recs) if (r.vk) kinds.add(r.vk);
    const cur = typeSel.value;
    const opts = ['<option value="">all value types</option>'];
    for (const k of [...kinds].sort()) opts.push(`<option value="${k}">${k}</option>`);
    typeSel.innerHTML = opts.join("");
    if (cur && kinds.has(cur)) typeSel.value = cur;
  };

  const apply = (): void => {
    const q = (search?.value ?? "").trim().toLowerCase();
    const t = typeSel?.value ?? "";
    const filtering = !!q || !!t;
    let shown = 0;
    for (const r of recs) {
      const ok = (!q || r.text.includes(q)) && (!t || r.vk === t);
      r.entry.hidden = !ok;
      if (ok) shown++;
    }
    if (countEl) {
      countEl.textContent = filtering
        ? `${shown} of ${recs.length} shown`
        : hasMore
          ? `${recs.length} loaded`
          : `all ${recs.length} entries`;
    }
  };

  const setAll = (open: boolean): void => {
    for (const r of recs) if (!r.entry.hidden) r.entry.open = open;
    for (const n of Array.from(list.querySelectorAll<HTMLDetailsElement>("details.stg-node"))) n.open = open;
  };

  const loadMore = async (): Promise<boolean> => {
    if (!moreBtn || !list) return false;
    const contract = list.dataset.contract ?? "";
    moreBtn.disabled = true;
    const label = moreBtn.textContent;
    moreBtn.textContent = "loading…";
    try {
      const res = await fetch(`/contracts/${encodeURIComponent(contract)}/storage?skip=${recs.length}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tpl = document.createElement("template");
      tpl.innerHTML = (await res.text()).trim();
      const batch = tpl.content.firstElementChild as HTMLElement | null;
      if (!batch || !batch.hasAttribute("data-stg-batch")) throw new Error("bad batch");
      list.appendChild(batch);
      index(batch);
      hasMore = batch.getAttribute("data-more") === "1";
      if (!hasMore && moreRow) moreRow.hidden = true;
      moreBtn.disabled = false;
      moreBtn.textContent = label ?? "Load more entries";
      typeOptions();
      apply();
      return true;
    } catch {
      moreBtn.disabled = false;
      moreBtn.textContent = "load failed — retry";
      return false;
    }
  };

  list.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const copyBtn = target.closest<HTMLElement>("[data-stg-copy]");
    if (copyBtn) {
      const entry = copyBtn.closest(".stg-entry");
      if (!entry) return;
      const which = copyBtn.dataset.stgCopy;
      const src = which === "key"
        ? entry.querySelector<HTMLElement>(".stg-rawkey")
        : entry.querySelector<HTMLElement>(".stg-raw");
      copyText(src?.textContent ?? "", copyBtn);
      ev.preventDefault();
      return;
    }
    const modeBtn = target.closest<HTMLElement>("[data-stg-mode]");
    if (modeBtn) {
      const entry = modeBtn.closest(".stg-entry");
      if (!entry) return;
      const mode = modeBtn.dataset.stgMode;
      for (const b of Array.from(entry.querySelectorAll<HTMLElement>("[data-stg-mode]"))) {
        b.classList.toggle("on", b === modeBtn);
      }
      const decoded = entry.querySelector<HTMLElement>(".stg-decoded");
      const raw = entry.querySelector<HTMLElement>(".stg-raw");
      if (decoded) decoded.hidden = mode !== "decoded";
      if (raw) raw.hidden = mode !== "raw";
      ev.preventDefault();
    }
  });

  search?.addEventListener("input", apply);
  typeSel?.addEventListener("change", apply);
  moreBtn?.addEventListener("click", () => void loadMore());
  expandBtn?.addEventListener("click", () => setAll(true));
  collapseBtn?.addEventListener("click", () => setAll(false));

  index(list);
  typeOptions();
  apply();
}
