//! End-to-end on a NEAR sandbox: a vault funded with the test token, an agent that is a
//! function-call key on the vault account, payments within limits, an exception with a NEP-413
//! signature, the rollback when the token refuses, and attacks A1 to A6, each refused for the
//! reason it is meant to show.

use ed25519_dalek::{Signer, SigningKey};
use near_sdk::borsh::BorshSerialize;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

const USDC: u128 = 1_000_000; // six decimals
const NEP413_TAG: u32 = 2_147_484_061;

#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Nep413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

struct World {
    worker: Worker<near_workspaces::network::Sandbox>,
    owner: Account,
    vault: Contract,
    token: Contract,
    vendor_a: Account,
    vendor_b: Account,
    agent_key: SecretKey,
    approver: SigningKey,
}

impl World {
    fn agent_pk(&self) -> String {
        self.agent_key.public_key().to_string()
    }

    fn approver_pk(&self) -> String {
        format!("ed25519:{}", bs58::encode(self.approver.verifying_key().to_bytes()).into_string())
    }

    /// An account object that signs as the vault with the agent's function-call key.
    fn agent(&self) -> Account {
        Account::from_secret_key(self.vault.id().clone(), self.agent_key.clone(), &self.worker)
    }

    fn payment(&self, id: &str, recipient: &AccountId, amount: u128) -> Value {
        json!({
            "payment_id": id,
            "agent": self.agent_pk(),
            "token": self.token.id(),
            "recipient": recipient,
            "amount": amount.to_string(),
            "evidence_commitment": base64(&[7u8; 32]),
            "policy_version": 1,
            "recipient_version": 1,
            "valid_until": (now() + 3600).to_string(),
        })
    }

    async fn payment_hash(&self, payment: &Value) -> String {
        self.vault
            .view("payment_hash")
            .args_json(json!({ "payment": payment }))
            .await
            .unwrap()
            .json::<String>()
            .unwrap()
    }

    /// Builds and signs an authorization for `payment` the way the approval page will.
    async fn authorize(&self, payment: &Value, nonce: u8) -> (Value, String) {
        let authorization = json!({
            "payment_hash": self.payment_hash(payment).await,
            "signer": self.approver_pk(),
            "signer_version": 1,
            "approval_nonce": base64(&[nonce; 32]),
            "authorization_expiry": (now() + 600).to_string(),
            "callback_url": null,
        });
        let message: String = self
            .vault
            .view("exception_message")
            .args_json(json!({ "authorization": authorization }))
            .await
            .unwrap()
            .json()
            .unwrap();
        let payload = Nep413Payload {
            message,
            nonce: [nonce; 32],
            recipient: self.vault.id().to_string(),
            callback_url: None,
        };
        let mut bytes = Vec::new();
        NEP413_TAG.serialize(&mut bytes).unwrap();
        payload.serialize(&mut bytes).unwrap();
        let digest = Sha256::digest(&bytes);
        let signature = self.approver.sign(&digest);
        (authorization, base64(&signature.to_bytes()))
    }

