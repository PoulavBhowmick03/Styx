//! Styx vault on NEAR.
//!
//! A funded vault pays an agent's payments within the owner's rules. Agents are function-call
//! access keys on the vault account, restricted to the pay methods, so the protocol itself refuses
//! a call from an agent key to any owner method. Going over the per-payment limit needs an
//! approver's NEP-413 signature over that exact payment. The daily limits are never lifted.
//!
//! Money moves through a NEP-141 token. `pay` commits the counters first, then calls
//! `ft_transfer`; if the transfer fails the callback rolls the counters back.

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    env, near, require, AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseError, PublicKey,
};

/// NEP-413 prefix tag: 2^31 + 413, Borsh-serialized as a little-endian u32.
const NEP413_TAG: u32 = 2_147_484_061;
const DAY_SECONDS: u64 = 86_400;
const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
/// Gas allowance each agent key gets. Gas only: the key holds no tokens.
const AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
const AGENT_METHODS: &str = "pay,pay_with_exception,post_record";
const CONTRACT_VERSION: u32 = 1;
const EVENT_STANDARD: &str = "styx";
const EVENT_VERSION: &str = "1.0.0";

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Agents,
    Approvers,
    Recipients,
    SpentByAgentDay,
    SpentByDay,
    ConsumedPayments,
    ConsumedNonces,
    Records,
}

/// An agent's policy. Keyed by the public key of the agent's function-call key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentPolicy {
    pub version: u64,
    pub per_payment_limit: U128,
    pub daily_limit: U128,
    /// Unix seconds.
    pub valid_until: U64,
    pub enabled: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApproverState {
    pub version: u64,
    pub enabled: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecipientState {
    pub version: u64,
    pub allowed: bool,
}

/// The exact payment. Hashed with Borsh, so every field is part of the commitment.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub payment_id: String,
    pub agent: PublicKey,
    pub token: AccountId,
    pub recipient: AccountId,
    pub amount: U128,
    pub evidence_commitment: Base64VecU8,
    pub policy_version: u64,
    pub recipient_version: u64,
    /// Unix seconds.
    pub valid_until: U64,
}

