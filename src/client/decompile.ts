// Contract bytecode viewer: toggles between the server-rendered opcode
// disassembly and a best-effort Silex source reconstruction produced by the
// upstream decompiler compiled to wasm (see wasm/ and public/decompiler).
//
// The wasm glue and the module JSON are only fetched when the reader first
// opens the "Decompiled source" tab, so contract pages that stay on the
// disassembly view never pay for them.

import { copyText } from "./storage";

interface Glue {
  decompile: (moduleJson: string) => string;
}

const READY_EVENT = "xelis-decompiler-ready";

interface ReadyDetail {
  decompile?: (moduleJson: string) => string;
  error?: string;
}

let gluePromise: Promise<Glue> | null = null;

function loadGlue(): Promise<Glue> {
  if (gluePromise) return gluePromise;
  gluePromise = new Promise<Glue>((resolve, reject) => {
    window.addEventListener(
      READY_EVENT,
      (event) => {
        const detail = (event as CustomEvent<ReadyDetail>).detail;
        if (detail.decompile) resolve({ decompile: detail.decompile });
        else reject(new Error(detail.error ?? "decompiler failed to load"));
      },
      { once: true },
    );

    // public/ is copied verbatim and Vite refuses to import it from source, so
    // the wasm-bindgen glue is bootstrapped with an inline module script (which
    // our CSP allows) that hands the export back through an event.
    const script = document.createElement("script");
    script.type = "module";
    script.textContent = `
      import init, { decompile } from "/decompiler/decompiler.js";
      init({ module_or_path: "/decompiler/decompiler_bg.wasm" })
        .then(() => window.dispatchEvent(new CustomEvent("${READY_EVENT}", { detail: { decompile } })))
        .catch((error) => window.dispatchEvent(new CustomEvent("${READY_EVENT}", {
          detail: { error: String((error && error.message) || error) },
        })));
    `;
    script.addEventListener("error", () => reject(new Error("failed to load the decompiler module")));
    document.head.append(script);
  }).catch((err: unknown) => {
    gluePromise = null;
    throw err;
  });
  return gluePromise;
}

export function initDecompile(): void {
  const panel = document.getElementById("bytecode");
  if (!panel) return;
  const contract = panel.dataset.contract ?? "";
  const tabs = Array.from(panel.querySelectorAll<HTMLButtonElement>("[data-bc-tab]"));
  const panes = Array.from(panel.querySelectorAll<HTMLElement>("[data-bc-pane]"));
  if (!tabs.length || !panes.length || !contract) return;

  const source = document.getElementById("bc-source") as HTMLPreElement | null;
  const warning = document.getElementById("bc-source-warning") as HTMLElement | null;
  const copyBtn = document.getElementById("bc-source-copy") as HTMLButtonElement | null;
  const dlBtn = document.getElementById("bc-source-download") as HTMLButtonElement | null;

  let moduleJson: string | null = null;
  let sourceText: string | null = null;
  let loading = false;

  const render = (text: string, failed: boolean, note: string | null = null): void => {
    if (source) {
      source.textContent = text;
      source.classList.toggle("bc-source-err", failed);
    }
    if (warning) {
      warning.textContent = note ?? "";
      warning.hidden = !note;
    }
    if (copyBtn) copyBtn.disabled = failed;
    if (dlBtn) dlBtn.disabled = failed;
  };

  const fetchSource = async (): Promise<void> => {
    if (sourceText !== null || loading) return;
    loading = true;
    render("Decompiling…", false);
    try {
      if (moduleJson === null) {
        const res = await fetch(`/api/contract/${encodeURIComponent(contract)}/module`);
        if (!res.ok) throw new Error(`module request failed (${res.status})`);
        moduleJson = JSON.stringify(await res.json());
      }
      const glue = await loadGlue();
      const payload = JSON.parse(glue.decompile(moduleJson)) as {
        source: string;
        warning?: string | null;
      };
      sourceText = payload.source;
      render(payload.source, false, payload.warning ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      render(
        `Decompilation failed: ${msg}\n\nThe Disassembly tab still shows the raw opcodes.`,
        true,
      );
    } finally {
      loading = false;
    }
  };

  const select = (name: string): void => {
    for (const tab of tabs) {
      const on = tab.dataset.bcTab === name;
      tab.classList.toggle("on", on);
      tab.setAttribute("aria-selected", String(on));
    }
    for (const pane of panes) pane.hidden = pane.dataset.bcPane !== name;
    if (name === "source") void fetchSource();
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab.dataset.bcTab ?? "disasm"));
  }

  copyBtn?.addEventListener("click", () => {
    if (sourceText && copyBtn) copyText(sourceText, copyBtn);
  });

  dlBtn?.addEventListener("click", () => {
    if (!sourceText) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([sourceText], { type: "text/plain" }));
    a.download = `${contract.slice(0, 12)}.slx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });
}
