//! Real CLI and Anvil tests. All signer material is generated at runtime and never printed.
use super::super::{rpc::VaultRpc, service::Request, verify::Check};
use super::{config::Config, digest, service, types::*, verify};
use crate::chain::TransactionKey;
use serde_json::{json, Value};
use std::os::unix::fs::PermissionsExt;
use std::{
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};

struct Anvil(Child);
impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
struct Chain {
    _anvil: Anvil,
    dir: tempfile::TempDir,
    url: String,
    owner_key: String,
    approver_key: String,
    pub config: Config,
    pub rpc: VaultRpc,
}
fn run(program: &str, args: &[&str], cwd: &Path) -> String {
    let out = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("local tool unavailable");
    // Do not include arguments or stderr: tool errors can contain runtime signer material.
    assert!(out.status.success(), "local tool operation failed");
    String::from_utf8(out.stdout).unwrap().trim().into()
}
fn contracts() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/evm")
}
fn deployed(output: &str) -> String {
    output
        .lines()
        .find_map(|s| s.strip_prefix("Deployed to: "))
        .expect("no deployed address")
        .to_ascii_lowercase()
}
fn address(key: &str) -> [u8; 20] {
    let raw = hex::decode(key.trim_start_matches("0x")).unwrap();
    TransactionKey::from_bytes(&raw.try_into().unwrap())
        .unwrap()
        .address()
}
impl Chain {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let cfg = dir.path().join("anvil.json");
        let child = Command::new("anvil")
            .args([
                "--silent",
                "--mnemonic-random",
                "--port",
                &port.to_string(),
                "--config-out",
            ])
            .arg(&cfg)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("Anvil unavailable");
        let anvil = Anvil(child);
        let url = format!("http://127.0.0.1:{port}");
        let rpc = VaultRpc::new(std::slice::from_ref(&url), Duration::from_secs(3), 31337).unwrap();
        for _ in 0..100 {
            if cfg.exists() && rpc.check_chain().await.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let keys: Value = serde_json::from_slice(&std::fs::read(cfg).unwrap()).unwrap();
        let key = |n: usize| keys["private_keys"][n].as_str().unwrap().to_owned();
        let owner_key = key(0);
        let agent_key = key(1);
        let approver_key = key(2);
        let deploy = |name: &str, arguments: &[&str]| {
            let mut args = vec![
                "create",
                name,
                "--broadcast",
                "--rpc-url",
                &url,
                "--private-key",
                &owner_key,
                "--constructor-args",
            ];
            args.extend_from_slice(arguments);
            deployed(&run("forge", &args, &contracts()))
        };
        let token = deploy("src/MockERC20.sol:MockERC20", &["USD Coin", "USDC"]);
        let owner = format!("0x{}", hex::encode(address(&owner_key)));
        let vault = deploy("src/StyxVault.sol:StyxVault", &[&owner, &token]);
        let key_path = dir.path().join("agent.key");
        std::fs::write(&key_path, agent_key).unwrap();
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let code_hash = rpc
            .code_hash(&parse_hex::<20>(&vault).unwrap())
            .await
            .unwrap();
        let state_root = dir.path().join("journal");
        let chain = Self {
            _anvil: anvil,
            dir,
            url: url.clone(),
            owner_key,
            approver_key,
            config: Config {
                chain_id: 31337,
                rpc_urls: vec![url],
                vault: parse_hex(&vault).unwrap(),
                token: parse_hex(&token).unwrap(),
                code_hash,
                state_root,
                agent_key_file: Some(key_path),
                receipt_timeout: Duration::from_secs(3),
                rpc_timeout: Duration::from_secs(3),
            },
            rpc,
        };
        let agent = address(
            &std::fs::read_to_string(chain.config.agent_key_file.as_ref().unwrap()).unwrap(),
        );
        chain.send(
            "configureAgent(address,uint256,uint256,uint64,bool)",
            &[
                &format!("0x{}", hex::encode(agent)),
                "1000000",
                "10000000",
                "1900000000",
                "true",
            ],
        );
        chain.send(
            "setApprover(address,bool)",
            &[
                &format!("0x{}", hex::encode(address(&chain.approver_key))),
                "true",
            ],
        );
        chain.send(
            "setRecipient(address,bool)",
            &["0x00000000000000000000000000000000000000a1", "true"],
        );
        chain.send("setVaultDailyLimit(uint256)", &["15000000"]);
        run(
            "cast",
            &[
                "send",
                &token,
                "mint(address,uint256)",
                &vault,
                "50000000",
                "--rpc-url",
                &chain.url,
                "--private-key",
                &chain.owner_key,
            ],
            Path::new("."),
        );
        chain
    }
    fn send(&self, sig: &str, args: &[&str]) {
        let vault = format!("0x{}", hex::encode(self.config.vault));
        let mut call = vec!["send", &vault, sig];
        call.extend_from_slice(args);
        call.extend(["--rpc-url", &self.url, "--private-key", &self.owner_key]);
        run("cast", &call, Path::new("."));
    }
    fn cli(&self, request: Value) -> Value {
        self.cli_config(request, &self.config)
    }
    fn cli_config(&self, request: Value, cfg: &Config) -> Value {
        let binary = std::env::var_os("STYX_VAULT_TEST_BINARY")
            .expect("build the vault CLI and set STYX_VAULT_TEST_BINARY");
        let mut cmd = Command::new(binary);
        cmd.env_clear()
            .env("STYX_VAULT_VERSION", "2")
            .env("STYX_VAULT_CHAIN_ID", cfg.chain_id.to_string())
            .env("STYX_VAULT_RPC_URLS", cfg.rpc_urls.join(","))
            .env(
                "STYX_VAULT_ADDRESS",
                format!("0x{}", hex::encode(cfg.vault)),
            )
            .env("STYX_VAULT_TOKEN", format!("0x{}", hex::encode(cfg.token)))
            .env(
                "STYX_VAULT_CODE_HASH",
                format!("0x{}", hex::encode(cfg.code_hash)),
            )
            .env("STYX_VAULT_STATE_ROOT", &cfg.state_root)
            .env(
                "STYX_VAULT_RECEIPT_TIMEOUT_SECONDS",
                cfg.receipt_timeout.as_secs().to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(path) = &cfg.agent_key_file {
            cmd.env("STYX_VAULT_AGENT_KEY_FILE", path);
        }
        let mut child = cmd.spawn().unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        serde_json::from_slice(&output.stdout).expect("CLI did not return JSON")
    }
    async fn propose(&self, amount: &str) -> String {
        let invoice = self.dir.path().join(format!("invoice-{amount}"));
        std::fs::write(&invoice, b"runtime invoice").unwrap();
        let r=self.cli(json!({"method":"propose","recipient":"0x00000000000000000000000000000000000000a1","amount":amount,
            "invoice_file":invoice,"invoice_reference":"local integration","valid_until":self.rpc.latest_timestamp().await.unwrap()+3600}));
        assert_eq!(r["status"], "ok", "proposal failed: {r}");
        r["payment_id"].as_str().unwrap().into()
    }
    fn approval(&self, id: &str, signer: Option<String>) -> (PendingApproval, PathBuf) {
        let path = self.dir.path().join(format!("pending-{}.json", &id[2..]));
        let mut request = json!({"method":"request_approval","payment_id":id,"authorization_expiry":1890000000,"pending_file":path});
        if let Some(s) = signer {
            request["signer"] = s.into();
        }
        let r = self.cli(request);
        assert_eq!(r["status"], "ok", "approval request failed: {r}");
        (
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap(),
            self.dir.path().join(format!("signature-{}.json", &id[2..])),
        )
    }
    fn signature(&self, pending: &PendingApproval, path: &Path, keys: &[&str]) {
        let digest = digest::approval_digest(
            self.config.chain_id,
            &self.config.vault,
            &pending.authorization,
        );
        let mut signature = Vec::new();
        for k in keys {
            let raw: [u8; 32] = hex::decode(k.trim_start_matches("0x"))
                .unwrap()
                .try_into()
                .unwrap();
            let signing = k256::ecdsa::SigningKey::from_bytes((&raw).into()).unwrap();
            let (sig, recovery) = signing.sign_prehash_recoverable(&digest).unwrap();
            signature.extend(sig.to_bytes());
            signature.push(recovery.to_byte() + 27);
        }
        let file = ApproverSignature {
            schema: SIGNATURE_SCHEMA.into(),
            payment_id: pending.payment.payment_id,
            approval_digest: digest,
            signer: pending.authorization.signer,
            signer_version: pending.authorization.signer_version,
            signature,
        };
        std::fs::write(path, serde_json::to_vec(&file).unwrap()).unwrap();
    }
    fn export(&self, id: &str) -> verify::PaymentRecord {
        let path = self.dir.path().join(format!("record-{}.json", &id[2..]));
        let r = self.cli(json!({"method":"export_record","payment_id":id,"record_file":path}));
        assert_eq!(r["status"], "ok", "export failed: {r}");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_ordinary_approver_exception_and_independent_record_verification() {
    let c = Chain::start().await;
    let id = c.propose("250000").await;
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id}))["state"],
        "settled"
    );
    let ordinary = c.export(&id);
    let verification = c.cli(json!({"method":"verify_record","record_file":c.dir.path().join(format!("record-{}.json",&id[2..]))}));
    assert_eq!(verification["report"]["settlement"], "verified");
    let report = verify::verify_record(&ordinary, &c.rpc, &c.config.code_hash).await;
    assert_eq!(report.settlement, Check::Verified);
    assert_eq!(report.authorization, Check::NotApplicable);
    let id = c.propose("6000000").await;
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id}))["code"],
        "OWNER_APPROVAL_REQUIRED"
    );
    let (pending, path) = c.approval(
        &id,
        Some(format!("0x{}", hex::encode(address(&c.approver_key)))),
    );
    c.signature(&pending, &path, &[&c.approver_key]);
    c.send(
        "configureAgent(address,uint256,uint256,uint64,bool)",
        &[
            "0x0000000000000000000000000000000000000b0b",
            "1000000",
            "10000000",
            "1900000000",
            "true",
        ],
    );
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id,"signature_file":path}))["state"],
        "settled"
    );
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id}))["state"],
        "settled"
    );
    let record = c.export(&id);
    let report = verify::verify_record(&record, &c.rpc, &c.config.code_hash).await;
    assert_eq!(report.settlement, Check::Verified);
    assert_eq!(report.authorization, Check::Verified);
    assert_eq!(report.policy_at_execution, Check::Verified);
    let mut bad = record.clone();
    bad.signature.as_mut().unwrap().signature[0] ^= 1;
    assert_eq!(
        verify::verify_record(&bad, &c.rpc, &c.config.code_hash)
            .await
            .settlement,
        Check::Failed
    );
    let mut bad = record.clone();
    bad.chain_id = 1;
    assert_eq!(
        verify::verify_record(&bad, &c.rpc, &c.config.code_hash)
            .await
            .settlement,
        Check::Failed
    );
    c.send(
        "setApprover(address,bool)",
        &[
            &format!("0x{}", hex::encode(address(&c.approver_key))),
            "false",
        ],
    );
    // Revoking a signer today cannot invalidate evidence of yesterday's successful execution.
    assert_eq!(
        verify::verify_record(&record, &c.rpc, &c.config.code_hash)
            .await
            .authorization,
        Check::Verified
    );
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_timeout_rebroadcasts_once_and_rejects_changed_deployment_before_broadcast() {
    let c = Chain::start().await;
    let id = c.propose("250000").await;
    run(
        "cast",
        &["rpc", "anvil_setAutomine", "false", "--rpc-url", &c.url],
        Path::new("."),
    );
    let mut cfg = c.config.clone();
    cfg.receipt_timeout = Duration::ZERO;
    assert_eq!(
        c.cli_config(json!({"method":"submit","payment_id":id}), &cfg)["state"],
        "unknown"
    );
    let owner = format!("0x{}", hex::encode(address(&c.owner_key)));
    let token = format!("0x{}", hex::encode(cfg.token));
    // Use a different random account to deploy B after restoring automining, then stop mining again.
    run(
        "cast",
        &["rpc", "anvil_setAutomine", "true", "--rpc-url", &c.url],
        Path::new("."),
    );
    run(
        "cast",
        &["rpc", "evm_mine", "--rpc-url", &c.url],
        Path::new("."),
    );
    let b = deployed(&run(
        "forge",
        &[
            "create",
            "src/StyxVault.sol:StyxVault",
            "--broadcast",
            "--rpc-url",
            &c.url,
            "--private-key",
            &c.owner_key,
            "--constructor-args",
            &owner,
            &token,
        ],
        &contracts(),
    ));
    let mut wrong = cfg.clone();
    wrong.vault = parse_hex(&b).unwrap();
    wrong.code_hash = c.rpc.code_hash(&wrong.vault).await.unwrap();
    let r = c.cli_config(json!({"method":"submit","payment_id":id}), &wrong);
    assert_eq!(r["code"], "INVALID_REQUEST");
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id}))["state"],
        "settled"
    );
    let record = c.export(&id);
    assert_eq!(record.policy.amount, 250000);
    assert_eq!(
        c.rpc
            .view_u128(
                &cfg.token,
                &super::abi::call(
                    "balanceOf(address)",
                    &[super::abi::address(&record.payment.recipient)]
                )
            )
            .await
            .unwrap(),
        250000
    );
    // A separate unresolved payment exercises an exact raw-byte resend while automining remains disabled.
    let id = c.propose("300000").await;
    run(
        "cast",
        &["rpc", "anvil_setAutomine", "false", "--rpc-url", &c.url],
        Path::new("."),
    );
    let first = c.cli_config(json!({"method":"submit","payment_id":id}), &cfg);
    let second = c.cli_config(json!({"method":"submit","payment_id":id}), &cfg);
    assert_eq!(first["state"], "unknown");
    assert_eq!(second["tx_hash"], first["tx_hash"]);
    run(
        "cast",
        &["rpc", "anvil_setAutomine", "true", "--rpc-url", &c.url],
        Path::new("."),
    );
    run(
        "cast",
        &["rpc", "evm_mine", "--rpc-url", &c.url],
        Path::new("."),
    );
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id}))["state"],
        "settled"
    );
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_contract_approver_accepts_arbitrary_length_signature() {
    let c = Chain::start().await;
    let first = format!("0x{}", hex::encode(address(&c.owner_key)));
    let second = format!("0x{}", hex::encode(address(&c.approver_key)));
    let wallet = deployed(&run(
        "forge",
        &[
            "create",
            "test/StyxVault.t.sol:ThresholdSignerV2",
            "--broadcast",
            "--rpc-url",
            &c.url,
            "--private-key",
            &c.owner_key,
            "--constructor-args",
            &first,
            &second,
        ],
        &contracts(),
    ));
    c.send("setApprover(address,bool)", &[&wallet, "true"]);
    let id = c.propose("2000000").await;
    let (pending, path) = c.approval(&id, Some(wallet));
    c.signature(&pending, &path, &[&c.owner_key, &c.approver_key]);
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id,"signature_file":path}))["state"],
        "settled"
    );
    let record = c.export(&id);
    assert_eq!(record.signature.as_ref().unwrap().signature.len(), 130);
    assert_eq!(
        verify::verify_record(&record, &c.rpc, &c.config.code_hash)
            .await
            .authorization,
        Check::Verified
    );
    // Direct service and CLI use the same versioned request surface.
    let result = service::handle_with_config(Request::Status { payment_id: id }, c.config.clone())
        .await
        .unwrap();
    assert_eq!(result["state"], "settled");
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_contract_owner_requires_threshold_signature_and_direct_owner_execution() {
    let c = Chain::start().await;
    let first = format!("0x{}", hex::encode(address(&c.owner_key)));
    let second = format!("0x{}", hex::encode(address(&c.approver_key)));
    let wallet = deployed(&run(
        "forge",
        &[
            "create",
            "test/StyxVault.t.sol:ThresholdSignerV2",
            "--broadcast",
            "--rpc-url",
            &c.url,
            "--private-key",
            &c.owner_key,
            "--constructor-args",
            &first,
            &second,
        ],
        &contracts(),
    ));
    let token = format!("0x{}", hex::encode(c.config.token));
    let vault = deployed(&run(
        "forge",
        &[
            "create",
            "src/StyxVault.sol:StyxVault",
            "--broadcast",
            "--rpc-url",
            &c.url,
            "--private-key",
            &c.owner_key,
            "--constructor-args",
            &wallet,
            &token,
        ],
        &contracts(),
    ));
    let agent_key = std::fs::read_to_string(c.config.agent_key_file.as_ref().unwrap()).unwrap();
    let agent = address(&agent_key);
    let operations = [
        super::abi::call(
            "configureAgent(address,uint256,uint256,uint64,bool)",
            &[
                super::abi::address(&agent),
                super::abi::uint(1000000),
                super::abi::uint(10000000),
                super::abi::uint(1900000000),
                super::abi::uint(1),
            ],
        ),
        super::abi::call(
            "setRecipient(address,bool)",
            &[
                super::abi::address(
                    &parse_hex("0x00000000000000000000000000000000000000a1").unwrap(),
                ),
                super::abi::uint(1),
            ],
        ),
        super::abi::call("setVaultDailyLimit(uint256)", &[super::abi::uint(10000000)]),
    ];
    for input in operations {
        run(
            "cast",
            &[
                "send",
                &wallet,
                "execute(address,bytes)",
                &vault,
                &format!("0x{}", hex::encode(input)),
                "--rpc-url",
                &c.url,
                "--private-key",
                &c.owner_key,
            ],
            Path::new("."),
        );
    }
    run(
        "cast",
        &[
            "send",
            &token,
            "mint(address,uint256)",
            &vault,
            "10000000",
            "--rpc-url",
            &c.url,
            "--private-key",
            &c.owner_key,
        ],
        Path::new("."),
    );
    let mut config = c.config.clone();
    config.vault = parse_hex(&vault).unwrap();
    config.code_hash = c.rpc.code_hash(&config.vault).await.unwrap();
    let invoice = c.dir.path().join("owner-contract-invoice");
    std::fs::write(&invoice, b"threshold invoice").unwrap();
    let proposal=c.cli_config(json!({"method":"propose","recipient":"0x00000000000000000000000000000000000000a1","amount":"2000000","invoice_file":invoice,"invoice_reference":"threshold","valid_until":1890000000}),&config);
    assert_eq!(proposal["status"], "ok");
    let id = proposal["payment_id"].as_str().unwrap();
    let pending_file = c.dir.path().join("owner-pending.json");
    let signature_file = c.dir.path().join("owner-signature.json");
    let r=c.cli_config(json!({"method":"request_approval","payment_id":id,"pending_file":pending_file,"authorization_expiry":1890000000}),&config);
    assert_eq!(r["status"], "ok");
    let pending: PendingApproval =
        serde_json::from_slice(&std::fs::read(pending_file).unwrap()).unwrap();
    assert_eq!(
        pending.authorization.signer,
        parse_hex::<20>(&wallet).unwrap()
    );
    assert_eq!(pending.authorization.signer_version, 0);
    // Sign against the replacement deployment, not the original harness vault.
    let digest = digest::approval_digest(config.chain_id, &config.vault, &pending.authorization);
    let mut bytes = Vec::new();
    for key in [&c.owner_key, &c.approver_key] {
        let raw: [u8; 32] = hex::decode(key.trim_start_matches("0x"))
            .unwrap()
            .try_into()
            .unwrap();
        let signing = k256::ecdsa::SigningKey::from_bytes((&raw).into()).unwrap();
        let (sig, recovery) = signing.sign_prehash_recoverable(&digest).unwrap();
        bytes.extend(sig.to_bytes());
        bytes.push(recovery.to_byte() + 27);
    }
    let mut signature = ApproverSignature {
        schema: SIGNATURE_SCHEMA.into(),
        payment_id: pending.payment.payment_id,
        approval_digest: digest,
        signer: pending.authorization.signer,
        signer_version: 0,
        signature: bytes[..65].to_vec(),
    };
    std::fs::write(&signature_file, serde_json::to_vec(&signature).unwrap()).unwrap();
    assert_eq!(
        c.cli_config(
            json!({"method":"submit","payment_id":id,"signature_file":signature_file}),
            &config
        )["code"],
        "OWNER_APPROVAL_REQUIRED"
    );
    signature.signature = bytes;
    std::fs::write(&signature_file, serde_json::to_vec(&signature).unwrap()).unwrap();
    assert_eq!(
        c.cli_config(
            json!({"method":"submit","payment_id":id,"signature_file":signature_file}),
            &config
        )["state"],
        "settled"
    );
    let record_file = c.dir.path().join("owner-record.json");
    assert_eq!(
        c.cli_config(
            json!({"method":"export_record","payment_id":id,"record_file":record_file}),
            &config
        )["status"],
        "ok"
    );
    let record: verify::PaymentRecord =
        serde_json::from_slice(&std::fs::read(record_file).unwrap()).unwrap();
    assert_eq!(
        verify::verify_record(&record, &c.rpc, &config.code_hash)
            .await
            .authorization,
        Check::Verified
    );
    let withdrawal = super::abi::call(
        "withdraw(address,uint256)",
        &[
            super::abi::address(&address(&c.owner_key)),
            super::abi::uint(1),
        ],
    );
    let direct = c
        .rpc
        .call(Some(&address(&c.owner_key)), &config.vault, &withdrawal)
        .await
        .unwrap();
    assert!(matches!(
        direct,
        super::super::rpc::CallOutcome::Reverted(_)
    ));
    run(
        "cast",
        &[
            "send",
            &wallet,
            "execute(address,bytes)",
            &vault,
            &format!("0x{}", hex::encode(withdrawal)),
            "--rpc-url",
            &c.url,
            "--private-key",
            &c.owner_key,
        ],
        Path::new("."),
    );
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_unsubmitted_payment_can_change_approver_without_changing_payment_id() {
    let c = Chain::start().await;
    let id = c.propose("2000000").await;
    let (old, path) = c.approval(
        &id,
        Some(format!("0x{}", hex::encode(address(&c.approver_key)))),
    );
    c.signature(&old, &path, &[&c.approver_key]);
    c.send(
        "setApprover(address,bool)",
        &[
            &format!("0x{}", hex::encode(address(&c.approver_key))),
            "false",
        ],
    );
    let pending_file = c.dir.path().join("replacement-approval.json");
    let response=c.cli(json!({"method":"request_approval","payment_id":id,"authorization_expiry":1890000000,"pending_file":pending_file}));
    assert_eq!(
        response["status"], "ok",
        "a new signer must preserve the exact payment ID"
    );
    let new: PendingApproval =
        serde_json::from_slice(&std::fs::read(pending_file).unwrap()).unwrap();
    assert_eq!(new.payment.payment_id, old.payment.payment_id);
    assert_eq!(new.payment, old.payment);
    assert_ne!(new.authorization.signer, old.authorization.signer);
    assert_ne!(
        new.authorization.approval_nonce,
        old.authorization.approval_nonce
    );
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id,"signature_file":path}))["code"],
        "OWNER_APPROVAL_REQUIRED"
    );
    c.signature(&new, &path, &[&c.owner_key]);
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id,"signature_file":path}))["state"],
        "settled"
    );
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_retained_signed_transaction_cannot_bypass_later_approver_removal() {
    let c = Chain::start().await;
    let id = c.propose("2000000").await;
    let (pending, path) = c.approval(
        &id,
        Some(format!("0x{}", hex::encode(address(&c.approver_key)))),
    );
    c.signature(&pending, &path, &[&c.approver_key]);
    run(
        "cast",
        &["rpc", "anvil_setAutomine", "false", "--rpc-url", &c.url],
        Path::new("."),
    );
    let mut config = c.config.clone();
    config.receipt_timeout = Duration::ZERO;
    let response = c.cli_config(
        json!({"method":"submit","payment_id":id,"signature_file":path}),
        &config,
    );
    assert_eq!(response["state"], "unknown");
    let hash = response["tx_hash"].as_str().unwrap();
    // Anvil's drop RPC lets removal execute before the identical retained transaction is resent.
    run(
        "cast",
        &["rpc", "anvil_dropTransaction", hash, "--rpc-url", &c.url],
        Path::new("."),
    );
    run(
        "cast",
        &["rpc", "anvil_setAutomine", "true", "--rpc-url", &c.url],
        Path::new("."),
    );
    c.send(
        "setApprover(address,bool)",
        &[
            &format!("0x{}", hex::encode(address(&c.approver_key))),
            "false",
        ],
    );
    let retry = c.cli(json!({"method":"submit","payment_id":id}));
    assert_eq!(retry["state"], "reverted");
    assert_eq!(retry["tx_hash"], response["tx_hash"]);
    assert!(!c
        .rpc
        .view_bool(
            &config.vault,
            &super::abi::encode_consumed_payment(&pending.payment.payment_id)
        )
        .await
        .unwrap());
    assert!(!c
        .rpc
        .view_bool(
            &config.vault,
            &super::abi::call(
                "consumedApprovalNonce(address,uint256)",
                &[
                    super::abi::address(&pending.authorization.signer),
                    super::abi::uint(pending.authorization.approval_nonce)
                ]
            )
        )
        .await
        .unwrap());
    assert_eq!(
        c.rpc
            .view_u128(
                &config.token,
                &super::abi::call(
                    "balanceOf(address)",
                    &[super::abi::address(&pending.payment.recipient)]
                )
            )
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id}))["code"],
        "OWNER_APPROVAL_REQUIRED"
    );
}

