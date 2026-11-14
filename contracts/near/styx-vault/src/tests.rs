//! Unit tests for every refusal path. The token transfer is a promise the mock VM records but
#![allow(unused_must_use)]
//! never runs, so settlement and rollback are covered by the sandbox tests in `tests/`.

use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, CurveType};

const DAY_NS: u64 = DAY_SECONDS * 1_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn owner() -> AccountId {
    acct("owner.test")
}
fn vault() -> AccountId {
    acct("vault.test")
}
fn token() -> AccountId {
    acct("usdc.test")
}
fn vendor() -> AccountId {
    acct("vendor.test")
}

fn key(seed: u8) -> (SigningKey, PublicKey) {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let pk = PublicKey::from_parts(CurveType::ED25519, sk.verifying_key().to_bytes().to_vec()).unwrap();
    (sk, pk)
}

fn agent() -> PublicKey {
    key(1).1
}

fn context(predecessor: AccountId, signer_pk: PublicKey, ts: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault())
        .predecessor_account_id(predecessor)
        .signer_account_pk(signer_pk)
        .block_timestamp(ts);
    b
}

fn as_owner(ts: u64) {
    testing_env!(context(owner(), key(9).1, ts).build());
}

fn as_agent(pk: PublicKey, ts: u64) {
    testing_env!(context(vault(), pk, ts).build());
}

/// A configured vault: agent 1 with 100 per payment and 250 per day, vault 500 per day,
/// vendor allowed, approver 2.
fn setup() -> Contract {
    as_owner(DAY_NS);
    let mut c = Contract::new(owner(), token(), None);
    c.configure_agent(agent(), U128(100), U128(250), U64(10 * DAY_SECONDS), true);
    c.set_recipient(vendor(), true);
    c.set_vault_daily_limit(U128(500));
    c.set_approver(key(2).1, true);
    c
}

fn payment(id: &str, amount: u128) -> Payment {
    Payment {
        payment_id: id.to_string(),
        agent: agent(),
        token: token(),
        recipient: vendor(),
        amount: U128(amount),
        evidence_commitment: Base64VecU8::from(vec![7u8; 32]),
        policy_version: 1,
        recipient_version: 1,
        valid_until: U64(10 * DAY_SECONDS),
    }
}

fn sign(c: &Contract, sk: &SigningKey, a: &ExceptionAuthorization) -> Base64VecU8 {
    let digest = c.nep413_digest(a);
    Base64VecU8::from(sk.sign(&digest).to_bytes().to_vec())
}

fn authorization(p: &Payment, signer: &PublicKey, nonce: u8) -> ExceptionAuthorization {
    ExceptionAuthorization {
        payment_hash: Base64VecU8::from(hash_payment(p).to_vec()),
        signer: signer.clone(),
        signer_version: 1,
        approval_nonce: Base64VecU8::from(vec![nonce; 32]),
        authorization_expiry: U64(2 * DAY_SECONDS),
        callback_url: None,
    }
}

#[test]
fn pays_within_limits_and_commits_counters() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 60));
    assert_eq!(c.spent_by_agent(agent(), 1).0, 60);
    assert_eq!(c.spent_by_vault(1).0, 60);
    assert!(c.consumed_payment("p1".into()).is_some());
}

#[test]
#[should_panic(expected = "PerPaymentLimitExceeded")]
fn a1_over_the_limit_without_a_signature() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 101));
}

#[test]
#[should_panic(expected = "NotAgent")]
fn a_stranger_cannot_pay() {
    let mut c = setup();
    testing_env!(context(acct("stranger.test"), key(5).1, DAY_NS).build());
    c.pay(payment("p1", 10));
}

#[test]
#[should_panic(expected = "NotAgent")]
fn an_unknown_key_on_the_vault_cannot_pay() {
    let mut c = setup();
    as_agent(key(5).1, DAY_NS);
    c.pay(payment("p1", 10));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn a5_agent_cannot_raise_its_own_limit() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.configure_agent(agent(), U128(1_000_000), U128(1_000_000), U64(10 * DAY_SECONDS), true);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn a6_agent_cannot_make_itself_an_approver() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.set_approver(agent(), true);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn agent_cannot_withdraw() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.withdraw(vendor(), U128(1));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn agent_cannot_allow_a_recipient() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.set_recipient(acct("me.test"), true);
}

#[test]
#[should_panic(expected = "RecipientNotAllowed")]
fn pays_only_allowed_recipients() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    let mut p = payment("p1", 10);
    p.recipient = acct("mallory.test");
    c.pay(p);
}

#[test]
#[should_panic(expected = "PaymentAlreadyUsed")]
fn a4_cannot_replay_a_payment() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 10));
    c.pay(payment("p1", 10));
}

