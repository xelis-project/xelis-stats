// Rebuild the browser decompiler wasm and drop the artifacts into
// public/decompiler. Requires Rust (nightly with rust-src), wasm-pack and a
// clang that can target wasm32. Normal `npm run build` never needs this: the
// committed public/decompiler artifacts are copied verbatim by Vite.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "decompiler");

// xelis_common's getrandom backend for wasm32.
const rustflags = `${process.env.RUSTFLAGS ?? ""} --cfg getrandom_backend="wasm_js"`.trim();

rmSync(out, { recursive: true, force: true });

const args = [
  "build",
  "--release",
  "--target",
  "web",
  "--no-typescript",
  "--no-package",
  "--out-dir",
  out,
  "--out-name",
  "decompiler",
  here,
];

const result = spawnSync("wasm-pack", args, {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, RUSTFLAGS: rustflags },
});

if (result.error) {
  console.error(
    "failed to run wasm-pack; install it with `cargo install wasm-pack`",
    result.error.message,
  );
  process.exit(1);
}

if (result.status === 0) {
  // wasm-pack writes a pkg .gitignore that would hide the committed artifact.
  rmSync(join(out, ".gitignore"), { force: true });
  console.log(`built wasm -> ${out}`);
}
process.exit(result.status ?? 1);