    async fn pay(&self, payment: &Value) -> Result<near_workspaces::result::ExecutionFinalResult, near_workspaces::error::Error> {
        self.agent()
            .call(self.vault.id(), "pay")
            .args_json(json!({ "payment": payment }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
    }

    async fn pay_with_exception(
        &self,
        payment: &Value,
        authorization: &Value,
        signature: &str,
    ) -> Result<near_workspaces::result::ExecutionFinalResult, near_workspaces::error::Error> {
        self.agent()
            .call(self.vault.id(), "pay_with_exception")
            .args_json(json!({ "payment": payment, "authorization": authorization, "signature": signature }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await
    }

    async fn balance(&self, account: &AccountId) -> u128 {
        self.token
            .view("ft_balance_of")
            .args_json(json!({ "account_id": account }))
            .await
            .unwrap()
            .json::<String>()
            .unwrap()
            .parse()
            .unwrap()
    }

    async fn spent_today(&self) -> u128 {
        let day: u64 = self.vault.view("current_day").await.unwrap().json().unwrap();
        self.vault
            .view("spent_by_agent")
            .args_json(json!({ "agent": self.agent_pk(), "day": day }))
            .await
            .unwrap()
            .json::<String>()
            .unwrap()
            .parse()
            .unwrap()
    }
}

/// Builds a crate through `contracts/near/build.sh`, which passes the `near` cfg near-sdk needs
/// to report panics by name, and returns its wasm.
fn build_wasm(dir: &str, name: &str) -> Vec<u8> {
    let status = std::process::Command::new("../build.sh")
        .arg(dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("run build.sh");
    assert!(status.success(), "build.sh failed for {dir}");
    std::fs::read(format!("{dir}/target/near/{name}.wasm")).expect("wasm")
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The failure text of a transaction, whether the protocol rejected it before execution or the
/// contract panicked during it.
fn failure(result: Result<near_workspaces::result::ExecutionFinalResult, near_workspaces::error::Error>) -> String {
    match result {
        Err(e) => format!("{e:?}"),
        Ok(outcome) => match outcome.into_result() {
            Ok(_) => "SUCCEEDED".to_string(),
            Err(e) => format!("{e:?}"),
        },
    }
}

async fn register(token: &Contract, caller: &Account, account: &AccountId) {
    caller
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": account, "registration_only": true }))
        .deposit(NearToken::from_millinear(2))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
}

async fn setup() -> World {
    let worker = near_workspaces::sandbox().await.unwrap();
    let vault_wasm = build_wasm("./", "styx_vault");
    let token_wasm = build_wasm("../styx-usdc", "styx_usdc");
    let root = worker.root_account().unwrap();

    let owner = root.create_subaccount("owner").initial_balance(NearToken::from_near(20)).transact().await.unwrap().unwrap();
    let vendor_a = root.create_subaccount("vendor-a").initial_balance(NearToken::from_near(5)).transact().await.unwrap().unwrap();
    let vendor_b = root.create_subaccount("vendor-b").initial_balance(NearToken::from_near(5)).transact().await.unwrap().unwrap();

    let token_account = root.create_subaccount("usdc").initial_balance(NearToken::from_near(20)).transact().await.unwrap().unwrap();
    let token = token_account.deploy(&token_wasm).await.unwrap().unwrap();
    token.call("new").transact().await.unwrap().into_result().unwrap();

    let vault_account = owner.create_subaccount("vault").initial_balance(NearToken::from_near(10)).transact().await.unwrap().unwrap();
    let vault = vault_account.deploy(&vault_wasm).await.unwrap().unwrap();
    vault
        .call("new")
        .args_json(json!({ "owner": owner.id(), "token": token.id() }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();

    register(&token, &owner, vault.id()).await;
    register(&token, &owner, vendor_a.id()).await;
    register(&token, &owner, vendor_b.id()).await;
    // vendor_b is allowed by the vault but not registered with the token in the rollback test; see below.
    token
        .call("mint")
        .args_json(json!({ "account_id": vault.id(), "amount": (1000 * USDC).to_string() }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();

    let agent_key = SecretKey::from_random(KeyType::ED25519);
    let approver = SigningKey::from_bytes(&[42u8; 32]);
    let world = World { worker, owner, vault, token, vendor_a, vendor_b, agent_key, approver };

    // Owner policy: agent pays up to 100 per payment and 250 per day; vault 500 per day.
    world
        .owner
        .call(world.vault.id(), "configure_agent")
        .args_json(json!({
            "agent": world.agent_pk(),
            "per_payment_limit": (100 * USDC).to_string(),
            "daily_limit": (250 * USDC).to_string(),
            "valid_until": (now() + 86_400).to_string(),
            "enabled": true,
        }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    for vendor in [world.vendor_a.id(), world.vendor_b.id()] {
        world
            .owner
            .call(world.vault.id(), "set_recipient")
            .args_json(json!({ "recipient": vendor, "allowed": true }))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }
    world
        .owner
        .call(world.vault.id(), "set_vault_daily_limit")
        .args_json(json!({ "limit": (500 * USDC).to_string() }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    world
        .owner
        .call(world.vault.id(), "set_approver")
        .args_json(json!({ "approver": world.approver_pk(), "enabled": true }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    world
}

#[tokio::test]
async fn end_to_end() {
    let w = setup().await;

    // The agent key exists on the vault account, restricted to the pay methods.
    let keys = w.worker.view_access_keys(w.vault.id()).await.unwrap();
    let agent_key = keys.iter().find(|k| k.public_key.to_string() == w.agent_pk()).expect("agent key installed");
    let permission = format!("{:?}", agent_key.access_key.permission);
    assert!(permission.contains("pay"), "{permission}");
    assert!(!permission.contains("FullAccess"), "{permission}");

    // Within limits: settles, moves tokens, commits counters, emits the event.
    let p1 = w.payment("p1", w.vendor_a.id(), 60 * USDC);
    let outcome = w.pay(&p1).await.unwrap();
    assert!(outcome.is_success(), "{:#?}", outcome.failures());
    assert!(outcome.clone().json::<bool>().unwrap(), "callback reported failure");
    assert!(outcome.logs().iter().any(|l| l.contains("payment_executed")), "{:?}", outcome.logs());
    assert_eq!(w.balance(w.vendor_a.id()).await, 60 * USDC);
    assert_eq!(w.spent_today().await, 60 * USDC);

    // A1: over the per-payment limit without a signature.
    let a1 = w.payment("a1", w.vendor_a.id(), 150 * USDC);
    let err = failure(w.pay(&a1).await);
    assert!(err.contains("PerPaymentLimitExceeded"), "{err}");

    // Exception: the approver signs the exact payment, it settles.
    let p2 = w.payment("p2", w.vendor_a.id(), 150 * USDC);
    let (auth, sig) = w.authorize(&p2, 1).await;
    let outcome = w.pay_with_exception(&p2, &auth, &sig).await.unwrap();
    assert!(outcome.is_success(), "{:#?}", outcome.failures());
    assert!(outcome.clone().json::<bool>().unwrap());
    assert_eq!(w.balance(w.vendor_a.id()).await, 210 * USDC);
    assert_eq!(w.spent_today().await, 210 * USDC);

    // A4: replay the settled payment.
    let err = failure(w.pay_with_exception(&p2, &auth, &sig).await);
    assert!(err.contains("PaymentAlreadyUsed"), "{err}");

    // A3: reuse the signature for another recipient. The amount stays under the daily limit so
    // the refusal is the hash check, not the counter.
    let p3 = w.payment("p3", w.vendor_b.id(), 30 * USDC);
    let err = failure(w.pay_with_exception(&p3, &auth, &sig).await);
    assert!(err.contains("PaymentHashMismatch"), "{err}");

    // A2: the agent signs its own exception. Its key is not an approver, and a function-call
    // key cannot produce a NEP-413 signature a wallet would accept anyway.
    let (mut self_auth, _) = w.authorize(&p3, 2).await;
    self_auth["signer"] = json!(w.agent_pk());
    let err = failure(w.pay_with_exception(&p3, &self_auth, &sig).await);
    assert!(err.contains("ApproverNotAllowed"), "{err}");

    // A5: the agent raises its own limit. The protocol refuses the method before the contract runs.
    let err = failure(
        w.agent()
            .call(w.vault.id(), "configure_agent")
            .args_json(json!({
                "agent": w.agent_pk(),
                "per_payment_limit": (1_000_000 * USDC).to_string(),
                "daily_limit": (1_000_000 * USDC).to_string(),
                "valid_until": (now() + 86_400).to_string(),
                "enabled": true,
            }))
            .transact()
            .await,
    );
    assert!(err.contains("MethodNameMismatch"), "{err}");

    // A6: the agent makes itself an approver. Same refusal.
    let err = failure(
        w.agent()
            .call(w.vault.id(), "set_approver")
            .args_json(json!({ "approver": w.agent_pk(), "enabled": true }))
            .transact()
            .await,
    );
    assert!(err.contains("MethodNameMismatch"), "{err}");

    // The daily limit holds even with a signature: 210 spent, 250 allowed, 41 asked.
    let p4 = w.payment("p4", w.vendor_a.id(), 41 * USDC);
    let (auth4, sig4) = w.authorize(&p4, 3).await;
    let err = failure(w.pay_with_exception(&p4, &auth4, &sig4).await);
    assert!(err.contains("DailyLimitExceeded"), "{err}");

    // The owner can still do everything the agent cannot.
    w.owner
        .call(w.vault.id(), "pause")
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let err = failure(w.pay(&w.payment("p5", w.vendor_a.id(), 10 * USDC)).await);
    assert!(err.contains("VaultPaused"), "{err}");
    w.owner.call(w.vault.id(), "unpause").transact().await.unwrap().into_result().unwrap();

    // Disabling the agent removes its key from the account.
    w.owner
        .call(w.vault.id(), "configure_agent")
        .args_json(json!({
            "agent": w.agent_pk(),
            "per_payment_limit": "0",
            "daily_limit": "0",
            "valid_until": "0",
            "enabled": false,
        }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let keys = w.worker.view_access_keys(w.vault.id()).await.unwrap();
    assert!(keys.iter().all(|k| k.public_key.to_string() != w.agent_pk()), "agent key still present");
}

#[tokio::test]
async fn transfer_failure_rolls_back() {
    let w = setup().await;
    // A recipient the vault allows but the token does not know: ft_transfer fails, the
    // callback must undo the counters and free the payment id.
    let stranger: AccountId = "stranger.test.near".parse().unwrap();
    w.owner
        .call(w.vault.id(), "set_recipient")
        .args_json(json!({ "recipient": stranger, "allowed": true }))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let p = w.payment("rb1", &stranger, 30 * USDC);
    let outcome = w.pay(&p).await.unwrap();
    assert!(outcome.is_success(), "callback itself must not fail: {:#?}", outcome.failures());
    assert!(!outcome.clone().json::<bool>().unwrap(), "callback should report the rollback");
    assert!(outcome.logs().iter().any(|l| l.contains("payment_failed")), "{:?}", outcome.logs());
    assert_eq!(w.spent_today().await, 0);
    assert_eq!(w.balance(w.vault.id()).await, 1000 * USDC);
    let consumed: Option<String> = w
        .vault
        .view("consumed_payment")
        .args_json(json!({ "payment_id": "rb1" }))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert!(consumed.is_none(), "payment id should be free again");
    // And the same id can now be paid to a registered recipient.
    let p = w.payment("rb1", w.vendor_a.id(), 30 * USDC);
    let outcome = w.pay(&p).await.unwrap();
    assert!(outcome.is_success() && outcome.clone().json::<bool>().unwrap());
    assert_eq!(w.spent_today().await, 30 * USDC);
}