#[test]
#[should_panic(expected = "DailyLimitExceeded")]
fn agent_daily_limit_holds() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 100));
    c.pay(payment("p2", 100));
    c.pay(payment("p3", 51));
}

#[test]
#[should_panic(expected = "VaultPaused")]
fn paused_vault_refuses() {
    let mut c = setup();
    c.pause();
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 10));
}

#[test]
#[should_panic(expected = "PolicyVersionMismatch")]
fn reconfiguring_the_agent_invalidates_old_payments() {
    let mut c = setup();
    c.configure_agent(agent(), U128(100), U128(250), U64(10 * DAY_SECONDS), true);
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 10));
}

#[test]
fn exception_with_a_valid_signature_settles() {
    let mut c = setup();
    let (sk, pk) = key(2);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(p, a, sig);
    assert_eq!(c.spent_by_agent(agent(), 1).0, 150);
}

#[test]
#[should_panic(expected = "DailyLimitExceeded")]
fn exception_does_not_lift_the_daily_limit() {
    let mut c = setup();
    let (sk, pk) = key(2);
    let p = payment("p1", 251);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(p, a, sig);
}

#[test]
#[should_panic(expected = "ApproverNotAllowed")]
fn a2_agent_cannot_sign_its_own_exception() {
    let mut c = setup();
    let (sk, pk) = key(1);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(p, a, sig);
}

#[test]
#[should_panic(expected = "PaymentHashMismatch")]
fn a3_signature_does_not_transfer_to_another_recipient() {
    let mut c = setup();
    c.set_recipient(acct("vendor-b.test"), true);
    let (sk, pk) = key(2);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    let mut other = p.clone();
    other.recipient = acct("vendor-b.test");
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(other, a, sig);
}

#[test]
#[should_panic(expected = "BadSignature")]
fn a3b_forged_hash_fails_the_signature() {
    let mut c = setup();
    c.set_recipient(acct("vendor-b.test"), true);
    let (sk, pk) = key(2);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    let mut other = p.clone();
    other.recipient = acct("vendor-b.test");
    let mut forged = a.clone();
    forged.payment_hash = Base64VecU8::from(hash_payment(&other).to_vec());
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(other, forged, sig);
}

#[test]
#[should_panic(expected = "ApprovalNonceUsed")]
fn a_signature_nonce_is_single_use() {
    let mut c = setup();
    let (sk, pk) = key(2);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(p.clone(), a.clone(), sig.clone());
    let p2 = payment("p2", 50);
    let mut a2 = a.clone();
    a2.payment_hash = Base64VecU8::from(hash_payment(&p2).to_vec());
    let sig2 = sign(&c, &sk, &a2);
    c.pay_with_exception(p2, a2, sig2);
}

#[test]
#[should_panic(expected = "AuthorizationExpired")]
fn an_expired_authorization_fails() {
    let mut c = setup();
    let (sk, pk) = key(2);
    let p = payment("p1", 150);
    let mut a = authorization(&p, &pk, 1);
    a.authorization_expiry = U64(DAY_SECONDS - 1);
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(p, a, sig);
}

#[test]
#[should_panic(expected = "SignerVersionMismatch")]
fn disabling_an_approver_invalidates_their_signatures() {
    let mut c = setup();
    let (sk, pk) = key(2);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let sig = sign(&c, &sk, &a);
    c.set_approver(pk.clone(), false);
    c.set_approver(pk, true);
    as_agent(agent(), DAY_NS);
    c.pay_with_exception(p, a, sig);
}

#[test]
#[should_panic(expected = "RoleConflict")]
fn an_agent_cannot_be_made_an_approver() {
    let mut c = setup();
    c.set_approver(agent(), true);
}

#[test]
fn rollback_restores_counters_and_frees_the_payment_id() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    let p = payment("p1", 60);
    c.pay(p.clone());
    testing_env!(context(vault(), agent(), DAY_NS).build());
    let settled = c.on_transfer(p.clone(), 1, None, None, Err(PromiseError::Failed));
    assert!(!settled);
    assert_eq!(c.spent_by_agent(agent(), 1).0, 0);
    assert_eq!(c.spent_by_vault(1).0, 0);
    assert!(c.consumed_payment("p1".into()).is_none());
    assert!(get_logs().iter().any(|l| l.contains("payment_failed")));
}

#[test]
fn settlement_emits_payment_executed() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    let p = payment("p1", 60);
    c.pay(p.clone());
    testing_env!(context(vault(), agent(), DAY_NS).build());
    assert!(c.on_transfer(p, 1, None, None, Ok(())));
    let log = get_logs().into_iter().find(|l| l.contains("payment_executed")).expect("event");
    assert!(log.starts_with("EVENT_JSON:"));
    assert!(log.contains("\"agent_day_spent_after\":\"60\""));
}

