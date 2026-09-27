//! Browser (WASM) bridge to the upstream Silex decompiler.
//!
//! The contract page fetches a deployed contract module over RPC and hands the
//! raw JSON to this function, which reconstructs best-effort Silex source using
//! the same decompiler crate the `silex decompile` CLI uses. The Silex
//! environment (syscall / opaque / hook catalog) is the on-chain one, built
//! from `xelis_common`, so syscall names resolve exactly as they do on node.

use console_error_panic_hook::set_once;
use silex_bytecode::Module;
use silex_decompiler::Decompiler;
use wasm_bindgen::prelude::*;
use xelis_common::contract::{build_environment, ContractVersion};
use xelis_common::transaction::mock::MockStorageProvider;

/// Reconstruct Silex source from a contract module JSON payload.
///
/// Accepts either the `get_contract_module` response shape
/// (`{ "version": "v1", "module": { ... } }`) or a bare module object.
#[wasm_bindgen]
pub fn decompile(module_json: &str) -> Result<String, JsValue> {
    set_once();

    let root: serde_json::Value = serde_json::from_str(module_json)
        .map_err(|e| JsValue::from_str(&format!("invalid module JSON: {e}")))?;

    let (version, module_value) = match root.get("module") {
        Some(module) => {
            let version = root
                .get("version")
                .and_then(|v| v.as_str())
                .and_then(|v| v.parse::<ContractVersion>().ok())
                .unwrap_or(ContractVersion::V1);
            (version, module.clone())
        }
        // Older/other RPC shapes sometime return the bare module.
        None => (ContractVersion::V1, root.clone()),
    };

    let module: Module = serde_json::from_value(module_value)
        .map_err(|e| JsValue::from_str(&format!("invalid contract module: {e}")))?;

    let environment = build_environment::<MockStorageProvider>(version);
    Decompiler::new(&module, &environment)
        .decompile()
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
