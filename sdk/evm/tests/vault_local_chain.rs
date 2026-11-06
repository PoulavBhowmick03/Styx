//! The whole vault flow on a local chain: the real contract, the real `erebus-vault` binary and
//! real transactions for attacks A1 to A4. Anvil's keys are read from its runtime config output.

use std::io::Write;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use erebus_evm::arc_vault::abi::{
    classify_revert, encode_pay, encode_pay_with_exception, RevertMeaning,
};
use erebus_evm::arc_vault::digest::{approval_digest, payment_hash};
use erebus_evm::arc_vault::record::VaultPaymentRecord;
use erebus_evm::arc_vault::rpc::{receipt_succeeded, CallOutcome, VaultRpc};
use erebus_evm::arc_vault::types::{parse_hex, ExceptionAuthorization, Payment, PendingApproval};
use erebus_evm::arc_vault::verify::{verify_record, Check, ReviewerPins};
use erebus_evm::chain::{build_signed_call, Eip1559Fees, TransactionKey, TransactionParams};
use serde_json::{json, Value};

const CHAIN_ID: u64 = 31_337;
const VENDOR_A: &str = "0x00000000000000000000000000000000000000a1";
const VENDOR_B: &str = "0x00000000000000000000000000000000000000b2";
const ONE_USDC: u128 = 1_000_000;

struct Anvil(Child);

impl Drop for Anvil {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Chain {
    _anvil: Anvil,
    _dir: tempfile::TempDir,
    dir: PathBuf,
    rpc_url: String,
    owner_key: String,
    agent_key: String,
    vault: String,
    token: String,
    rpc: VaultRpc,
}

fn contracts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contracts/evm")
}

