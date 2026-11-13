//! The factory embeds the vault's wasm (`include_bytes!` in src/lib.rs). On a clean checkout that
//! file does not exist yet, so build it here through contracts/near/build.sh, which adds the `near`
//! cfg near-sdk needs to report panics by name. An existing wasm is reused.
use std::path::Path;
use std::process::Command;

fn main() {
    let wasm = "../styx-vault/target/near/styx_vault.wasm";
    println!("cargo:rerun-if-changed={wasm}");
    println!("cargo:rerun-if-changed=../styx-vault/src");
    println!("cargo:rerun-if-changed=../styx-vault/Cargo.toml");
    if Path::new(wasm).exists() {
        return;
    }
    let mut build = Command::new("../build.sh");
    build.arg("../styx-vault");
    // This script runs inside another cargo build; its settings must not leak into the vault's.
    for (key, _) in std::env::vars() {
        if key.starts_with("CARGO") || key.starts_with("RUSTC") || key.starts_with("RUSTFLAGS") || key == "TARGET" || key == "HOST" || key == "OUT_DIR" || key == "OPT_LEVEL" || key == "PROFILE" || key == "DEBUG" || key == "NUM_JOBS" {
            build.env_remove(key);
        }
    }
    let status = build.status().expect("run contracts/near/build.sh for the vault");
    assert!(status.success(), "building the vault wasm failed; run contracts/near/build.sh contracts/near/styx-vault");
}