#[test]
fn nep413_digest_matches_the_spec_layout() {
    let c = setup();
    let (_, pk) = key(2);
    let p = payment("p1", 150);
    let a = authorization(&p, &pk, 1);
    let message = c.exception_message(a.clone());
    // Hand-built: tag (u32 LE), string (u32 len + bytes), 32-byte nonce, string, Option::None.
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&NEP413_TAG.to_le_bytes());
    bytes.extend_from_slice(&(message.len() as u32).to_le_bytes());
    bytes.extend_from_slice(message.as_bytes());
    bytes.extend_from_slice(&[1u8; 32]);
    let recipient = vault().to_string();
    bytes.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    bytes.extend_from_slice(recipient.as_bytes());
    bytes.push(0);
    assert_eq!(c.nep413_digest(&a), env::sha256_array(&bytes));
}

// ---- EVM payments -------------------------------------------------------------------------------

const ARC: u64 = 5_042_002;
const EVM_VENDOR: &str = "0x1111111111111111111111111111111111111111";

fn evm_setup() -> Contract {
    let mut c = setup();
    c.set_evm_chain(
        ARC,
        EvmChain {
            token: "0x3600000000000000000000000000000000000000".into(),
            max_fee_per_gas: U128(50_000_000_000),
            max_priority_fee_per_gas: U128(1_000_000_000),
            gas_limit: U64(100_000),
            enabled: true,
        },
    );
    c.set_evm_recipient(ARC, EVM_VENDOR.into(), true);
    c
}

fn evm_payment(id: &str, amount: u128) -> EvmPayment {
    EvmPayment {
        payment_id: id.to_string(),
        agent: agent(),
        chain_id: ARC,
        recipient: EVM_VENDOR.into(),
        amount: U128(amount),
        evidence_commitment: Base64VecU8::from(vec![7u8; 32]),
        policy_version: 1,
        recipient_version: 1,
        valid_until: U64(10 * DAY_SECONDS),
    }
}

fn fields() -> (U128, U128, U64, String) {
    (U128(50_000_000_000), U128(1_000_000_000), U64(100_000), "0x3600000000000000000000000000000000000000".into())
}

#[test]
fn evm_payment_commits_counters_and_waits_for_the_signer() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    c.pay_evm(evm_payment("e1", 60));
    assert_eq!(c.spent_by_agent(agent(), 1).0, 60);
    assert_eq!(c.evm_pending(), Some(ARC));
    assert!(c.consumed_payment("e1".into()).is_some());
}

#[test]
#[should_panic(expected = "EvmRequestInFlight")]
fn one_evm_request_at_a_time() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    c.pay_evm(evm_payment("e1", 10));
    c.pay_evm(evm_payment("e2", 10));
}

#[test]
#[should_panic(expected = "PerPaymentLimitExceeded")]
fn evm_over_the_limit_without_a_signature() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    c.pay_evm(evm_payment("e1", 101));
}

#[test]
#[should_panic(expected = "RecipientNotAllowed")]
fn evm_pays_only_allowed_addresses() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    let mut p = evm_payment("e1", 10);
    p.recipient = "0x2222222222222222222222222222222222222222".into();
    c.pay_evm(p);
}

#[test]
#[should_panic(expected = "InvalidAddress")]
fn evm_recipient_must_be_canonical_lowercase() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    let mut p = evm_payment("e1", 10);
    p.recipient = format!("0x{}", "AB".repeat(20));
    c.pay_evm(p);
}

#[test]
#[should_panic(expected = "ChainNotAllowed")]
fn evm_pays_only_on_configured_chains() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    let mut p = evm_payment("e1", 10);
    p.chain_id = 1;
    c.pay_evm(p);
}

#[test]
#[should_panic(expected = "DailyLimitExceeded")]
fn evm_and_near_payments_share_the_daily_limit() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 100));
    c.pay(payment("p2", 100));
    c.pay_evm(evm_payment("e1", 51));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn agent_cannot_add_a_chain_or_an_evm_recipient() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    c.set_evm_recipient(ARC, "0x2222222222222222222222222222222222222222".into(), true);
}

#[test]
fn evm_exception_with_a_valid_signature_is_sent_to_the_signer() {
    let mut c = evm_setup();
    let (sk, pk) = key(2);
    let p = evm_payment("e1", 150);
    let mut a = authorization(&payment("unused", 1), &pk, 1);
    a.payment_hash = Base64VecU8::from(hash_evm_payment(&p, "0x3600000000000000000000000000000000000000").to_vec());
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_evm_with_exception(p, a, sig);
    assert_eq!(c.spent_by_agent(agent(), 1).0, 150);
}