/// What the approver signs. The contract rebuilds the NEP-413 payload from this and the
/// payment, so a signature is good for exactly one payment, one signer version and one nonce.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExceptionAuthorization {
    pub payment_hash: Base64VecU8,
    pub signer: PublicKey,
    pub signer_version: u64,
    /// The NEP-413 nonce, 32 bytes. Single use per signer.
    pub approval_nonce: Base64VecU8,
    /// Unix seconds.
    pub authorization_expiry: U64,
    /// Present only when the wallet put a callback URL in the signed payload.
    pub callback_url: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultInfo {
    pub owner: AccountId,
    pub token: AccountId,
    pub paused: bool,
    pub vault_daily_limit: U128,
    pub contract_version: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    token: AccountId,
    paused: bool,
    vault_daily_limit: u128,
    agents: LookupMap<PublicKey, AgentPolicy>,
    approvers: LookupMap<PublicKey, ApproverState>,
    recipients: LookupMap<AccountId, RecipientState>,
    spent_by_agent_day: LookupMap<(PublicKey, u64), u128>,
    spent_by_day: LookupMap<u64, u128>,
    /// payment id -> payment hash. Present once a payment is in flight or settled.
    consumed_payments: LookupMap<String, [u8; 32]>,
    consumed_nonces: LookupSet<(PublicKey, [u8; 32])>,
    /// payment id -> the agent key that posted a sealed record for it.
    records: LookupMap<String, PublicKey>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, token: AccountId) -> Self {
        Self {
            owner,
            token,
            paused: false,
            vault_daily_limit: 0,
            agents: LookupMap::new(StorageKey::Agents),
            approvers: LookupMap::new(StorageKey::Approvers),
            recipients: LookupMap::new(StorageKey::Recipients),
            spent_by_agent_day: LookupMap::new(StorageKey::SpentByAgentDay),
            spent_by_day: LookupMap::new(StorageKey::SpentByDay),
            consumed_payments: LookupMap::new(StorageKey::ConsumedPayments),
            consumed_nonces: LookupSet::new(StorageKey::ConsumedNonces),
            records: LookupMap::new(StorageKey::Records),
        }
    }

    // ---- owner methods ----------------------------------------------------------------------

    /// Sets an agent's policy and installs (or removes) its function-call key on this account.
    /// Every call advances only this agent's version. Spend counters never reset.
    pub fn configure_agent(
        &mut self,
        agent: PublicKey,
        per_payment_limit: U128,
        daily_limit: U128,
        valid_until: U64,
        enabled: bool,
    ) -> Promise {
        self.assert_owner();
        if enabled {
            require!(
                !self.approvers.get(&agent).map(|a| a.enabled).unwrap_or(false),
                "RoleConflict"
            );
        }
        let was_enabled = self.agents.get(&agent).map(|p| p.enabled).unwrap_or(false);
        let version = self.agents.get(&agent).map(|p| p.version).unwrap_or(0) + 1;
        let policy = AgentPolicy { version, per_payment_limit, daily_limit, valid_until, enabled };
        self.agents.insert(agent.clone(), policy.clone());
        emit("agent_configured", &near_sdk::serde_json::json!({ "agent": agent, "policy": policy }));
        let account = env::current_account_id();
        match (was_enabled, enabled) {
            (false, true) => Promise::new(account.clone()).add_access_key_allowance(
                agent,
                Allowance::limited(AGENT_KEY_ALLOWANCE).expect("non-zero allowance"),
                account,
                AGENT_METHODS.to_string(),
            ),
            (true, false) => Promise::new(account).delete_key(agent),
            // The key is already in the right state; return a no-op promise so the method's
            // return type is uniform.
            _ => Promise::new(account),
        }
    }

    pub fn set_approver(&mut self, approver: PublicKey, enabled: bool) {
        self.assert_owner();
        require!(is_ed25519(&approver), "ApproverMustBeEd25519");
        if enabled {
            require!(
                !self.agents.get(&approver).map(|p| p.enabled).unwrap_or(false),
                "RoleConflict"
            );
        }
        let version = self.approvers.get(&approver).map(|a| a.version).unwrap_or(0) + 1;
        let state = ApproverState { version, enabled };
        self.approvers.insert(approver.clone(), state.clone());
        emit("approver_set", &near_sdk::serde_json::json!({ "approver": approver, "state": state }));
    }

    pub fn set_recipient(&mut self, recipient: AccountId, allowed: bool) {
        self.assert_owner();
        require!(recipient != env::current_account_id(), "InvalidRecipient");
        let version = self.recipients.get(&recipient).map(|r| r.version).unwrap_or(0) + 1;
        let state = RecipientState { version, allowed };
        self.recipients.insert(recipient.clone(), state.clone());
        emit("recipient_set", &near_sdk::serde_json::json!({ "recipient": recipient, "state": state }));
    }

    pub fn set_vault_daily_limit(&mut self, limit: U128) {
        self.assert_owner();
        self.vault_daily_limit = limit.0;
        emit("vault_daily_limit_set", &near_sdk::serde_json::json!({ "limit": limit }));
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        emit("paused", &near_sdk::serde_json::json!({}));
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        emit("unpaused", &near_sdk::serde_json::json!({}));
    }

    /// Moves tokens out of the vault. No counters apply; only the owner can call it.
    pub fn withdraw(&mut self, to: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(to != env::current_account_id(), "InvalidRecipient");
        emit("owner_withdrawal", &near_sdk::serde_json::json!({ "to": to, "amount": amount }));
        ft_transfer(&self.token, &to, amount.0, "styx withdrawal")
    }

    // ---- agent methods ----------------------------------------------------------------------

    /// A payment within every limit. Callable only through an agent's function-call key.
    pub fn pay(&mut self, payment: Payment) -> Promise {
        let (policy, day) = self.check_shared(&payment);
        require!(payment.amount.0 <= policy.per_payment_limit.0, "PerPaymentLimitExceeded");
        self.execute(payment, day, None)
    }

    /// A payment over the per-payment limit, with an approver's NEP-413 signature over it.
    /// The daily limits still apply; no signature lifts them.
    pub fn pay_with_exception(
        &mut self,
        payment: Payment,
        authorization: ExceptionAuthorization,
        signature: Base64VecU8,
    ) -> Promise {
        let (_, day) = self.check_shared(&payment);
        let hash = hash_payment(&payment);
        require!(authorization.payment_hash.0 == hash, "PaymentHashMismatch");
        let state = self.approvers.get(&authorization.signer).cloned();
        let state = state.filter(|s| s.enabled).unwrap_or_else(|| env::panic_str("ApproverNotAllowed"));
        require!(authorization.signer_version == state.version, "SignerVersionMismatch");
        let nonce = to_32(&authorization.approval_nonce.0, "BadNonce");
        let nonce_key = (authorization.signer.clone(), nonce);
        require!(!self.consumed_nonces.contains(&nonce_key), "ApprovalNonceUsed");
        require!(now_seconds() <= authorization.authorization_expiry.0, "AuthorizationExpired");
        let digest = self.nep413_digest(&authorization);
        let sig: [u8; 64] = signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("BadSignature"));
        let pk = ed25519_bytes(&authorization.signer);
        require!(env::ed25519_verify(&sig, &digest, &pk), "BadSignature");
        self.consumed_nonces.insert(nonce_key);
        self.execute(payment, day, Some((authorization, digest)))
    }

    /// Posts a sealed record for a settled payment. Only the agent key that paid can post it,
    /// once. The record itself lives in the event log; the reviewer opens it with their own key.
    pub fn post_record(&mut self, payment_id: String, sealed: Base64VecU8) {
        require!(env::predecessor_account_id() == env::current_account_id(), "NotAgent");
        let agent = env::signer_account_pk();
        require!(self.agents.get(&agent).map(|p| p.enabled).unwrap_or(false), "NotAgent");
        let hash = self
            .consumed_payments
            .get(&payment_id)
            .copied()
            .unwrap_or_else(|| env::panic_str("UnknownPayment"));
        require!(!self.records.contains_key(&payment_id), "RecordAlreadyPosted");
        self.records.insert(payment_id.clone(), agent.clone());
        emit(
            "record_sealed",
            &near_sdk::serde_json::json!({
                "payment_id": payment_id,
                "payment_hash": Base64VecU8::from(hash.to_vec()),
                "agent": agent,
                "sealed": sealed,
            }),
        );
    }

    /// Settles or rolls back after `ft_transfer`. Private: only this contract can call it.
    #[private]
    pub fn on_transfer(
        &mut self,
        payment: Payment,
        day: u64,
        exception: Option<ExceptionAuthorization>,
        approval_digest: Option<Base64VecU8>,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        match result {
            Ok(()) => {
                let policy = self.agents.get(&payment.agent).cloned().expect("agent");
                let agent_spent = self.spent_by_agent_day.get(&(payment.agent.clone(), day)).copied().unwrap_or(0);
                let vault_spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
                emit(
                    "payment_executed",
                    &near_sdk::serde_json::json!({
                        "payment_id": payment.payment_id,
                        "agent": payment.agent,
                        "recipient": payment.recipient,
                        "amount": payment.amount,
                        "payment_hash": Base64VecU8::from(hash_payment(&payment).to_vec()),
                        "evidence_commitment": payment.evidence_commitment,
                        "policy_version": payment.policy_version,
                        "recipient_version": payment.recipient_version,
                        "per_payment_limit": policy.per_payment_limit,
                        "daily_limit": policy.daily_limit,
                        "vault_daily_limit": U128(self.vault_daily_limit),
                        "day": day,
                        "agent_day_spent_after": U128(agent_spent),
                        "vault_day_spent_after": U128(vault_spent),
                        "exception": exception.is_some(),
                        "signer": exception.as_ref().map(|a| a.signer.clone()),
                        "signer_version": exception.as_ref().map(|a| a.signer_version),
                        "approval_digest": approval_digest,
                    }),
                );
                true
            }
            Err(_) => {
                // The token refused the transfer (unregistered recipient, insufficient balance).
                // Undo everything `execute` committed so the payment can be retried or dropped.
                self.consumed_payments.remove(&payment.payment_id);
                let key = (payment.agent.clone(), day);
                let agent_spent = self.spent_by_agent_day.get(&key).copied().unwrap_or(0);
                self.spent_by_agent_day.insert(key, agent_spent.saturating_sub(payment.amount.0));
                let vault_spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
                self.spent_by_day.insert(day, vault_spent.saturating_sub(payment.amount.0));
                if let Some(a) = exception {
                    let nonce = to_32(&a.approval_nonce.0, "BadNonce");
                    self.consumed_nonces.remove(&(a.signer, nonce));
                }
                emit(
                    "payment_failed",
                    &near_sdk::serde_json::json!({
                        "payment_id": payment.payment_id,
                        "agent": payment.agent,
                        "recipient": payment.recipient,
                        "amount": payment.amount,
                    }),
                );
                false
            }
        }
    }

    // ---- views ------------------------------------------------------------------------------

    pub fn get_vault(&self) -> VaultInfo {
        VaultInfo {
            owner: self.owner.clone(),
            token: self.token.clone(),
            paused: self.paused,
            vault_daily_limit: U128(self.vault_daily_limit),
            contract_version: CONTRACT_VERSION,
        }
    }

    pub fn get_agent(&self, agent: PublicKey) -> Option<AgentPolicy> {
        self.agents.get(&agent).cloned()
    }

    pub fn get_approver(&self, approver: PublicKey) -> Option<ApproverState> {
        self.approvers.get(&approver).cloned()
    }

    pub fn get_recipient(&self, recipient: AccountId) -> Option<RecipientState> {
        self.recipients.get(&recipient).cloned()
    }

    pub fn spent_by_agent(&self, agent: PublicKey, day: u64) -> U128 {
        U128(self.spent_by_agent_day.get(&(agent, day)).copied().unwrap_or(0))
    }

    pub fn spent_by_vault(&self, day: u64) -> U128 {
        U128(self.spent_by_day.get(&day).copied().unwrap_or(0))
    }

    pub fn current_day(&self) -> u64 {
        now_seconds() / DAY_SECONDS
    }

    pub fn payment_hash(&self, payment: Payment) -> Base64VecU8 {
        Base64VecU8::from(hash_payment(&payment).to_vec())
    }

    pub fn consumed_payment(&self, payment_id: String) -> Option<Base64VecU8> {
        self.consumed_payments.get(&payment_id).map(|h| Base64VecU8::from(h.to_vec()))
    }

    /// The exact NEP-413 `message` the approver signs. The `recipient` of the NEP-413 payload
    /// is this vault's account id and the `nonce` is `authorization.approval_nonce`.
    pub fn exception_message(&self, authorization: ExceptionAuthorization) -> String {
        build_exception_message(&env::current_account_id(), &authorization)
    }

    // ---- internals --------------------------------------------------------------------------

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "NotOwner");
    }

    /// Every check shared by `pay` and `pay_with_exception`, in the same order as the Arc vault.
    fn check_shared(&self, p: &Payment) -> (AgentPolicy, u64) {
        require!(env::predecessor_account_id() == env::current_account_id(), "NotAgent");
        let agent = env::signer_account_pk();
        let policy = self.agents.get(&agent).cloned().filter(|p| p.enabled);
        let policy = policy.unwrap_or_else(|| env::panic_str("NotAgent"));
        require!(!self.paused, "VaultPaused");
        let now = now_seconds();
        require!(now <= policy.valid_until.0, "PolicyExpired");
        require!(p.agent == agent, "AgentMismatch");
        require!(p.token == self.token, "TokenMismatch");
        require!(p.policy_version == policy.version, "PolicyVersionMismatch");
        require!(now <= p.valid_until.0, "PaymentExpired");
        require!(p.amount.0 > 0, "ZeroAmount");
        let recipient = self.recipients.get(&p.recipient).cloned().filter(|r| r.allowed);
        let recipient = recipient.unwrap_or_else(|| env::panic_str("RecipientNotAllowed"));
        require!(p.recipient_version == recipient.version, "RecipientVersionMismatch");
        require!(!self.consumed_payments.contains_key(&p.payment_id), "PaymentAlreadyUsed");
        let day = now / DAY_SECONDS;
        let spent = self.spent_by_agent_day.get(&(agent, day)).copied().unwrap_or(0);
        require!(
            spent <= policy.daily_limit.0 && p.amount.0 <= policy.daily_limit.0 - spent,
            "DailyLimitExceeded"
        );
        let spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
        require!(
            spent <= self.vault_daily_limit && p.amount.0 <= self.vault_daily_limit - spent,
            "VaultDailyLimitExceeded"
        );
        (policy, day)
    }

    /// Commits the counters, then transfers. The callback settles or rolls back.
    fn execute(
        &mut self,
        payment: Payment,
        day: u64,
        exception: Option<(ExceptionAuthorization, [u8; 32])>,
    ) -> Promise {
        let hash = hash_payment(&payment);
        self.consumed_payments.insert(payment.payment_id.clone(), hash);
        let key = (payment.agent.clone(), day);
        let agent_spent = self.spent_by_agent_day.get(&key).copied().unwrap_or(0);
        self.spent_by_agent_day.insert(key, agent_spent + payment.amount.0);
        let vault_spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
        self.spent_by_day.insert(day, vault_spent + payment.amount.0);
        let (authorization, digest) = match exception {
            Some((a, d)) => (Some(a), Some(Base64VecU8::from(d.to_vec()))),
            None => (None, None),
        };
        let memo = format!("styx:{}", payment.payment_id);
        ft_transfer(&self.token, &payment.recipient, payment.amount.0, &memo).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_transfer(payment, day, authorization, digest),
        )
    }

    /// sha256(borsh(u32 tag) ++ borsh(Payload{message, nonce, recipient, callback_url})).
    fn nep413_digest(&self, a: &ExceptionAuthorization) -> [u8; 32] {
        let message = build_exception_message(&env::current_account_id(), a);
        let nonce = to_32(&a.approval_nonce.0, "BadNonce");
        let payload = Nep413Payload {
            message,
            nonce,
            recipient: env::current_account_id().to_string(),
            callback_url: a.callback_url.clone(),
        };
        let mut bytes = Vec::new();
        NEP413_TAG.serialize(&mut bytes).expect("borsh");
        payload.serialize(&mut bytes).expect("borsh");
        env::sha256_array(&bytes)
    }
}