fn run(program: &str, args: &[&str], cwd: &Path) -> String {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("foundry tools must be installed");
    assert!(
        output.status.success(),
        "{program} {} failed: {}",
        args.first().unwrap_or(&""),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn deployed_address(output: &str) -> String {
    output
        .lines()
        .find_map(|line| line.strip_prefix("Deployed to: "))
        .expect("deployed address")
        .trim()
        .to_ascii_lowercase()
}

fn address_of(key: &str) -> String {
    run(
        "cast",
        &["wallet", "address", "--private-key", key],
        Path::new("."),
    )
    .to_ascii_lowercase()
}

impl Chain {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let config = root.join("anvil.json");
        let child = Command::new("anvil")
            .args(["--port", &port.to_string(), "--silent", "--config-out"])
            .arg(&config)
            .stdout(Stdio::null())
            .spawn()
            .expect("anvil must be installed");
        let anvil = Anvil(child);
        let rpc_url = format!("http://127.0.0.1:{port}");
        let rpc = VaultRpc::new(
            std::slice::from_ref(&rpc_url),
            Duration::from_secs(5),
            CHAIN_ID,
        )
        .unwrap();
        for _ in 0..100 {
            if rpc.check_chain().await.is_ok() && config.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let keys: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        let key = |index: usize| keys["private_keys"][index].as_str().unwrap().to_owned();
        let (owner_key, agent_key) = (key(0), key(1));

        let contracts = contracts_dir();
        let create = |contract: &str, arguments: &[&str]| {
            let mut args = vec![
                "create",
                contract,
                "--broadcast",
                "--rpc-url",
                &rpc_url,
                "--private-key",
                &owner_key,
            ];
            args.push("--constructor-args");
            args.extend_from_slice(arguments);
            deployed_address(&run("forge", &args, &contracts))
        };
        let token = create("src/MockERC20.sol:MockERC20", &["USD Coin", "USDC"]);
        let owner = address_of(&owner_key);
        let vault = create(
            "src/ErebusPolicyVault.sol:ErebusPolicyVault",
            &[&owner, &token],
        );
        let chain = Self {
            _anvil: anvil,
            _dir: dir,
            dir: root,
            rpc_url,
            owner_key,
            agent_key,
            vault,
            token,
            rpc,
        };
        let agent = address_of(&chain.agent_key);
        let far_future = (chain.now().await + 30 * 86_400).to_string();
        let per_payment = ONE_USDC.to_string();
        let daily = (10 * ONE_USDC).to_string();
        chain.owner_send(
            "configurePolicy(address,uint256,uint256,uint64)",
            &[&agent, &per_payment, &daily, &far_future],
        );
        chain.owner_send("setRecipient(address,bool)", &[VENDOR_A, "true"]);
        chain.owner_send("setRecipient(address,bool)", &[VENDOR_B, "true"]);
        let vault_address = chain.vault.clone();
        let funding = (8 * ONE_USDC).to_string();
        run(
            "cast",
            &[
                "send",
                &chain.token,
                "mint(address,uint256)",
                &vault_address,
                &funding,
                "--rpc-url",
                &chain.rpc_url,
                "--private-key",
                &chain.owner_key,
            ],
            Path::new("."),
        );
        let key_file = chain.dir.join("agent.key");
        std::fs::write(&key_file, &chain.agent_key).unwrap();
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        chain
    }

    fn owner_send(&self, signature: &str, args: &[&str]) {
        let mut full = vec!["send", &self.vault, signature];
        full.extend_from_slice(args);
        full.extend_from_slice(&["--rpc-url", &self.rpc_url, "--private-key", &self.owner_key]);
        run("cast", &full, Path::new("."));
    }

    async fn now(&self) -> u64 {
        self.rpc.latest_timestamp().await.unwrap()
    }

    fn vault_bytes(&self) -> [u8; 20] {
        parse_hex(&self.vault).unwrap()
    }

    /// Runs the real binary with only the agent's configuration in its environment.
    fn cli(&self, request: Value, timeout_seconds: u64) -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_erebus-vault"))
            .env_clear()
            .env("EREBUS_VAULT_CHAIN_ID", CHAIN_ID.to_string())
            .env("EREBUS_VAULT_RPC_URLS", &self.rpc_url)
            .env("EREBUS_VAULT_ADDRESS", &self.vault)
            .env("EREBUS_VAULT_TOKEN", &self.token)
            .env("EREBUS_VAULT_STATE_ROOT", self.dir.join("journal"))
            .env("EREBUS_VAULT_AGENT_KEY_FILE", self.dir.join("agent.key"))
            .env(
                "EREBUS_VAULT_RECEIPT_TIMEOUT_SECONDS",
                timeout_seconds.to_string(),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(request.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        serde_json::from_slice(&output.stdout).unwrap()
    }

    async fn propose(&self, recipient: &str, amount: u128, invoice: &[u8]) -> Value {
        let name = format!("invoice-{}", hex::encode(&invoice[..invoice.len().min(8)]));
        let path = self.dir.join(name);
        std::fs::write(&path, invoice).unwrap();
        let valid_until = self.now().await + 3_600;
        let response = self.cli(
            json!({
                "method": "propose",
                "recipient": recipient,
                "amount": amount.to_string(),
                "invoice_file": path,
                "invoice_reference": "INV-1",
                "valid_until": valid_until,
            }),
            10,
        );
        assert_eq!(response["status"], "ok", "{response}");
        response
    }

    fn submit(
        &self,
        payment_id: &str,
        signature_file: Option<&Path>,
        timeout_seconds: u64,
    ) -> Value {
        let mut request = json!({"method": "submit", "payment_id": payment_id});
        if let Some(path) = signature_file {
            request["signature_file"] = json!(path);
        }
        self.cli(request, timeout_seconds)
    }

    async fn balance(&self, account: &str) -> u128 {
        let account: [u8; 20] = parse_hex(account).unwrap();
        let token: [u8; 20] = parse_hex(&self.token).unwrap();
        self.rpc
            .view_u128(&token, &erebus_evm::abi::encode_balance_of_call(&account))
            .await
            .unwrap()
    }

    /// Asks for the owner's approval and signs its digest with the owner's key, returning the
    /// pending file and signature file.
    async fn approve(&self, payment_id: &str) -> (PendingApproval, PathBuf) {
        let stem = &payment_id[2..14];
        let pending_file = self.dir.join(format!("pending-{stem}.json"));
        let expiry = self.now().await + 600;
        let response = self.cli(
            json!({
                "method": "request_approval",
                "payment_id": payment_id,
                "authorization_expiry": expiry,
                "pending_file": pending_file,
            }),
            10,
        );
        assert_eq!(response["status"], "ok", "{response}");
        let digest = response["approval_digest"].as_str().unwrap();
        let signature = self.sign_digest(&self.owner_key, digest);
        let signature_file = self.dir.join(format!("signature-{stem}.json"));
        std::fs::write(
            &signature_file,
            json!({
                "schema": "vault-owner-signature/1",
                "paymentId": payment_id,
                "approvalDigest": digest,
                "signature": signature,
            })
            .to_string(),
        )
        .unwrap();
        let pending = serde_json::from_slice(&std::fs::read(&pending_file).unwrap()).unwrap();
        (pending, signature_file)
    }

    /// `cast` returns `v` as 27 or 28, the format a wallet returns.
    fn sign_digest(&self, key: &str, digest: &str) -> String {
        run(
            "cast",
            &["wallet", "sign", "--no-hash", "--private-key", key, digest],
            Path::new("."),
        )
    }

    fn signing_key(&self) -> TransactionKey {
        let bytes: [u8; 32] = parse_hex(&self.agent_key).unwrap();
        TransactionKey::from_bytes(&bytes).unwrap()
    }

    /// The agent bypasses every tool and sends this calldata in a real transaction. Asserts the
    /// transaction reverted on chain, and returns what the simulated call reports.
    async fn attack(&self, input: Vec<u8>) -> RevertMeaning {
        let key = self.signing_key();
        let agent = key.address();
        let vault = self.vault_bytes();
        let simulated = self.rpc.call(Some(&agent), &vault, &input).await.unwrap();
        let CallOutcome::Reverted(data) = simulated else {
            panic!("the attack did not revert in simulation");
        };
        let (max_fee, priority) = self.rpc.fees().await.unwrap();
        let signed = build_signed_call(
            &key,
            CHAIN_ID,
            vault,
            input,
            TransactionParams {
                nonce: self.rpc.pending_nonce(&agent).await.unwrap(),
                fees: Eip1559Fees::new(max_fee, priority).unwrap(),
                gas_limit: 500_000,
                value: 0,
            },
        )
        .unwrap();
        self.rpc.send_raw(signed.raw()).await.unwrap();
        for _ in 0..100 {
            if let Some(receipt) = self.rpc.receipt(&signed.hash()).await.unwrap() {
                assert_eq!(receipt_succeeded(&receipt), Some(false), "attack succeeded");
                return classify_revert(&data);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("no receipt for the attack transaction");
    }

    async fn raw_rpc(&self, method: &str, params: Value) {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        run(
            "cast",
            &[
                "rpc",
                "--rpc-url",
                &self.rpc_url,
                "--raw",
                method,
                &body["params"].to_string(),
            ],
            Path::new("."),
        );
    }

    fn pins(&self, record: &VaultPaymentRecord) -> ReviewerPins {
        ReviewerPins {
            vault_code_hash: record.vault_code_hash,
        }
    }

    fn export(&self, payment_id: &str, name: &str) -> VaultPaymentRecord {
        let record_file = self.dir.join(name);
        let response = self.cli(
            json!({"method": "export_record", "payment_id": payment_id, "record_file": record_file}),
            10,
        );
        assert_eq!(response["status"], "ok", "{response}");
        serde_json::from_slice(&std::fs::read(&record_file).unwrap()).unwrap()
    }
}

fn id_of(response: &Value) -> String {
    response["payment_id"].as_str().unwrap().to_owned()
}

fn agent_bytes(chain: &Chain) -> [u8; 20] {
    chain.signing_key().address()
}

/// A payment built by hand, as an attacking agent would, skipping the tools.
fn attack_payment(
    chain: &Chain,
    id: u8,
    recipient: &str,
    amount: u128,
    valid_until: u64,
) -> Payment {
    Payment {
        payment_id: [id; 32],
        agent: agent_bytes(chain),
        token: parse_hex(&chain.token).unwrap(),
        recipient: parse_hex(recipient).unwrap(),
        amount,
        evidence_commitment: [0x77; 32],
        policy_version: 3,
        valid_until,
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires anvil and forge from a Foundry install"]
async fn ordinary_payment_settles_and_a1_a2_revert() {
    let chain = Chain::start().await;

    // A 0.25 USDC ordinary payment settles through the CLI.
    let proposed = chain.propose(VENDOR_A, ONE_USDC / 4, b"invoice one").await;
    assert_eq!(proposed["path"], "ordinary");
    let id = id_of(&proposed);
    let settled = chain.submit(&id, None, 30);
    assert_eq!(settled["state"], "settled", "{settled}");
    assert_eq!(chain.balance(VENDOR_A).await, ONE_USDC / 4);
    let status = chain.cli(json!({"method": "status", "payment_id": id}), 10);
    assert_eq!(status["state"], "settled");

    // A1: the agent calls pay() directly for 6 USDC, skipping the tools.
    let valid_until = chain.now().await + 3_600;
    let oversized = attack_payment(&chain, 0xa1, VENDOR_A, 6 * ONE_USDC, valid_until);
    assert_eq!(
        chain.attack(encode_pay(&oversized)).await,
        RevertMeaning::Approval("PerPaymentLimitExceeded")
    );

    // A2: the agent signs the exception with its own key.
    let authorization = ExceptionAuthorization {
        payment_hash: payment_hash(&oversized),
        approval_nonce: 1,
        authorization_expiry: valid_until,
    };
    let digest = approval_digest(CHAIN_ID, &chain.vault_bytes(), &authorization);
    let forged: [u8; 65] =
        parse_hex(&chain.sign_digest(&chain.agent_key, &format!("0x{}", hex::encode(digest))))
            .unwrap();
    assert_eq!(
        chain
            .attack(encode_pay_with_exception(
                &oversized,
                &authorization,
                &forged
            ))
            .await,
        RevertMeaning::Approval("BadSignature")
    );
    assert_eq!(chain.balance(VENDOR_A).await, ONE_USDC / 4);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires anvil and forge from a Foundry install"]
async fn owner_exception_settles_and_a3_a4_revert() {
    let chain = Chain::start().await;

    let proposed = chain.propose(VENDOR_A, 6 * ONE_USDC, b"invoice two").await;
    assert_eq!(proposed["path"], "exception_required");
    let id = id_of(&proposed);

    // The tools refuse before any transaction exists.
    let refused = chain.submit(&id, None, 10);
    assert_eq!(refused["code"], "OWNER_APPROVAL_REQUIRED", "{refused}");

    let (pending, signature_file) = chain.approve(&id).await;
    assert_eq!(pending.schema, "vault-pending-approval/1");
    assert_eq!(pending.exceeded_rule, "perPaymentLimit");

    // A3: the agent takes the owner's signature and pays vendor B instead.
    let signature_text = serde_json::from_slice::<Value>(&std::fs::read(&signature_file).unwrap())
        .unwrap()["signature"]
        .as_str()
        .unwrap()
        .to_owned();
    let signature: [u8; 65] = parse_hex(&signature_text).unwrap();
    let mut redirected = pending.payment.clone();
    redirected.recipient = parse_hex(VENDOR_B).unwrap();
    assert_eq!(
        chain
            .attack(encode_pay_with_exception(
                &redirected,
                &pending.authorization,
                &signature
            ))
            .await,
        RevertMeaning::Approval("PaymentHashMismatch")
    );
    // Rewriting the authorization to match leaves a digest the owner never signed.
    let mut rewritten = pending.authorization.clone();
    rewritten.payment_hash = payment_hash(&redirected);
    assert_eq!(
        chain
            .attack(encode_pay_with_exception(
                &redirected,
                &rewritten,
                &signature
            ))
            .await,
        RevertMeaning::Approval("BadSignature")
    );
    assert_eq!(chain.balance(VENDOR_B).await, 0);

    // The owner-approved payment settles, with a wallet-format signature.
    assert!(signature[64] >= 27);
    let settled = chain.submit(&id, Some(&signature_file), 30);
    assert_eq!(settled["state"], "settled", "{settled}");
    assert_eq!(chain.balance(VENDOR_A).await, 6 * ONE_USDC);

    // A4: the agent resubmits the settled exception.
    assert_eq!(
        chain
            .attack(encode_pay_with_exception(
                &pending.payment,
                &pending.authorization,
                &signature
            ))
            .await,
        RevertMeaning::AlreadySettled
    );
    assert_eq!(chain.balance(VENDOR_A).await, 6 * ONE_USDC);

    // The tools report the same payment as settled rather than paying again.
    let again = chain.submit(&id, Some(&signature_file), 10);
    assert_eq!(again["state"], "settled");
    assert_eq!(chain.balance(VENDOR_A).await, 6 * ONE_USDC);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires anvil and forge from a Foundry install"]
async fn timeout_reconciles_by_payment_id_without_paying_twice() {
    let chain = Chain::start().await;
    let id = id_of(
        &chain
            .propose(VENDOR_A, ONE_USDC / 2, b"invoice three")
            .await,
    );

    chain.raw_rpc("evm_setAutomine", json!([false])).await;
    let waiting = chain.submit(&id, None, 1);
    assert_eq!(waiting["state"], "unknown", "{waiting}");
    let first_hash = waiting["tx_hash"].clone();
    let status = chain.cli(json!({"method": "status", "payment_id": id}), 10);
    assert_eq!(status["state"], "not_settled");

    // A retry under the same ID resends the same bytes: the hash does not change.
    let retried = chain.submit(&id, None, 1);
    assert_eq!(retried["state"], "unknown", "{retried}");
    assert_eq!(retried["tx_hash"], first_hash);

    chain.raw_rpc("evm_mine", json!([])).await;
    chain.raw_rpc("evm_setAutomine", json!([true])).await;
    let settled = chain.submit(&id, None, 10);
    assert_eq!(settled["state"], "settled", "{settled}");
    assert_eq!(settled["tx_hash"], first_hash);
    assert_eq!(chain.balance(VENDOR_A).await, ONE_USDC / 2);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires anvil and forge from a Foundry install"]
async fn reviewer_verifies_records_and_detects_tampering() {
    let chain = Chain::start().await;

    let ordinary = id_of(&chain.propose(VENDOR_A, ONE_USDC / 4, b"invoice four").await);
    assert_eq!(chain.submit(&ordinary, None, 30)["state"], "settled");
    let record = chain.export(&ordinary, "ordinary.record");
    let pins = chain.pins(&record);
    let report = verify_record(&record, &chain.rpc, &pins).await;
    assert_eq!(report.record_integrity, Check::Verified, "{report:?}");
    assert_eq!(report.authorization, Check::NotApplicable, "{report:?}");
    assert_eq!(report.settlement, Check::Verified, "{report:?}");
    assert_eq!(report.policy_at_execution, Check::Verified, "{report:?}");

    let exception = id_of(&chain.propose(VENDOR_A, 6 * ONE_USDC, b"invoice five").await);
    let (_, signature_file) = chain.approve(&exception).await;
    assert_eq!(
        chain.submit(&exception, Some(&signature_file), 30)["state"],
        "settled"
    );
    let record = chain.export(&exception, "exception.record");
    let report = verify_record(&record, &chain.rpc, &pins).await;
    assert_eq!(report.record_integrity, Check::Verified, "{report:?}");
    assert_eq!(report.authorization, Check::Verified, "{report:?}");
    assert_eq!(report.settlement, Check::Verified, "{report:?}");
    assert_eq!(report.policy_at_execution, Check::Verified, "{report:?}");
    assert!(report.reasons.is_empty());

    // Tampered copies fail on the result each one should.
    let mut invoice = record.clone();
    invoice.evidence.invoice_hex = "0x00".to_owned();
    let report = verify_record(&invoice, &chain.rpc, &pins).await;
    assert_eq!(report.record_integrity, Check::Failed);

    let mut amount = record.clone();
    amount.payment.amount = 5 * ONE_USDC;
    let report = verify_record(&amount, &chain.rpc, &pins).await;
    assert_eq!(report.authorization, Check::Failed);
    assert_eq!(report.settlement, Check::Failed);

    let mut limit = record.clone();
    limit.policy.per_payment_limit = 100 * ONE_USDC;
    let report = verify_record(&limit, &chain.rpc, &pins).await;
    assert_eq!(report.policy_at_execution, Check::Failed);

    let mut signature = record.clone();
    signature.exception.as_mut().unwrap().owner_signature[0] ^= 1;
    let report = verify_record(&signature, &chain.rpc, &pins).await;
    assert_eq!(report.authorization, Check::Failed);

    // A vault whose code differs from the reviewer's pin is refused.
    let wrong_pin = ReviewerPins {
        vault_code_hash: [0x11; 32],
    };
    let report = verify_record(&record, &chain.rpc, &wrong_pin).await;
    assert_eq!(report.policy_at_execution, Check::Failed);

    // An unreachable RPC reads as unavailable, never as unpaid.
    let dead = VaultRpc::new(
        &["http://127.0.0.1:1".to_owned()],
        Duration::from_secs(1),
        CHAIN_ID,
    )
    .unwrap();
    let report = verify_record(&record, &dead, &pins).await;
    assert_eq!(report.record_integrity, Check::Verified);
    assert_eq!(report.authorization, Check::Unavailable);
    assert_eq!(report.settlement, Check::Unavailable);
    assert_eq!(report.policy_at_execution, Check::Unavailable);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires anvil and forge from a Foundry install"]
async fn attack_script_reports_every_attack_as_reverted() {
    let chain = Chain::start().await;
    let id = id_of(&chain.propose(VENDOR_A, 6 * ONE_USDC, b"invoice six").await);
    let (_, signature_file) = chain.approve(&id).await;
    let pending_file = chain.dir.join(format!("pending-{}.json", &id[2..14]));
    let script = contracts_dir().join("script/attacks.sh");
    let attacks = |settled: &str| {
        let output = Command::new("bash")
            .arg(&script)
            .env("RPC_URL", &chain.rpc_url)
            .env("VAULT", &chain.vault)
            .env("AGENT_KEY_FILE", chain.dir.join("agent.key"))
            .env("VENDOR_B", VENDOR_B)
            .env("OWNER_SIGNATURE_FILE", &signature_file)
            .env("PENDING_FILE", &pending_file)
            .env("SETTLED", settled)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        stdout
    };

    let before = attacks("0");
    assert!(before.contains("PASS A1"), "{before}");
    assert!(before.contains("PASS A2"), "{before}");
    assert!(before.contains("PASS A3"), "{before}");
    assert!(before.contains("A4 skipped"), "{before}");

    let settled = chain.submit(&id, Some(&signature_file), 30);
    assert_eq!(settled["state"], "settled", "{settled}");
    let after = attacks("1");
    assert!(after.contains("PASS A4"), "{after}");
    assert_eq!(chain.balance(VENDOR_A).await, 6 * ONE_USDC);
    assert_eq!(chain.balance(VENDOR_B).await, 0);
}