#[test]
#[should_panic(expected = "PaymentHashMismatch")]
fn a_near_payment_approval_does_not_work_for_an_evm_payment() {
    let mut c = evm_setup();
    let (sk, pk) = key(2);
    let near_payment = payment("e1", 150);
    let a = authorization(&near_payment, &pk, 1);
    let sig = sign(&c, &sk, &a);
    as_agent(agent(), DAY_NS);
    c.pay_evm_with_exception(evm_payment("e1", 150), a, sig);
}

#[test]
fn signer_answer_becomes_a_raw_transaction_that_recovers_to_the_signing_key() {
    use k256::ecdsa::{SigningKey as K256Key, VerifyingKey};
    use sha3::{Digest, Keccak256};
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    let p = evm_payment("e1", 60);
    c.pay_evm(p.clone());
    // Stand-in for the MPC signer: sign the same sighash with a known secp256k1 key.
    let chain = c.get_evm_chain(ARC).unwrap();
    let transfer = c.transfer_for(&p, 0, &fields());
    let sighash = Keccak256::digest(transfer.signing_payload());
    let mpc_key = K256Key::from_slice(&[9u8; 32]).unwrap();
    let (sig, rid) = mpc_key.sign_prehash_recoverable(&sighash).unwrap();
    let r_bytes: [u8; 32] = sig.r().to_bytes().into();
    let s_bytes: [u8; 32] = sig.s().to_bytes().into();
    let mut big_r = vec![if rid.is_y_odd() { 0x03 } else { 0x02 }];
    big_r.extend_from_slice(&r_bytes);
    let answer = MpcSignature {
        big_r: MpcPoint { affine_point: evm::hex(&big_r) },
        s: MpcScalar { scalar: evm::hex(&s_bytes) },
        recovery_id: rid.to_byte(),
    };
    testing_env!(context(vault(), agent(), DAY_NS).build());
    let tx = c.on_evm_signed(p, 1, 0, fields(), None, None, Ok(answer)).expect("signed");
    assert_eq!(c.evm_nonce(ARC), 1);
    assert_eq!(c.evm_pending(), None);
    assert_eq!(c.signed_evm_tx(ARC, 0), Some(tx.clone()));
    // k256 already returns low-s, so the vault must emit exactly this transaction.
    assert_eq!(tx.raw_tx, format!("0x{}", evm::hex(&transfer.signed(rid.to_byte(), &r_bytes, &s_bytes))));
    let recovered = VerifyingKey::recover_from_prehash(&sighash, &sig, rid).unwrap();
    assert_eq!(recovered, *mpc_key.verifying_key());
    assert_eq!(tx.tx_hash, format!("0x{}", evm::hex(&Keccak256::digest(hex_decode(&tx.raw_tx[2..])))));
    assert!(get_logs().iter().any(|l| l.contains("evm_payment_signed")));
}