/// NEP-413 payload. Field order matters: it is Borsh-serialized exactly like this.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Nep413Payload {
    message: String,
    nonce: [u8; 32],
    recipient: String,
    callback_url: Option<String>,
}

fn build_exception_message(vault: &AccountId, a: &ExceptionAuthorization) -> String {
    format!(
        "Styx exception\nvault: {}\npayment_hash: {}\nsigner: {}\nsigner_version: {}\nexpires: {}",
        vault,
        hex(&a.payment_hash.0),
        pk_string(&a.signer),
        a.signer_version,
        a.authorization_expiry.0
    )
}

fn hash_payment(p: &Payment) -> [u8; 32] {
    let mut bytes = Vec::new();
    p.serialize(&mut bytes).expect("borsh");
    env::sha256_array(&bytes)
}

fn ft_transfer(token: &AccountId, to: &AccountId, amount: u128, memo: &str) -> Promise {
    let args = near_sdk::serde_json::json!({
        "receiver_id": to,
        "amount": U128(amount),
        "memo": memo,
    });
    Promise::new(token.clone()).function_call(
        "ft_transfer".to_string(),
        near_sdk::serde_json::to_vec(&args).expect("json"),
        NearToken::from_yoctonear(1),
        GAS_FOR_FT_TRANSFER,
    )
}

fn now_seconds() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn is_ed25519(pk: &PublicKey) -> bool {
    pk.as_bytes().len() == 33 && pk.as_bytes()[0] == 0
}

fn ed25519_bytes(pk: &PublicKey) -> [u8; 32] {
    require!(is_ed25519(pk), "ApproverMustBeEd25519");
    pk.as_bytes()[1..].try_into().expect("32 bytes")
}

fn to_32(bytes: &[u8], error: &str) -> [u8; 32] {
    bytes.try_into().unwrap_or_else(|_| env::panic_str(error))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn pk_string(pk: &PublicKey) -> String {
    near_sdk::serde_json::to_value(pk)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// NEP-297 event log.
fn emit(event: &str, data: &near_sdk::serde_json::Value) {
    let payload = near_sdk::serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{payload}"));
}

#[cfg(test)]
mod tests;
