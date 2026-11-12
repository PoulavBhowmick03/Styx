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
    let mut c = Contract::new(owner(), token());
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