#[test]
fn signer_failure_rolls_back_and_frees_the_chain() {
    let mut c = evm_setup();
    as_agent(agent(), DAY_NS);
    let p = evm_payment("e1", 60);
    c.pay_evm(p.clone());
    testing_env!(context(vault(), agent(), DAY_NS).build());
    assert!(c.on_evm_signed(p, 1, 0, fields(), None, None, Err(PromiseError::Failed)).is_none());
    assert_eq!(c.spent_by_agent(agent(), 1).0, 0);
    assert_eq!(c.evm_pending(), None);
    assert_eq!(c.evm_nonce(ARC), 0);
    assert!(c.consumed_payment("e1".into()).is_none());
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

// ---- x402: EIP-3009 authorizations signed by the vault (contract version 3) ----

const BASE_SEPOLIA: u64 = 84_532;
const BASE_USDC: &str = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/// The address of the stand-in MPC key [9; 32], computed independently (coincurve + keccak).
const MPC_ADDRESS: &str = "0x58da990a8f4a3a6ca7cb6315d68a140105917352";

fn x402_setup() -> Contract {
    let mut c = setup();
    c.set_evm_chain(
        BASE_SEPOLIA,
        EvmChain { token: BASE_USDC.into(), max_fee_per_gas: U128(1), max_priority_fee_per_gas: U128(1), gas_limit: U64(100_000), enabled: true },
    );
    c.set_evm_recipient(BASE_SEPOLIA, EVM_VENDOR.into(), true);
    c.set_evm_address(MPC_ADDRESS.into());
    c.set_x402_domain(BASE_SEPOLIA, "USDC".into(), "2".into());
    c
}

fn x402_payment(id: &str, amount: u128) -> EvmPayment {
    EvmPayment { chain_id: BASE_SEPOLIA, ..evm_payment(id, amount) }
}

/// What the MPC signer would answer for `digest`, from the stand-in key.
fn mpc_answer(digest: &[u8], seed: u8) -> MpcSignature {
    use k256::ecdsa::SigningKey as K256Key;
    let key = K256Key::from_slice(&[seed; 32]).unwrap();
    let (sig, rid) = key.sign_prehash_recoverable(digest).unwrap();
    let r: [u8; 32] = sig.r().to_bytes().into();
    let s: [u8; 32] = sig.s().to_bytes().into();
    let mut big_r = vec![if rid.is_y_odd() { 0x03 } else { 0x02 }];
    big_r.extend_from_slice(&r);
    MpcSignature { big_r: MpcPoint { affine_point: evm::hex(&big_r) }, s: MpcScalar { scalar: evm::hex(&s) }, recovery_id: rid.to_byte() }
}

#[test]
fn x402_digest_matches_an_independent_eip712_computation() {
    // USDC on Base Sepolia: name "USDC", version "2" (read from the chain), and its domain separator
    // 0x71f17a3b…9818 also matches the chain. Expected value computed separately with pycryptodome.
    let nonce: [u8; 32] = core::array::from_fn(|i| i as u8);
    let d = x402_digest(&X402Domain { name: "USDC".into(), version: "2".into() }, BASE_SEPOLIA, BASE_USDC, MPC_ADDRESS, EVM_VENDOR, 60, 0, 864_000, &nonce);
    assert_eq!(evm::hex(&d), "604df4702cd21f9217786116a4a3be46f885ecf68c6028cda222f950eeffca9a");
}

#[test]
fn x402_payment_is_signed_from_the_vault_address_within_the_limits() {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    let mut c = x402_setup();
    as_agent(agent(), DAY_NS);
    let p = x402_payment("x1", 60);
    c.pay_x402(p.clone());
    assert_eq!(c.spent_by_agent(agent(), 1).0, 60);
    assert_eq!(c.evm_pending(), None, "x402 takes no EVM nonce lock");
    let nonce = hash_evm_payment(&p, BASE_USDC);
    let digest = x402_digest(&X402Domain { name: "USDC".into(), version: "2".into() }, BASE_SEPOLIA, BASE_USDC, MPC_ADDRESS, EVM_VENDOR, 60, 0, p.valid_until.0, &nonce);
    testing_env!(context(vault(), agent(), DAY_NS).build());
    let auth = c
        .on_x402_signed(p, 1, MPC_ADDRESS.into(), BASE_USDC.into(), evm::hex(&nonce), evm::hex(&digest), Ok(mpc_answer(&digest, 9)))
        .expect("signed");
    assert_eq!((auth.from.as_str(), auth.to.as_str(), auth.value.0, auth.token.as_str()), (MPC_ADDRESS, EVM_VENDOR, 60, BASE_USDC));
    assert_eq!(auth.nonce, format!("0x{}", evm::hex(&nonce)));
    // The 65-byte signature recovers to the vault's address over the EIP-712 digest.
    let raw = hex_decode(&auth.signature[2..]);
    assert!(raw[64] == 27 || raw[64] == 28);
    let sig = Signature::from_slice(&raw[..64]).unwrap();
    let recovered = VerifyingKey::recover_from_prehash(&digest, &sig, RecoveryId::from_byte(raw[64] - 27).unwrap()).unwrap();
    use sha3::{Digest, Keccak256};
    let addr = &Keccak256::digest(&recovered.to_encoded_point(false).as_bytes()[1..])[12..];
    assert_eq!(format!("0x{}", evm::hex(addr)), MPC_ADDRESS);
    assert_eq!(c.get_x402_authorization("x1".into()), Some(auth));
    assert!(get_logs().iter().any(|l| l.contains("x402_authorization_signed")));
}

#[test]
fn a_signature_from_any_other_key_rolls_the_payment_back() {
    let mut c = x402_setup();
    as_agent(agent(), DAY_NS);
    let p = x402_payment("x1", 60);
    c.pay_x402(p.clone());
    let nonce = hash_evm_payment(&p, BASE_USDC);
    let digest = x402_digest(&X402Domain { name: "USDC".into(), version: "2".into() }, BASE_SEPOLIA, BASE_USDC, MPC_ADDRESS, EVM_VENDOR, 60, 0, p.valid_until.0, &nonce);
    testing_env!(context(vault(), agent(), DAY_NS).build());
    assert!(c.on_x402_signed(p.clone(), 1, MPC_ADDRESS.into(), BASE_USDC.into(), evm::hex(&nonce), evm::hex(&digest), Ok(mpc_answer(&digest, 8))).is_none());
    assert_eq!(c.spent_by_agent(agent(), 1).0, 0);
    assert!(c.consumed_payment("x1".into()).is_none());
    assert!(c.get_x402_authorization("x1".into()).is_none());
    testing_env!(context(vault(), agent(), DAY_NS).build());
    assert!(c.on_x402_signed(p, 1, MPC_ADDRESS.into(), BASE_USDC.into(), evm::hex(&nonce), evm::hex(&digest), Err(PromiseError::Failed)).is_none());
}

#[test]
#[should_panic(expected = "PerPaymentLimitExceeded")]
fn x402_over_the_per_payment_limit_is_refused() {
    let mut c = x402_setup();
    as_agent(agent(), DAY_NS);
    c.pay_x402(x402_payment("x1", 101));
}

#[test]
#[should_panic(expected = "RecipientNotAllowed")]
fn x402_only_pays_allowed_recipients() {
    let mut c = x402_setup();
    as_agent(agent(), DAY_NS);
    c.pay_x402(EvmPayment { recipient: "0x2222222222222222222222222222222222222222".into(), ..x402_payment("x1", 10) });
}

#[test]
#[should_panic(expected = "DailyLimitExceeded")]
fn x402_counts_against_the_agent_daily_limit() {
    let mut c = x402_setup();
    as_agent(agent(), DAY_NS);
    c.pay_x402(x402_payment("x1", 100));
    c.pay_x402(x402_payment("x2", 100));
    c.pay_x402(x402_payment("x3", 100));
}

#[test]
#[should_panic(expected = "X402NotEnabled")]
fn x402_needs_the_owner_to_enable_the_chain_domain() {
    let mut c = setup();
    c.set_evm_chain(BASE_SEPOLIA, EvmChain { token: BASE_USDC.into(), max_fee_per_gas: U128(1), max_priority_fee_per_gas: U128(1), gas_limit: U64(100_000), enabled: true });
    c.set_evm_recipient(BASE_SEPOLIA, EVM_VENDOR.into(), true);
    c.set_evm_address(MPC_ADDRESS.into());
    as_agent(agent(), DAY_NS);
    c.pay_x402(x402_payment("x1", 10));
}

#[test]
#[should_panic(expected = "EvmAddressNotSet")]
fn x402_needs_the_vault_evm_address() {
    let mut c = setup();
    c.set_evm_chain(BASE_SEPOLIA, EvmChain { token: BASE_USDC.into(), max_fee_per_gas: U128(1), max_priority_fee_per_gas: U128(1), gas_limit: U64(100_000), enabled: true });
    c.set_evm_recipient(BASE_SEPOLIA, EVM_VENDOR.into(), true);
    c.set_x402_domain(BASE_SEPOLIA, "USDC".into(), "2".into());
    as_agent(agent(), DAY_NS);
    c.pay_x402(x402_payment("x1", 10));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn only_the_owner_sets_the_vault_evm_address() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.set_evm_address(MPC_ADDRESS.into());
}

#[test]
fn the_agent_key_may_call_pay_x402_and_the_vault_reports_version_3() {
    assert!(AGENT_METHODS.split(',').any(|m| m == "pay_x402"));
    let c = x402_setup();
    assert_eq!(c.get_vault().contract_version, 3);
    assert_eq!(c.get_vault().evm_address.as_deref(), Some(MPC_ADDRESS));
}

// ---- Sentinel: a key that can only pause (contract version 3) ----

fn sentinel() -> PublicKey {
    key(5).1
}

#[test]
fn the_sentinel_pauses_and_payments_stop_but_only_the_owner_unpauses() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    assert_eq!(c.get_sentinels(), vec![sentinel()]);
    testing_env!(context(vault(), sentinel(), DAY_NS).build());
    c.sentinel_pause("burst".into());
    assert!(c.get_vault().paused);
    assert!(get_logs().iter().any(|l| l.contains(r#""event":"sentinel_paused""#)));
    as_owner(DAY_NS);
    c.unpause();
    assert!(!c.get_vault().paused);
}

#[test]
#[should_panic(expected = "NotSentinel")]
fn an_agent_key_cannot_use_sentinel_pause() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(agent(), DAY_NS);
    c.sentinel_pause("burst".into());
}

#[test]
#[should_panic(expected = "NotSentinel")]
fn sentinel_pause_must_come_from_the_vault_account_itself() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    testing_env!(context(acct("stranger.testnet"), sentinel(), DAY_NS).build());
    c.sentinel_pause("burst".into());
}

#[test]
#[should_panic(expected = "NotSentinel")]
fn a_removed_sentinel_can_no_longer_pause() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    c.set_sentinel(sentinel(), false);
    testing_env!(context(vault(), sentinel(), DAY_NS).build());
    c.sentinel_pause("burst".into());
}

