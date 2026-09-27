use std::sync::Arc;

use silex_compiler::Compiler;
use silex_lexer::Lexer;
use silex_parser::Parser;
use xelis_common::contract::{build_environment, ContractModule, ContractVersion};
use xelis_common::transaction::mock::MockStorageProvider;
use xelis_explorer_decompiler::decompile;

fn module_json(source: &str) -> String {
    let environment = build_environment::<MockStorageProvider>(ContractVersion::V1);
    let tokens = Lexer::new(source)
        .collect::<Result<Vec<_>, _>>()
        .expect("source should lex");
    let (program, _) = Parser::with(tokens.into_iter(), &environment)
        .parse()
        .expect("source should parse");
    let module = Compiler::new(&program, environment.environment())
        .with_enforce_public_parameters(true)
        .compile()
        .expect("source should compile");
    let module = ContractModule {
        version: ContractVersion::V1,
        module: Arc::new(module),
    };
    serde_json::to_string(&module).expect("module should serialize")
}

fn decompiled_source(json: &str) -> String {
    let payload = decompile(json).expect("module should decompile");
    let value: serde_json::Value = serde_json::from_str(&payload).expect("payload should be JSON");
    value["source"].as_str().expect("payload has source").to_string()
}

#[test]
fn decompiles_compiled_module() {
    let json = module_json("pub fn sum(a: u64, b: u64) -> u64 { return a + b; }");
    let source = decompiled_source(&json);

    assert!(source.contains("pub fn function0"), "unexpected source: {source}");
    assert!(source.contains("arg0: u64"), "unexpected source: {source}");
}

#[test]
fn accepts_bare_module_shape() {
    let json = module_json("pub fn boom() -> u64 { return 1; }");
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    let bare = serde_json::to_string(value.get("module").unwrap()).unwrap();

    let source = decompiled_source(&bare);

    assert!(source.contains("pub fn function0"), "unexpected source: {source}");
}
