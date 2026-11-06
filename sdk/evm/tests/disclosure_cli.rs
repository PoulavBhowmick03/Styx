//! The reviewer's tool, through its real binary: keys, refusals, and what it will not read.

use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{json, Value};

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_styx-disclosure"))
}

fn run_bytes(root: &Path, bytes: &[u8]) -> Output {
    let mut child = Command::new(binary())
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(bytes).unwrap();
    child.wait_with_output().unwrap()
}

fn run(root: &Path, request: Value) -> (Output, Value) {
    let output = run_bytes(root, request.to_string().as_bytes());
    let value = serde_json::from_slice(&output.stdout).unwrap();
    (output, value)
}

fn temp() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("styx-cli-{}-{:?}", std::process::id(), std::thread::current().id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    directory
}

#[test]
fn version_lists_only_the_vault_methods() {
    let root = temp();
    let (output, value) = run(&root, json!({"method": "version"}));
    assert!(output.status.success());
    assert_eq!(
        value["methods"],
        json!(["version", "keygen", "key_info", "export_vault_payment", "verify_vault_payment"])
    );
}

#[test]
fn keygen_never_replaces_a_key_and_key_info_recovers_it() {
    let root = temp();
    let key = root.join("key");
    let (_, created) = run(&root, json!({"method": "keygen", "key_file": key}));
    assert_eq!(created["status"], "ok");
    let (_, info) = run(&root, json!({"method": "key_info", "key_file": key}));
    assert_eq!(info["recipient_public_key"], created["recipient_public_key"]);
    let (output, again) = run(&root, json!({"method": "keygen", "key_file": key}));
    assert!(!output.status.success());
    assert_eq!(again["status"], "error");
}

#[test]
fn a_key_other_users_can_read_is_refused() {
    let root = temp();
    let key = root.join("key");
    run(&root, json!({"method": "keygen", "key_file": key}));
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    let (output, value) = run(&root, json!({"method": "key_info", "key_file": key}));
    assert!(!output.status.success());
    assert_eq!(value["status"], "error");
}

#[test]
fn malformed_unknown_and_oversized_requests_do_not_echo_input() {
    let root = temp();
    for request in [
        b"not json {secret".to_vec(),
        br#"{"method":"select","secret":"x"}"#.to_vec(),
        vec![b'x'; 70 * 1024],
    ] {
        let output = run_bytes(&root, &request);
        assert!(!output.status.success());
        assert!(!String::from_utf8_lossy(&output.stdout).contains("secret"));
    }
}