#[test]
#[should_panic(expected = "NotOwner")]
fn the_sentinel_cannot_unpause() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    testing_env!(context(vault(), sentinel(), DAY_NS).build());
    c.sentinel_pause("burst".into());
    c.unpause();
}

#[test]
#[should_panic(expected = "NotOwner")]
fn only_the_owner_sets_the_sentinel() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.set_sentinel(sentinel(), true);
}

#[test]
#[should_panic(expected = "RoleConflict")]
fn an_agent_key_cannot_become_the_sentinel() {
    let mut c = setup();
    c.set_sentinel(agent(), true);
}

#[test]
#[should_panic(expected = "RoleConflict")]
fn the_sentinel_key_cannot_become_an_agent() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    c.configure_agent(sentinel(), U128(1), U128(1), U64(10 * DAY_SECONDS), true);
}

#[test]
fn the_sentinel_key_is_limited_to_sentinel_pause() {
    assert_eq!(SENTINEL_METHODS, "sentinel_pause");
    assert!(!AGENT_METHODS.split(',').any(|m| m == "sentinel_pause"));
}
#[test]
fn sentinel_event_has_reason_day_and_spend_and_repeated_pause_is_noop() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(agent(), DAY_NS);
    c.pay(payment("before-pause", 60));
    as_agent(sentinel(), DAY_NS);
    c.sentinel_pause("é".repeat(140));
    let logs = get_logs();
    let event: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(
        logs[0].strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(event["event"], "sentinel_paused");
    assert_eq!(event["data"][0]["sentinel"], near_sdk::serde_json::json!(sentinel()));
    assert_eq!(event["data"][0]["reason"], "é".repeat(140));
    assert_eq!(event["data"][0]["day"], 1);
    assert_eq!(event["data"][0]["vault_day_spent"], "60");
    c.sentinel_pause("again".into());
    assert_eq!(get_logs(), logs);
}