#[tokio::test]
#[ignore = "requires Anvil, Foundry and STYX_VAULT_TEST_BINARY"]
async fn cli_expired_approval_refresh_preserves_payment_and_rejects_old_signature() {
    let c = Chain::start().await;
    let id = c.propose("2000000").await;
    let old_file = c.dir.path().join("short-approval.json");
    let new_file = c.dir.path().join("fresh-approval.json");
    let sig_file = c.dir.path().join("refresh-signature.json");
    let now = c.rpc.latest_timestamp().await.unwrap();
    assert_eq!(c.cli(json!({"method":"request_approval","payment_id":id,"authorization_expiry":now+1,"pending_file":old_file}))["status"],"ok");
    let old: PendingApproval = serde_json::from_slice(&std::fs::read(old_file).unwrap()).unwrap();
    c.signature(&old, &sig_file, &[&c.owner_key]);
    run(
        "cast",
        &["rpc", "evm_increaseTime", "2", "--rpc-url", &c.url],
        Path::new("."),
    );
    run(
        "cast",
        &["rpc", "evm_mine", "--rpc-url", &c.url],
        Path::new("."),
    );
    assert_eq!(c.cli(json!({"method":"request_approval","payment_id":id,"authorization_expiry":now+300,"pending_file":new_file}))["status"],"ok");
    let fresh: PendingApproval = serde_json::from_slice(&std::fs::read(new_file).unwrap()).unwrap();
    assert_eq!(fresh.payment, old.payment);
    assert_ne!(
        fresh.authorization.approval_nonce,
        old.authorization.approval_nonce
    );
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id,"signature_file":sig_file}))["code"],
        "OWNER_APPROVAL_REQUIRED"
    );
    c.signature(&fresh, &sig_file, &[&c.owner_key]);
    assert_eq!(
        c.cli(json!({"method":"submit","payment_id":id,"signature_file":sig_file}))["state"],
        "settled"
    );
}
