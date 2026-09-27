// Contract bytecode viewer: toggles between the server-rendered opcode
// disassembly and a best-effort Silex source reconstruction produced by the
// upstream decompiler compiled to wasm (see wasm/ and public/decompiler).
//
// The wasm glue and the module JSON are only fetched when the reader first
// opens the "Decompiled source" tab, so contract pages that stay on the
// disassembly view never pay for them.

import { copyText } from "./storage";

interface DecompilerGlue {
  default: (input?: BufferSource | WebAssembly.Module) => Promise<unknown>;
  decompile: (moduleJson: string) => string;
}

let gluePromise: Promise<DecompilerGlue> | null = null;

function loadGlue(): Promise<DecompilerGlue> {
  if (!gluePromise) {
    // public/ asset, copied verbatim; resolved at runtime so Vite does not try
    // to bundle the emscripten-style glue.
    const url = "/decompiler/decompiler.js";
    gluePromise = import(/* @vite-ignore */ url)
      .then(async (mod: DecompilerGlue) => {
        await mod.default();
        return mod;
      })
      .catch((err: unknown) => {
        gluePromise = null;
        throw err;
      });
  }
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
  const copyBtn = document.getElementById("bc-source-copy") as HTMLButtonElement | null;
  const dlBtn = document.getElementById("bc-source-download") as HTMLButtonElement | null;

  let moduleJson: string | null = null;
  let sourceText: string | null = null;
  let loading = false;

  const render = (text: string, failed: boolean): void => {
    if (source) {
      source.textContent = text;
      source.classList.toggle("bc-source-err", failed);
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
      sourceText = glue.decompile(moduleJson);
      render(sourceText, false);
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