#[test]
#[should_panic(expected = "ReasonTooLong")]
fn sentinel_reason_limit_counts_bytes() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(sentinel(), DAY_NS);
    c.sentinel_pause("é".repeat(141));
}

#[test]
fn eight_sentinels_reenable_and_disable_are_idempotent() {
    let mut c = setup();
    for i in 10..18 { c.set_sentinel(key(i).1, true); }
    c.set_sentinel(key(10).1, true);
    assert_eq!(c.get_sentinels().len(), 8);
    c.set_sentinel(key(10).1, false);
    c.set_sentinel(key(10).1, false);
    c.set_sentinel(key(18).1, true);
    assert_eq!(c.get_sentinels().len(), 8);
    assert!(!c.get_sentinels().contains(&key(10).1));
}

#[test]
#[should_panic(expected = "TooManySentinels")]
fn ninth_sentinel_is_refused() {
    let mut c = setup();
    for i in 10..19 { c.set_sentinel(key(i).1, true); }
}

#[test]
#[should_panic(expected = "SentinelMustBeEd25519")]
fn sentinel_must_be_ed25519() {
    let mut c = setup();
    c.set_sentinel(PublicKey::from_parts(CurveType::SECP256K1, vec![1; 64]).unwrap(), true);
}

#[test]
#[should_panic(expected = "NotAgent")]
fn sentinel_cannot_pay_even_before_pausing() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(sentinel(), DAY_NS);
    c.pay(payment("sentinel-pay", 1));
}

#[test]
#[should_panic(expected = "NotOwner")]
fn sentinel_cannot_change_rules() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(sentinel(), DAY_NS);
    c.set_vault_daily_limit(U128(1000));
}

#[test]
#[should_panic(expected = "VaultPaused")]
fn sentinel_pause_stops_agent_payments() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(sentinel(), DAY_NS);
    c.sentinel_pause("burst".into());
    as_agent(agent(), DAY_NS);
    c.pay(payment("after-pause", 1));
}

#[test]
fn disabled_roles_can_be_reassigned() {
    let mut c = setup();
    c.configure_agent(agent(), U128(1), U128(1), U64(10 * DAY_SECONDS), false);
    c.set_sentinel(agent(), true);
    c.set_sentinel(agent(), false);
    c.configure_agent(agent(), U128(1), U128(1), U64(10 * DAY_SECONDS), true);
}

#[test]
fn sentinel_key_actions_are_pause_only_and_removal_deletes_key() {
    use near_sdk::{mock::MockAction, test_utils::get_created_receipts};
    let mut c = setup();
    as_owner(DAY_NS);
    drop(c.set_sentinel(sentinel(), true));
    let receipts = get_created_receipts();
    let actions: Vec<_> = receipts.iter().flat_map(|r| &r.actions).collect();
    assert!(actions.iter().any(|a| matches!(a, MockAction::AddKeyWithFunctionCall {
        public_key, allowance, receiver_id, method_names, ..
    } if public_key.to_string() == near_sdk::serde_json::to_value(sentinel()).unwrap().as_str().unwrap()
        && *allowance == Some(NearToken::from_millinear(50))
        && *receiver_id == vault() && *method_names == vec!["sentinel_pause".to_string()])));
    as_owner(DAY_NS);
    drop(c.set_sentinel(sentinel(), true));
    assert!(get_created_receipts().iter().all(|r| r.actions.is_empty()));
    as_owner(DAY_NS);
    drop(c.set_sentinel(sentinel(), false));
    assert!(get_created_receipts().iter().flat_map(|r| &r.actions).any(|a|
        matches!(a, MockAction::DeleteKey { public_key, .. }
            if public_key.to_string() == near_sdk::serde_json::to_value(sentinel()).unwrap().as_str().unwrap())));
}

