// Filter popups on server-rendered table pages (src/server/filters.ts renders
// the markup). Toggles the popup per button, closes on outside click or
// Escape, and drops empty params before submit so URLs stay clean.

function closeAll(): void {
  document.querySelectorAll<HTMLElement>(".filter-pop").forEach((p) => { p.hidden = true; });
  document.querySelectorAll<HTMLElement>(".filter-toggle.on").forEach((b) => {
    b.classList.remove("on");
    b.setAttribute("aria-expanded", "false");
  });
}

export function initFilterPops(): void {
  document.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const btn = target.closest<HTMLElement>("[data-filter]");
    if (btn) {
      const pop = document.getElementById(btn.dataset.filter ?? "");
      if (!pop) return;
      const wasOpen = !pop.hidden;
      closeAll();
      if (!wasOpen) {
        pop.hidden = false;
        btn.classList.add("on");
        btn.setAttribute("aria-expanded", "true");
      }
      return;
    }
    if (!target.closest(".filter-pop")) closeAll();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeAll();
  });
  // empty inputs would show up as ?type=&…; disable them before submit
  document.addEventListener("submit", (ev) => {
    const form = (ev.target as HTMLElement).closest(".filter-pop form");
    if (!form) return;
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input:not([type=hidden]), select").forEach((el) => {
      if (!el.value) el.disabled = true;
    });
  });
}
