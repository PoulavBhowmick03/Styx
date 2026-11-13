//! Focused review reproductions. vm_* manually schedule callbacks in near-sdk's mock VM;
//! sandbox_* execute Wasm. All signing keys are fresh and remain in memory.
use ed25519_dalek::{Signer, SigningKey};
use k256::ecdsa::{RecoveryId, Signature, SigningKey as EcdsaKey, VerifyingKey};
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, AccountId, Gas, NearToken, PromiseError, PublicKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use styx_vault::{
    Contract, EvmChain, EvmPayment, ExceptionAuthorization, MpcPoint, MpcScalar, MpcSignature,
    Payment,
};
const DAY: u64 = 86_400;
const ARC: u64 = 5_042_002;
const BASE: u64 = 84_532;
const TOKEN_A: &str = "0x3600000000000000000000000000000000000000";
const TOKEN_B: &str = "0x2222222222222222222222222222222222222222";
const VENDOR: &str = "0x1111111111111111111111111111111111111111";
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn vault() -> AccountId {
    id("vault.owner.test")
}
fn random_key() -> (SigningKey, PublicKey) {
    let secret =
        near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    let encoded = secret.to_string();
    let raw = bs58::decode(encoded.strip_prefix("ed25519:").unwrap())
        .into_vec()
        .unwrap();
    let key = SigningKey::from_bytes(raw[..32].try_into().unwrap());
    let public = format!(
        "ed25519:{}",
        bs58::encode(key.verifying_key().as_bytes()).into_string()
    )
    .parse()
    .unwrap();
    (key, public)
}
fn context(predecessor: AccountId, key: PublicKey, seconds: u64) {
    let mut c = VMContextBuilder::new();
    c.current_account_id(vault())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .signer_account_pk(key)
        .block_timestamp(seconds * 1_000_000_000)
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(c.build());
}
fn chain(token: &str) -> EvmChain {
    EvmChain {
        token: token.into(),
        max_fee_per_gas: U128(50_000_000_000),
        max_priority_fee_per_gas: U128(1_000_000_000),
        gas_limit: U64(100_000),
        enabled: true,
    }
}
fn fields() -> (U128, U128, U64) {
    (U128(50_000_000_000), U128(1_000_000_000), U64(100_000))
}
struct World {
    c: Contract,
    agent: PublicKey,
    other: PublicKey,
    approver: (SigningKey, PublicKey),
}
fn setup() -> World {
    let agent = random_key().1;
    let other = random_key().1;
    let approver = random_key();
    context(id("owner.test"), approver.1.clone(), DAY);
    let mut c = Contract::new(id("owner.test"), id("token.test"), None);
    for key in [&agent, &other] {
        drop(c.configure_agent(key.clone(), U128(100), U128(250), U64(10 * DAY), true));
    }
    c.set_vault_daily_limit(U128(500));
    c.set_recipient(id("vendor.test"), true);
    c.set_approver(approver.1.clone(), true);
    for cid in [ARC, BASE] {
        c.set_evm_chain(cid, chain(TOKEN_A));
        c.set_evm_recipient(cid, VENDOR.into(), true);
    }
    World {
        c,
        agent,
        other,
        approver,
    }
}
fn payment(w: &World, name: &str, amount: u128) -> Payment {
    Payment {
        payment_id: name.into(),
        agent: w.agent.clone(),
        token: id("token.test"),
        recipient: id("vendor.test"),
        amount: U128(amount),
        evidence_commitment: Base64VecU8(vec![0; 32]),
        policy_version: 1,
        recipient_version: 1,
        valid_until: U64(10 * DAY),
    }
}
fn evm_payment(w: &World, name: &str, amount: u128) -> EvmPayment {
    EvmPayment {
        payment_id: name.into(),
        agent: w.agent.clone(),
        chain_id: ARC,
        recipient: VENDOR.into(),
        amount: U128(amount),
        evidence_commitment: Base64VecU8(vec![0; 32]),
        policy_version: 1,
        recipient_version: 1,
        valid_until: U64(10 * DAY),
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn requested_digest() -> [u8; 32] {
    for receipt in get_created_receipts() {
        for action in receipt.actions {
            if let MockAction::FunctionCallWeight {
                method_name, args, ..
            } = action
            {
                if method_name == b"sign" {
                    let v: Value = serde_json::from_slice(&args).unwrap();
                    assert_eq!(v["request"]["domain_id"], 0);
                    assert_eq!(v["request"]["path"], "styx-evm");
                    return unhex(v["request"]["payload_v2"]["Ecdsa"].as_str().unwrap())
                        .try_into()
                        .unwrap();
                }
            }
        }
    }
    panic!("missing MPC sign receipt")
}
fn sign_digest(digest: &[u8; 32]) -> (MpcSignature, VerifyingKey) {
    let key = EcdsaKey::random(&mut k256::elliptic_curve::rand_core::OsRng);
    let (sig, rid) = key.sign_prehash_recoverable(digest).unwrap();
    let mut point = vec![if rid.is_y_odd() { 3 } else { 2 }];
    point.extend_from_slice(&sig.r().to_bytes());
    (
        MpcSignature {
            big_r: MpcPoint {
                affine_point: hex(&point),
            },
            s: MpcScalar {
                scalar: hex(&sig.s().to_bytes()),
            },
            recovery_id: rid.to_byte(),
        },
        *key.verifying_key(),
    )
}
// Independent RLP reader for the emitted transaction, not the contract's encoder.
fn item(raw: &[u8]) -> (&[u8], &[u8]) {
    let b = raw[0];
    let (head, len) = if b < 0x80 {
        (0, 1)
    } else if b <= 0xb7 {
        (1, (b - 0x80) as usize)
    } else if b <= 0xbf {
        let n = (b - 0xb7) as usize;
        (
            1 + n,
            raw[1..1 + n]
                .iter()
                .fold(0usize, |a, b| a * 256 + *b as usize),
        )
    } else if b <= 0xf7 {
        (1, (b - 0xc0) as usize)
    } else {
        let n = (b - 0xf7) as usize;
        (
            1 + n,
            raw[1..1 + n]
                .iter()
                .fold(0usize, |a, b| a * 256 + *b as usize),
        )
    };
    (&raw[..head + len], &raw[head..head + len])
}
fn list(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if body.len() < 56 {
        out.push(0xc0 + body.len() as u8);
    } else {
        let n = body.len().to_be_bytes();
        let n = &n[n.iter().position(|b| *b != 0).unwrap()..];
        out.push(0xf7 + n.len() as u8);
        out.extend(n);
    }
    out.extend(body);
    out
}
fn emitted(raw: &str) -> (Vec<Vec<u8>>, [u8; 32], VerifyingKey) {
    let raw = unhex(raw.strip_prefix("0x").unwrap());
    assert_eq!(raw[0], 2);
    let (_, mut body) = item(&raw[1..]);
    let mut encoded = Vec::new();
    let mut fields = Vec::new();
    while !body.is_empty() {
        let (bytes, payload) = item(body);
        encoded.push(bytes.to_vec());
        fields.push(payload.to_vec());
        body = &body[bytes.len()..];
    }
    assert_eq!(fields.len(), 12);
    let mut unsigned = vec![2];
    unsigned.extend(list(&encoded[..9].concat()));
    let digest: [u8; 32] = Keccak256::digest(unsigned).into();
    let scalar = |v: &[u8]| {
        let mut out = [0; 32];
        out[32 - v.len()..].copy_from_slice(v);
        out
    };
    let sig = Signature::from_scalars(scalar(&fields[10]), scalar(&fields[11])).unwrap();
    let parity = fields[9].first().copied().unwrap_or(0);
    let recovered =
        VerifyingKey::recover_from_prehash(&digest, &sig, RecoveryId::from_byte(parity).unwrap())
            .unwrap();
    (fields, digest, recovered)
}
#[test]
fn vm_token_change_during_mpc_emits_transaction_for_wrong_signer() {
    let mut w = setup();
    let p = evm_payment(&w, "token-race", 60);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_evm(p.clone()));
    let digest = requested_digest();
    let (sig, key) = sign_digest(&digest);
    context(id("owner.test"), w.approver.1.clone(), DAY);
    w.c.set_evm_chain(ARC, chain(TOKEN_B));
    context(vault(), w.agent.clone(), DAY);
    let tx =
        w.c.on_evm_signed(p, 1, 0, fields(), None, None, Ok(sig))
            .unwrap();
    let (decoded, new_digest, recovered) = emitted(&tx.raw_tx);
    assert_eq!(hex(&decoded[5]), &TOKEN_B[2..]);
    assert_ne!(new_digest, digest);
    assert_ne!(recovered, key);
    assert_eq!(w.c.evm_nonce(ARC), 1);
    assert_eq!(w.c.spent_by_agent(w.agent, 1).0, 60);
    assert!(w.c.consumed_payment("token-race".into()).is_some());
}
#[test]
fn vm_old_callback_clears_new_lock_and_overwrites_signed_tx() {
    let mut w = setup();
    let p = evm_payment(&w, "old", 60);
    let p2 = evm_payment(&w, "new", 40);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_evm(p.clone()));
    let (sig1, _) = sign_digest(&requested_digest());
    context(id("owner.test"), w.approver.1.clone(), DAY);
    w.c.set_evm_nonce(ARC, 0);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_evm(p2.clone()));
    let (sig2, _) = sign_digest(&requested_digest());
    assert_eq!(w.c.evm_pending(), Some(ARC));
    let old =
        w.c.on_evm_signed(p, 1, 0, fields(), None, None, Ok(sig1))
            .unwrap();
    assert_eq!(
        w.c.evm_pending(),
        None,
        "new request is still in flight but lock is cleared"
    );
    let new =
        w.c.on_evm_signed(p2, 1, 0, fields(), None, None, Ok(sig2))
            .unwrap();
    assert_ne!(old.raw_tx, new.raw_tx);
    assert_eq!(w.c.signed_evm_tx(ARC, 0).unwrap().payment_id, "new");
    assert_eq!(w.c.spent_by_agent(w.agent, 1).0, 100);
}
#[test]
fn vm_old_callback_reverts_owner_nonce_resync() {
    let mut w = setup();
    let p = evm_payment(&w, "nonce-reset", 10);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_evm(p.clone()));
    let (sig, _) = sign_digest(&requested_digest());
    context(id("owner.test"), w.approver.1.clone(), DAY);
    w.c.set_evm_nonce(ARC, 100);
    context(vault(), w.agent.clone(), DAY);
    w.c.on_evm_signed(p, 1, 0, fields(), None, None, Ok(sig));
    assert_eq!(w.c.evm_nonce(ARC), 1);
}
#[test]
fn vm_other_agent_can_claim_record_and_claim_survives_rollback() {
    let mut w = setup();
    let p = payment(&w, "record-race", 60);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay(p.clone()));
    context(vault(), w.other.clone(), DAY);
    w.c.post_record("record-race".into(), Base64VecU8(vec![1]));
    assert!(get_logs()[0].contains(&format!("\"agent\":\"{}\"", w.other)));
    context(vault(), w.agent.clone(), DAY);
    assert!(!w
        .c
        .on_transfer(p.clone(), 1, None, None, Err(PromiseError::Failed)));
    drop(w.c.pay(p.clone()));
    assert!(w.c.on_transfer(p, 1, None, None, Ok(())));
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        w.c.post_record("record-race".into(), Base64VecU8(vec![2]))
    }));
    assert!(error.is_err());
}
fn independent_nep413(c: &Contract, a: &ExceptionAuthorization, recipient: &str) -> [u8; 32] {
    let message = c.exception_message(a.clone());
    let mut payload = 2147484061u32.to_le_bytes().to_vec();
    for (position, s) in [message.as_str(), recipient].iter().enumerate() {
        if position == 1 {
            payload.extend(&a.approval_nonce.0);
        }
        payload.extend((s.len() as u32).to_le_bytes());
        payload.extend(s.as_bytes());
    }
    match &a.callback_url {
        None => payload.push(0),
        Some(s) => {
            payload.push(1);
            payload.extend((s.len() as u32).to_le_bytes());
            payload.extend(s.as_bytes());
        }
    }
    Sha256::digest(payload).into()
}
#[test]
fn vm_callback_url_and_day_boundary_rollback_preserve_new_spend() {
    let mut w = setup();
    let p = payment(&w, "day1-exception", 150);
    let a = ExceptionAuthorization {
        payment_hash: w.c.payment_hash(p.clone()),
        signer: w.approver.1.clone(),
        signer_version: 1,
        approval_nonce: Base64VecU8(vec![8; 32]),
        authorization_expiry: U64(3 * DAY),
        callback_url: Some("https://example.invalid/callback?state=review".into()),
    };
    let sig = Base64VecU8(
        w.approver
            .0
            .sign(&independent_nep413(&w.c, &a, vault().as_str()))
            .to_bytes()
            .to_vec(),
    );
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_with_exception(p.clone(), a.clone(), sig.clone()));
    context(vault(), w.agent.clone(), 2 * DAY);
    let newer = payment(&w, "day2", 40);
    drop(w.c.pay(newer));
    assert!(!w.c.on_transfer(
        p.clone(),
        1,
        Some(a.clone()),
        None,
        Err(PromiseError::Failed)
    ));
    assert_eq!(w.c.spent_by_agent(w.agent.clone(), 1).0, 0);
    assert_eq!(w.c.spent_by_vault(1).0, 0);
    assert_eq!(w.c.spent_by_agent(w.agent.clone(), 2).0, 40);
    assert_eq!(w.c.spent_by_vault(2).0, 40);
    drop(w.c.pay_with_exception(p, a, sig));
    assert_eq!(w.c.spent_by_agent(w.agent, 2).0, 190);
}
#[test]
fn vm_hashes_commit_every_field_and_separate_domains() {
    let w = setup();
    let p = payment(&w, "same", 1);
    let e = evm_payment(&w, "same", 1);
    let hash = w.c.payment_hash(p.clone());
    let ehash = w.c.evm_payment_hash(e.clone());
    assert_ne!(hash, ehash);
    let changes: Vec<Box<dyn Fn(&mut Payment)>> = vec![
        Box::new(|x| x.payment_id.push('x')),
        Box::new(|x| x.agent = random_key().1),
        Box::new(|x| x.token = id("other.test")),
        Box::new(|x| x.recipient = id("other.test")),
        Box::new(|x| x.amount = U128(2)),
        Box::new(|x| x.evidence_commitment.0.push(1)),
        Box::new(|x| x.policy_version += 1),
        Box::new(|x| x.recipient_version += 1),
        Box::new(|x| x.valid_until = U64(x.valid_until.0 + 1)),
    ];
    for change in changes {
        let mut changed = p.clone();
        change(&mut changed);
        assert_ne!(w.c.payment_hash(changed), hash);
    }
    let changes: Vec<Box<dyn Fn(&mut EvmPayment)>> = vec![
        Box::new(|x| x.payment_id.push('x')),
        Box::new(|x| x.agent = random_key().1),
        Box::new(|x| x.chain_id = BASE),
        Box::new(|x| x.recipient = TOKEN_B.into()),
        Box::new(|x| x.amount = U128(2)),
        Box::new(|x| x.evidence_commitment.0.push(1)),
        Box::new(|x| x.policy_version += 1),
        Box::new(|x| x.recipient_version += 1),
        Box::new(|x| x.valid_until = U64(x.valid_until.0 + 1)),
    ];
    for change in changes {
        let mut changed = e.clone();
        change(&mut changed);
        assert_ne!(w.c.evm_payment_hash(changed), ehash);
    }
}
fn wasm() -> Vec<u8> {
    assert!(std::process::Command::new("../build.sh")
        .arg(".")
        .status()
        .unwrap()
        .success());
    std::fs::read("target/near/styx_vault.wasm").unwrap()
}
#[tokio::test]
async fn sandbox_failed_install_leaves_enabled_policy_and_full_access_key() {
    use near_workspaces::types::AccessKeyPermission;
    let worker = near_workspaces::sandbox().await.unwrap();
    let owner = worker.dev_create_account().await.unwrap();
    let vault = worker.dev_deploy(&wasm()).await.unwrap();
    vault
        .call("new")
        .args_json(json!({"owner":owner.id(),"token":"token.test"}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let key = vault.as_account().secret_key().public_key();
    let configure = json!({"agent":key,"per_payment_limit":"100","daily_limit":"250","valid_until":"9999999999","enabled":true});
    let result = owner
        .call(vault.id(), "configure_agent")
        .args_json(configure.clone())
        .transact()
        .await
        .unwrap();
    assert!(result.is_failure());
    let policy: Value = vault
        .view("get_agent")
        .args_json(json!({"agent":key}))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(policy["enabled"], true);
    assert!(matches!(
        vault.view_access_key(&key).await.unwrap().permission,
        AccessKeyPermission::FullAccess
    ));
    owner
        .call(vault.id(), "configure_agent")
        .args_json(configure)
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    assert!(matches!(
        vault.view_access_key(&key).await.unwrap().permission,
        AccessKeyPermission::FullAccess
    ));
    for method in ["on_transfer", "on_evm_signed"] {
        let failure = owner
            .call(vault.id(), method)
            .args_json(json!({}))
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap_err();
        assert!(format!("{failure:?}").contains("private"));
    }
}

#[tokio::test]
async fn sandbox_empty_success_from_signer_strands_lock_and_accounting() {
    use near_workspaces::types::{Gas as WGas, KeyType, SecretKey};
    // Minimal Wasm with exported sign() returning empty successful bytes. No secret material.
    let empty_signer = vec![
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 8, 1, 4, 115, 105, 103, 110,
        0, 0, 10, 4, 1, 2, 0, 11,
    ];
    let worker = near_workspaces::sandbox().await.unwrap();
    let signer = worker.dev_deploy(&empty_signer).await.unwrap();
    let owner = worker.dev_create_account().await.unwrap();
    let vault = worker.dev_deploy(&wasm()).await.unwrap();
    vault
        .call("new")
        .args_json(json!({"owner":owner.id(),"token":"token.test","mpc_signer":signer.id()}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let secret = SecretKey::from_random(KeyType::ED25519);
    let pk = secret.public_key();
    for (method, args) in [
        (
            "configure_agent",
            json!({"agent":pk,"per_payment_limit":"100","daily_limit":"250","valid_until":"9999999999","enabled":true}),
        ),
        ("set_vault_daily_limit", json!({"limit":"500"})),
        (
            "set_evm_chain",
            json!({"chain_id":ARC,"chain":{"token":TOKEN_A,"max_fee_per_gas":"50000000000","max_priority_fee_per_gas":"1000000000","gas_limit":"100000","enabled":true}}),
        ),
        (
            "set_evm_recipient",
            json!({"chain_id":ARC,"recipient":VENDOR,"allowed":true}),
        ),
    ] {
        owner
            .call(vault.id(), method)
            .args_json(args)
            .transact()
            .await
            .unwrap()
            .into_result()
            .unwrap();
    }
    let agent = near_workspaces::Account::from_secret_key(vault.id().clone(), secret, &worker);
    let payment = json!({"payment_id":"malformed-signer","agent":pk,"chain_id":ARC,"recipient":VENDOR,"amount":"60","evidence_commitment":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=","policy_version":1,"recipient_version":1,"valid_until":"9999999999"});
    let result = agent
        .call(vault.id(), "pay_evm")
        .args_json(json!({"payment":payment}))
        .gas(WGas::from_tgas(200))
        .transact()
        .await
        .unwrap();
    assert!(result.is_failure());
    assert!(format!("{:?}", result.failures()).contains("Failed to deserialize callback"));
    let pending: Option<u64> = vault.view("evm_pending").await.unwrap().json().unwrap();
    assert_eq!(pending, Some(ARC));
    let day: u64 = vault.view("current_day").await.unwrap().json().unwrap();
    let spent: String = vault
        .view("spent_by_agent")
        .args_json(json!({"agent":pk,"day":day}))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert_eq!(spent, "60");
    let consumed: Option<String> = vault
        .view("consumed_payment")
        .args_json(json!({"payment_id":"malformed-signer"}))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert!(consumed.is_some());
    owner
        .call(vault.id(), "set_evm_nonce")
        .args_json(json!({"chain_id":ARC,"nonce":0}))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let pending: Option<u64> = vault.view("evm_pending").await.unwrap().json().unwrap();
    assert_eq!(pending, None);
    let consumed: Option<String> = vault
        .view("consumed_payment")
        .args_json(json!({"payment_id":"malformed-signer"}))
        .await
        .unwrap()
        .json()
        .unwrap();
    assert!(
        consumed.is_some(),
        "nonce recovery does not refund consumed payment"
    );
}

#[test]
fn vm_callback_event_uses_changed_policy_instead_of_original_policy() {
    let mut w = setup();
    let p = payment(&w, "policy-event", 60);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay(p.clone()));
    context(id("owner.test"), w.approver.1.clone(), DAY);
    drop(w.c.configure_agent(w.agent.clone(), U128(1), U128(1), U64(10 * DAY), false));
    context(vault(), w.agent.clone(), DAY);
    assert!(w.c.on_transfer(p, 1, None, None, Ok(())));
    let event: Value =
        serde_json::from_str(get_logs()[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(event["data"][0]["policy_version"], 1);
    assert_eq!(event["data"][0]["per_payment_limit"], "1");
    assert_eq!(event["data"][0]["daily_limit"], "1");
    assert_eq!(event["data"][0]["amount"], "60");
}

#[test]
#[should_panic(expected = "BadSignature")]
fn vm_changing_callback_url_invalidates_signature() {
    let mut w = setup();
    let p = payment(&w, "url-check", 150);
    let mut a = ExceptionAuthorization {
        payment_hash: w.c.payment_hash(p.clone()),
        signer: w.approver.1.clone(),
        signer_version: 1,
        approval_nonce: Base64VecU8(vec![9; 32]),
        authorization_expiry: U64(3 * DAY),
        callback_url: Some("https://example.invalid/original".into()),
    };
    let sig = Base64VecU8(
        w.approver
            .0
            .sign(&independent_nep413(&w.c, &a, vault().as_str()))
            .to_bytes()
            .to_vec(),
    );
    a.callback_url = Some("https://example.invalid/changed".into());
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_with_exception(p, a, sig));
}

#[test]
#[should_panic(expected = "VaultDailyLimitExceeded")]
fn vm_evm_exception_cannot_lift_shared_vault_daily_cap() {
    let mut w = setup();
    w.c.set_vault_daily_limit(U128(100));
    let p = payment(&w, "near-first", 60);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay(p));
    let p = evm_payment(&w, "evm-second", 150);
    let a = ExceptionAuthorization {
        payment_hash: w.c.evm_payment_hash(p.clone()),
        signer: w.approver.1.clone(),
        signer_version: 1,
        approval_nonce: Base64VecU8(vec![10; 32]),
        authorization_expiry: U64(3 * DAY),
        callback_url: None,
    };
    let sig = Base64VecU8(
        w.approver
            .0
            .sign(&independent_nep413(&w.c, &a, vault().as_str()))
            .to_bytes()
            .to_vec(),
    );
    drop(w.c.pay_evm_with_exception(p, a, sig));
}

#[test]
fn vm_evm_approval_survives_token_change_before_submission() {
    let mut w = setup();
    let p = evm_payment(&w, "approval-asset", 150);
    let original_hash = w.c.evm_payment_hash(p.clone());
    let a = ExceptionAuthorization {
        payment_hash: original_hash.clone(),
        signer: w.approver.1.clone(),
        signer_version: 1,
        approval_nonce: Base64VecU8(vec![11; 32]),
        authorization_expiry: U64(3 * DAY),
        callback_url: None,
    };
    let approval = Base64VecU8(
        w.approver
            .0
            .sign(&independent_nep413(&w.c, &a, vault().as_str()))
            .to_bytes()
            .to_vec(),
    );
    w.c.set_evm_chain(ARC, chain(TOKEN_B));
    assert_eq!(w.c.evm_payment_hash(p.clone()), original_hash);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_evm_with_exception(p.clone(), a.clone(), approval));
    let digest = requested_digest();
    let (answer, key) = sign_digest(&digest);
    let tx =
        w.c.on_evm_signed(p, 1, 0, fields(), Some(a), None, Ok(answer))
            .unwrap();
    let (decoded, emitted_digest, recovered) = emitted(&tx.raw_tx);
    assert_eq!(hex(&decoded[5]), &TOKEN_B[2..]);
    assert_eq!(emitted_digest, digest);
    assert_eq!(recovered, key);
}

#[test]
fn vm_signed_evm_output_can_arrive_after_payment_expiry() {
    let mut w = setup();
    let p = evm_payment(&w, "late-signature", 60);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay_evm(p.clone()));
    let (answer, key) = sign_digest(&requested_digest());
    context(vault(), w.agent.clone(), 11 * DAY);
    let tx =
        w.c.on_evm_signed(p, 1, 0, fields(), None, None, Ok(answer))
            .unwrap();
    assert_eq!(emitted(&tx.raw_tx).2, key);
    assert_eq!(w.c.spent_by_agent(w.agent.clone(), 1).0, 60);
    assert_eq!(w.c.spent_by_agent(w.agent, 11).0, 0);
}

#[test]
#[should_panic(expected = "PaymentAlreadyUsed")]
fn vm_payment_id_cannot_be_reused_across_near_and_evm() {
    let mut w = setup();
    let p = payment(&w, "cross-domain-id", 1);
    context(vault(), w.agent.clone(), DAY);
    drop(w.c.pay(p));
    let e = evm_payment(&w, "cross-domain-id", 1);
    drop(w.c.pay_evm(e));
}