// ---- Velocity limit: at most N payments per window, every pay path, owner-set, off by default ----

const S: u64 = 1_000_000_000;

#[test]
fn velocity_limit_is_off_by_default() {
    let mut c = setup();
    let v = c.get_vault();
    assert_eq!((v.max_payments_per_window, v.window_seconds), (0, 0));
    for i in 0..12 {
        as_agent(agent(), DAY_NS);
        c.pay(payment(&format!("p{i}"), 1));
    }
}

#[test]
#[should_panic(expected = "VelocityLimit")]
fn the_n_plus_first_payment_in_the_window_is_refused() {
    let mut c = setup();
    c.set_velocity_limit(3, 60);
    as_agent(agent(), DAY_NS);
    for i in 0..3 {
        c.pay(payment(&format!("p{i}"), 1));
    }
    c.pay(payment("p3", 1));
}

#[test]
fn the_window_slides() {
    let mut c = setup();
    c.set_velocity_limit(2, 60);
    as_agent(agent(), DAY_NS);
    c.pay(payment("a", 1));
    as_agent(agent(), DAY_NS + 30 * S);
    c.pay(payment("b", 1));
    // 61 s after the first: it left the window, the second has not.
    as_agent(agent(), DAY_NS + 61 * S);
    c.pay(payment("c", 1));
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        as_agent(agent(), DAY_NS + 62 * S);
        c.pay(payment("d", 1));
    }));
    assert!(refused.is_err());
    as_agent(agent(), DAY_NS + 91 * S);
    c.pay(payment("e", 1));
    assert_eq!(c.spent_by_agent(agent(), 1).0, 4);
}

#[test]
#[should_panic(expected = "VelocityLimit")]
fn the_limit_covers_exceptions_too() {
    let mut c = setup();
    c.set_velocity_limit(1, 60);
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 1));
    let p = payment("p2", 150);
    let a = authorization(&p, &key(2).1, 1);
    let sig = sign(&c, &key(2).0, &a);
    c.pay_with_exception(p, a, sig);
}

#[test]
#[should_panic(expected = "VelocityLimit")]
fn the_limit_is_vault_wide_across_near_and_evm() {
    let mut c = evm_setup();
    c.set_velocity_limit(1, 60);
    as_agent(agent(), DAY_NS);
    c.pay(payment("near-1", 1));
    c.pay_evm(evm_payment("evm-1", 1));
}

#[test]
#[should_panic(expected = "VelocityLimit")]
fn the_limit_covers_x402() {
    let mut c = x402_setup();
    c.set_velocity_limit(1, 60);
    as_agent(agent(), DAY_NS);
    c.pay_x402(x402_payment("x-1", 1));
    c.pay_x402(x402_payment("x-2", 1));
}

#[test]
fn a_refused_payment_charges_nothing() {
    let mut c = setup();
    c.set_velocity_limit(1, 60);
    as_agent(agent(), DAY_NS);
    c.pay(payment("p1", 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.pay(payment("p2", 1))));
    assert!(r.is_err());
    assert_eq!(c.spent_by_agent(agent(), 1).0, 1);
    assert!(c.consumed_payment("p2".into()).is_none());
}

#[test]
#[should_panic(expected = "NotOwner")]
fn the_agent_cannot_change_the_velocity_limit() {
    let mut c = setup();
    as_agent(agent(), DAY_NS);
    c.set_velocity_limit(0, 0);
}

#[test]
#[should_panic(expected = "NotOwner")]
fn a_sentinel_cannot_change_the_velocity_limit() {
    let mut c = setup();
    c.set_sentinel(sentinel(), true);
    as_agent(sentinel(), DAY_NS);
    c.set_velocity_limit(100, 1);
}

#[test]
fn the_owner_sets_shows_and_clears_it_within_bounds() {
    let mut c = setup();
    c.set_velocity_limit(5, 300);
    let v = c.get_vault();
    assert_eq!((v.max_payments_per_window, v.window_seconds), (5, 300));
    assert!(get_logs().iter().any(|l| l.contains("velocity_limit_set") && l.contains("\"window_seconds\":300")));
    for (n, w) in [(101, 60), (5, 0), (5, DAY_SECONDS + 1)] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_velocity_limit(n, w)));
        assert!(r.is_err(), "{n} per {w}s should be refused");
    }
    c.set_velocity_limit(0, 999);
    let v = c.get_vault();
    assert_eq!((v.max_payments_per_window, v.window_seconds), (0, 0));
}
