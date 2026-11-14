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
/// Each sentinel key may call only this method: pause, never unpause or anything else.
const SENTINEL_METHODS: &str = "sentinel_pause";
const MAX_SENTINELS: usize = 8;
const SENTINEL_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(50);
const AGENT_METHODS: &str = "pay,pay_with_exception,pay_evm,pay_evm_with_exception,pay_x402,post_record";
/// The MPC signer used when the constructor names none.
const DEFAULT_MPC_SIGNER: &str = "v1.signer-prod.testnet";
/// Derivation path for the vault's EVM key. The address depends on this vault's account id and it.
const EVM_KEY_PATH: &str = "styx-evm";
const GAS_FOR_MPC_SIGN: Gas = Gas::from_tgas(50);
const GAS_FOR_EVM_CALLBACK: Gas = Gas::from_tgas(20);
const CONTRACT_VERSION: u32 = 3;
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
    EvmChains,
    EvmRecipients,
    EvmNonces,
    EvmSignedTxs,
    X402Domains,
    X402Signed,
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

/// An EVM chain the vault may pay on: the token's ERC-20 address and the owner's gas caps.
/// Gas is paid by the vault's derived address, outside the payment limits, bounded by these caps.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmChain {
    pub token: String,
    pub max_fee_per_gas: U128,
    pub max_priority_fee_per_gas: U128,
    pub gas_limit: U64,
    pub enabled: bool,
}

/// A payment on an EVM chain. The vault builds the transaction from these fields and its own
/// state (nonce, gas caps, token); the agent cannot choose anything else that gets signed.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EvmPayment {
    pub payment_id: String,
    pub agent: PublicKey,
    pub chain_id: u64,
    /// `0x` + 40 hex digits, lowercase.
    pub recipient: String,
    pub amount: U128,
    pub evidence_commitment: Base64VecU8,
    pub policy_version: u64,
    pub recipient_version: u64,
    /// Unix seconds.
    pub valid_until: U64,
}

/// The EIP-712 domain of a chain's USDC (its `name()` and `version()`), for x402 authorizations.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct X402Domain {
    pub name: String,
    pub version: String,
}

/// A signed EIP-3009 `transferWithAuthorization` from the vault's EVM address, ready for an x402
/// payment header. Whoever submits it pays the gas; the token checks the signature and the nonce.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct X402Authorization {
    pub payment_id: String,
    pub chain_id: u64,
    pub token: String,
    pub from: String,
    pub to: String,
    pub value: U128,
    pub valid_after: U64,
    pub valid_before: U64,
    /// `0x` + 64 hex: the payment's hash, so each payment has its own EIP-3009 nonce.
    pub nonce: String,
    /// `0x` + r, s, v (27 or 28): 65 bytes.
    pub signature: String,
}

/// A signed EVM transaction, ready for anyone to broadcast.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedEvmTx {
    pub payment_id: String,
    pub chain_id: u64,
    pub nonce: u64,
    /// `0x`-prefixed raw transaction for `eth_sendRawTransaction`.
    pub raw_tx: String,
    /// `0x`-prefixed keccak256 of `raw_tx`, the EVM transaction hash.
    pub tx_hash: String,
}

/// The MPC signer's secp256k1 answer.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MpcSignature {
    pub big_r: MpcPoint,
    pub s: MpcScalar,
    pub recovery_id: u8,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MpcPoint {
    pub affine_point: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct MpcScalar {
    pub scalar: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultInfo {
    pub owner: AccountId,
    pub token: AccountId,
    pub paused: bool,
    pub vault_daily_limit: U128,
    pub contract_version: u32,
    pub mpc_signer: AccountId,
    pub evm_key_path: String,
    /// The vault's derived EVM address, as set by the owner; x402 authorizations are signed from it.
    pub evm_address: Option<String>,
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
    mpc_signer: AccountId,
    evm_chains: LookupMap<u64, EvmChain>,
    /// (chain id, recipient address) -> allowed and version.
    evm_recipients: LookupMap<(u64, [u8; 20]), RecipientState>,
    /// The next nonce of the vault's derived address on each chain.
    evm_nonces: LookupMap<u64, u64>,
    /// (chain id, nonce) -> the signed transaction, so anyone can broadcast or rebroadcast it.
    evm_signed: LookupMap<(u64, u64), SignedEvmTx>,
    /// The chain with a signature request in flight. One at a time keeps nonces sequential.
    evm_pending: Option<u64>,
    /// The vault's own derived EVM address (set by the owner, checked against every x402 signature).
    evm_address: Option<String>,
    x402_domains: LookupMap<u64, X402Domain>,
    /// payment id -> the signed x402 authorization.
    x402_signed: LookupMap<String, X402Authorization>,
    /// At most eight function-call keys, each restricted to `sentinel_pause`.
    sentinels: Vec<PublicKey>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, token: AccountId, mpc_signer: Option<AccountId>) -> Self {
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
            mpc_signer: mpc_signer.unwrap_or_else(|| DEFAULT_MPC_SIGNER.parse().expect("signer id")),
            evm_chains: LookupMap::new(StorageKey::EvmChains),
            evm_recipients: LookupMap::new(StorageKey::EvmRecipients),
            evm_nonces: LookupMap::new(StorageKey::EvmNonces),
            evm_signed: LookupMap::new(StorageKey::EvmSignedTxs),
            evm_pending: None,
            evm_address: None,
            x402_domains: LookupMap::new(StorageKey::X402Domains),
            x402_signed: LookupMap::new(StorageKey::X402Signed),
            sentinels: Vec::new(),
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
            require!(!self.sentinels.contains(&agent), "RoleConflict");
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

    /// The vault's derived EVM address (MPC key at path `styx-evm` for this account). x402
    /// authorizations name it as `from`; every signature is checked to recover to it.
    pub fn set_evm_address(&mut self, address: String) {
        self.assert_owner();
        let parsed = evm::parse_address(&address).unwrap_or_else(|| env::panic_str("InvalidAddress"));
        let lower = format!("0x{}", evm::hex(&parsed));
        self.evm_address = Some(lower.clone());
        emit("evm_address_set", &near_sdk::serde_json::json!({ "address": lower }));
    }

    /// Enables x402 on a configured chain: the EIP-712 domain of its USDC (`name()`, `version()`).
    pub fn set_x402_domain(&mut self, chain_id: u64, name: String, version: String) {
        self.assert_owner();
        require!(self.evm_chains.get(&chain_id).is_some(), "ChainNotAllowed");
        require!(!name.is_empty() && name.len() <= 64 && !version.is_empty() && version.len() <= 16, "BadDomain");
        self.x402_domains.insert(chain_id, X402Domain { name: name.clone(), version: version.clone() });
        emit("x402_domain_set", &near_sdk::serde_json::json!({ "chain_id": chain_id, "name": name, "version": version }));
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

    /// Installs or removes a pause-only key. Repeating the current state is a no-op.
    pub fn set_sentinel(&mut self, key: PublicKey, enabled: bool) -> Promise {
        self.assert_owner();
        require!(is_ed25519(&key), "SentinelMustBeEd25519");
        if enabled {
            require!(!self.agents.get(&key).map(|p| p.enabled).unwrap_or(false), "RoleConflict");
        }
        let account = env::current_account_id();
        let position = self.sentinels.iter().position(|k| k == &key);
        match (position, enabled) {
            (None, true) => {
                require!(self.sentinels.len() < MAX_SENTINELS, "TooManySentinels");
                self.sentinels.push(key.clone());
                emit("sentinel_set", &near_sdk::serde_json::json!({"sentinel": key, "enabled": true}));
                Promise::new(account.clone()).add_access_key_allowance(
                    key,
                    Allowance::limited(SENTINEL_KEY_ALLOWANCE).expect("non-zero allowance"),
                    account,
                    SENTINEL_METHODS.to_string(),
                )
            }
            (Some(i), false) => {
                self.sentinels.remove(i);
                emit("sentinel_set", &near_sdk::serde_json::json!({"sentinel": key, "enabled": false}));
                Promise::new(account).delete_key(key)
            }
            _ => Promise::new(account),
        }
    }

    pub fn get_sentinels(&self) -> Vec<PublicKey> {
        self.sentinels.clone()
    }

    /// An enabled sentinel can pause, but only the owner can resume payments.
    pub fn sentinel_pause(&mut self, reason: String) {
        require!(env::predecessor_account_id() == env::current_account_id(), "NotSentinel");
        let sentinel = env::signer_account_pk();
        require!(self.sentinels.contains(&sentinel), "NotSentinel");
        require!(reason.len() <= 280, "ReasonTooLong");
        if self.paused {
            return;
        }
        self.paused = true;
        let day = self.current_day();
        emit("sentinel_paused", &near_sdk::serde_json::json!({
            "sentinel": sentinel, "reason": reason, "day": day,
            "vault_day_spent": self.spent_by_vault(day)
        }));
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


    // ---- owner methods for EVM chains -------------------------------------------------------

    /// Adds or changes an EVM chain: the token's ERC-20 address and the gas caps the vault uses.
    pub fn set_evm_chain(&mut self, chain_id: u64, chain: EvmChain) {
        self.assert_owner();
        let token = evm::parse_address(&chain.token).unwrap_or_else(|| env::panic_str("InvalidAddress"));
        require!(chain.max_priority_fee_per_gas.0 <= chain.max_fee_per_gas.0, "InvalidGasCaps");
        require!(chain.gas_limit.0 >= 21_000, "InvalidGasCaps");
        let chain = EvmChain { token: format!("0x{}", evm::hex(&token)), ..chain };
        self.evm_chains.insert(chain_id, chain.clone());
        emit("evm_chain_set", &near_sdk::serde_json::json!({ "chain_id": chain_id, "chain": chain }));
    }

    pub fn set_evm_recipient(&mut self, chain_id: u64, recipient: String, allowed: bool) {
        self.assert_owner();
        let address = evm::parse_address(&recipient.to_ascii_lowercase()).unwrap_or_else(|| env::panic_str("InvalidAddress"));
        let key = (chain_id, address);
        let version = self.evm_recipients.get(&key).map(|r| r.version).unwrap_or(0) + 1;
        let state = RecipientState { version, allowed };
        self.evm_recipients.insert(key, state.clone());
        emit(
            "evm_recipient_set",
            &near_sdk::serde_json::json!({ "chain_id": chain_id, "recipient": format!("0x{}", evm::hex(&address)), "state": state }),
        );
    }

    /// Resyncs the vault's nonce for a chain, for when a signed transaction was never broadcast
    /// or another transaction used the nonce. Also clears a stuck in-flight request.
    pub fn set_evm_nonce(&mut self, chain_id: u64, nonce: u64) {
        self.assert_owner();
        self.evm_nonces.insert(chain_id, nonce);
        if self.evm_pending == Some(chain_id) {
            self.evm_pending = None;
        }
        emit("evm_nonce_set", &near_sdk::serde_json::json!({ "chain_id": chain_id, "nonce": nonce }));
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
        let digest = self.check_authorization(&hash, &authorization, &signature);
        self.execute(payment, day, Some((authorization, digest)))
    }

    /// A payment on an EVM chain within every limit. The vault builds and signs the transfer.
    pub fn pay_evm(&mut self, payment: EvmPayment) -> Promise {
        let (policy, day) = self.check_evm(&payment);
        require!(payment.amount.0 <= policy.per_payment_limit.0, "PerPaymentLimitExceeded");
        self.execute_evm(payment, day, None)
    }

    /// An EVM payment over the per-payment limit, with an approver's NEP-413 signature over it.
    pub fn pay_evm_with_exception(
        &mut self,
        payment: EvmPayment,
        authorization: ExceptionAuthorization,
        signature: Base64VecU8,
    ) -> Promise {
        let (_, day) = self.check_evm(&payment);
        let hash = hash_evm_payment(&payment, &self.evm_token(payment.chain_id));
        let digest = self.check_authorization(&hash, &authorization, &signature);
        self.execute_evm(payment, day, Some((authorization, digest)))
    }

    /// An x402 payment within every limit: the vault signs an EIP-3009 `transferWithAuthorization`
    /// of the chain's USDC from its own EVM address to an allowed recipient, through the MPC signer.
    /// The same checks and counters as `pay_evm`; no EVM nonce or gas, since the payee submits it.
    /// Over the per-payment limit it is refused: there is no exception path for x402.
    pub fn pay_x402(&mut self, payment: EvmPayment) -> Promise {
        let (policy, day) = self.check_evm_payment(&payment, false);
        require!(payment.amount.0 <= policy.per_payment_limit.0, "PerPaymentLimitExceeded");
        let from = self.evm_address.clone().unwrap_or_else(|| env::panic_str("EvmAddressNotSet"));
        let domain = self.x402_domains.get(&payment.chain_id).cloned().unwrap_or_else(|| env::panic_str("X402NotEnabled"));
        let token = self.evm_token(payment.chain_id);
        let nonce = hash_evm_payment(&payment, &token);
        let digest = x402_digest(&domain, payment.chain_id, &token, &from, &payment.recipient, payment.amount.0, 0, payment.valid_until.0, &nonce);
        self.consumed_payments.insert(payment.payment_id.clone(), nonce);
        set_payer(&payment.payment_id, &payment.agent);
        let key = (payment.agent.clone(), day);
        let agent_spent = self.spent_by_agent_day.get(&key).copied().unwrap_or(0);
        self.spent_by_agent_day.insert(key, agent_spent + payment.amount.0);
        let vault_spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
        self.spent_by_day.insert(day, vault_spent + payment.amount.0);
        let args = near_sdk::serde_json::json!({
            "request": { "path": EVM_KEY_PATH, "payload_v2": { "Ecdsa": evm::hex(&digest) }, "domain_id": 0 }
        });
        Promise::new(self.mpc_signer.clone())
            .function_call("sign".to_string(), near_sdk::serde_json::to_vec(&args).expect("json"), NearToken::from_yoctonear(1), GAS_FOR_MPC_SIGN)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_EVM_CALLBACK)
                    .on_x402_signed(payment, day, from, token, evm::hex(&nonce), evm::hex(&digest)),
            )
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
        require!(payer(&payment_id).as_ref() == Some(&agent), "NotPayer");
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
                clear_payer(&payment.payment_id);
                self.records.remove(&payment.payment_id);
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

    /// Assembles the signed EVM transaction from the MPC signer's answer, or rolls back.
    #[private]
    pub fn on_evm_signed(
        &mut self,
        payment: EvmPayment,
        day: u64,
        nonce: u64,
        transfer_fields: (U128, U128, U64, String),
        exception: Option<ExceptionAuthorization>,
        approval_digest: Option<Base64VecU8>,
        #[callback_result] result: Result<MpcSignature, PromiseError>,
    ) -> Option<SignedEvmTx> {
        self.evm_pending = None;
        let chain = self.evm_chains.get(&payment.chain_id).cloned();
        let signed = match (result, chain) {
            (Ok(sig), Some(_chain)) => {
                let big_r = evm::unhex::<33>(&sig.big_r.affine_point);
                let s = evm::unhex::<32>(&sig.s.scalar);
                match (big_r, s) {
                    (Some(big_r), Some(s)) => evm::normalize(&big_r, &s, sig.recovery_id).map(|(r, s, v)| {
                        let transfer = self.transfer_for(&payment, nonce, &transfer_fields);
                        let raw = transfer.signed(v, &r, &s);
                        SignedEvmTx {
                            payment_id: payment.payment_id.clone(),
                            chain_id: payment.chain_id,
                            nonce,
                            tx_hash: format!("0x{}", evm::hex(&env::keccak256_array(&raw))),
                            raw_tx: format!("0x{}", evm::hex(&raw)),
                        }
                    }),
                    _ => None,
                }
            }
            _ => None,
        };
        match signed {
            Some(tx) => {
                self.evm_nonces.insert(payment.chain_id, nonce + 1);
                self.evm_signed.insert((payment.chain_id, nonce), tx.clone());
                let policy = self.agents.get(&payment.agent).cloned().expect("agent");
                emit(
                    "evm_payment_signed",
                    &near_sdk::serde_json::json!({
                        "payment_id": payment.payment_id,
                        "agent": payment.agent,
                        "chain_id": payment.chain_id,
                        "recipient": payment.recipient,
                        "amount": payment.amount,
                        "payment_hash": Base64VecU8::from(hash_evm_payment(&payment, &transfer_fields.3).to_vec()),
                        "token": transfer_fields.3,
                        "evidence_commitment": payment.evidence_commitment,
                        "nonce": nonce,
                        "tx_hash": tx.tx_hash,
                        "raw_tx": tx.raw_tx,
                        "per_payment_limit": policy.per_payment_limit,
                        "daily_limit": policy.daily_limit,
                        "day": day,
                        "agent_day_spent_after": U128(self.spent_by_agent_day.get(&(payment.agent.clone(), day)).copied().unwrap_or(0)),
                        "vault_day_spent_after": U128(self.spent_by_day.get(&day).copied().unwrap_or(0)),
                        "exception": exception.is_some(),
                        "signer": exception.as_ref().map(|a| a.signer.clone()),
                        "approval_digest": approval_digest,
                    }),
                );
                Some(tx)
            }
            None => {
                self.rollback(&payment.payment_id, &payment.agent, payment.amount.0, day, exception);
                emit(
                    "payment_failed",
                    &near_sdk::serde_json::json!({
                        "payment_id": payment.payment_id,
                        "agent": payment.agent,
                        "chain_id": payment.chain_id,
                        "recipient": payment.recipient,
                        "amount": payment.amount,
                        "reason": "signature unavailable",
                    }),
                );
                None
            }
        }
    }

    /// Keeps the x402 authorization only if the MPC signature recovers to the vault's EVM address;
    /// otherwise rolls the payment back like a failed EVM payment.
    #[private]
    pub fn on_x402_signed(
        &mut self,
        payment: EvmPayment,
        day: u64,
        from: String,
        token: String,
        nonce: String,
        digest: String,
        #[callback_result] result: Result<MpcSignature, PromiseError>,
    ) -> Option<X402Authorization> {
        let digest_bytes = evm::unhex::<32>(&digest).expect("digest");
        let signed = result.ok().and_then(|sig| {
            let big_r = evm::unhex::<33>(&sig.big_r.affine_point)?;
            let s = evm::unhex::<32>(&sig.s.scalar)?;
            let (r, s, v) = evm::normalize(&big_r, &s, sig.recovery_id)?;
            let mut rs = [0u8; 64];
            rs[..32].copy_from_slice(&r);
            rs[32..].copy_from_slice(&s);
            let public = env::ecrecover(&digest_bytes, &rs, v, true)?;
            let address = format!("0x{}", evm::hex(&env::keccak256_array(&public)[12..]));
            (address == from).then(|| {
                let mut sig65 = rs.to_vec();
                sig65.push(27 + v);
                X402Authorization {
                    payment_id: payment.payment_id.clone(),
                    chain_id: payment.chain_id,
                    token: token.clone(),
                    from: from.clone(),
                    to: payment.recipient.clone(),
                    value: payment.amount,
                    valid_after: U64(0),
                    valid_before: payment.valid_until,
                    nonce: format!("0x{nonce}"),
                    signature: format!("0x{}", evm::hex(&sig65)),
                }
            })
        });
        match signed {
            Some(auth) => {
                self.x402_signed.insert(payment.payment_id.clone(), auth.clone());
                emit(
                    "x402_authorization_signed",
                    &near_sdk::serde_json::json!({
                        "payment_id": payment.payment_id,
                        "agent": payment.agent,
                        "chain_id": payment.chain_id,
                        "recipient": payment.recipient,
                        "amount": payment.amount,
                        "token": token,
                        "nonce": auth.nonce,
                        "evidence_commitment": payment.evidence_commitment,
                        "day": day,
                        "agent_day_spent_after": U128(self.spent_by_agent_day.get(&(payment.agent.clone(), day)).copied().unwrap_or(0)),
                        "vault_day_spent_after": U128(self.spent_by_day.get(&day).copied().unwrap_or(0)),
                    }),
                );
                Some(auth)
            }
            None => {
                self.rollback(&payment.payment_id, &payment.agent, payment.amount.0, day, None);
                emit(
                    "payment_failed",
                    &near_sdk::serde_json::json!({
                        "payment_id": payment.payment_id, "agent": payment.agent, "chain_id": payment.chain_id,
                        "recipient": payment.recipient, "amount": payment.amount,
                        "reason": "x402 signature unavailable or not from the vault's EVM address",
                    }),
                );
                None
            }
        }
    }

    // ---- views ------------------------------------------------------------------------------

    pub fn get_x402_authorization(&self, payment_id: String) -> Option<X402Authorization> {
        self.x402_signed.get(&payment_id).cloned()
    }

    pub fn get_x402_domain(&self, chain_id: u64) -> Option<X402Domain> {
        self.x402_domains.get(&chain_id).cloned()
    }

    pub fn get_vault(&self) -> VaultInfo {
        VaultInfo {
            owner: self.owner.clone(),
            token: self.token.clone(),
            paused: self.paused,
            vault_daily_limit: U128(self.vault_daily_limit),
            contract_version: CONTRACT_VERSION,
            mpc_signer: self.mpc_signer.clone(),
            evm_key_path: EVM_KEY_PATH.to_string(),
            evm_address: self.evm_address.clone(),
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

    pub fn get_evm_chain(&self, chain_id: u64) -> Option<EvmChain> {
        self.evm_chains.get(&chain_id).cloned()
    }

    pub fn get_evm_recipient(&self, chain_id: u64, recipient: String) -> Option<RecipientState> {
        let address = evm::parse_address(&recipient.to_ascii_lowercase())?;
        self.evm_recipients.get(&(chain_id, address)).cloned()
    }

    pub fn evm_nonce(&self, chain_id: u64) -> u64 {
        self.evm_nonces.get(&chain_id).copied().unwrap_or(0)
    }

    pub fn signed_evm_tx(&self, chain_id: u64, nonce: u64) -> Option<SignedEvmTx> {
        self.evm_signed.get(&(chain_id, nonce)).cloned()
    }

    pub fn evm_pending(&self) -> Option<u64> {
        self.evm_pending
    }

    /// The hash an approver signs for an EVM payment. It includes the chain's current token, so an
    /// approval stops matching if the owner changes the token before the payment is made.
    pub fn evm_payment_hash(&self, payment: EvmPayment) -> Base64VecU8 {
        Base64VecU8::from(hash_evm_payment(&payment, &self.evm_token(payment.chain_id)).to_vec())
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

    /// The approver checks shared by both exception methods, in the Arc vault's order.
    /// Consumes the approval nonce and returns the NEP-413 digest.
    fn check_authorization(
        &mut self,
        payment_hash: &[u8; 32],
        authorization: &ExceptionAuthorization,
        signature: &Base64VecU8,
    ) -> [u8; 32] {
        require!(authorization.payment_hash.0 == payment_hash, "PaymentHashMismatch");
        let state = self.approvers.get(&authorization.signer).cloned();
        let state = state.filter(|s| s.enabled).unwrap_or_else(|| env::panic_str("ApproverNotAllowed"));
        require!(authorization.signer_version == state.version, "SignerVersionMismatch");
        let nonce = to_32(&authorization.approval_nonce.0, "BadNonce");
        let nonce_key = (authorization.signer.clone(), nonce);
        require!(!self.consumed_nonces.contains(&nonce_key), "ApprovalNonceUsed");
        require!(now_seconds() <= authorization.authorization_expiry.0, "AuthorizationExpired");
        let digest = self.nep413_digest(authorization);
        let sig: [u8; 64] = signature.0.as_slice().try_into().unwrap_or_else(|_| env::panic_str("BadSignature"));
        let pk = ed25519_bytes(&authorization.signer);
        require!(env::ed25519_verify(&sig, &digest, &pk), "BadSignature");
        self.consumed_nonces.insert(nonce_key);
        digest
    }

    /// The same checks as `check_shared`, in the same order, for an EVM payment.
    fn check_evm(&self, p: &EvmPayment) -> (AgentPolicy, u64) {
        self.check_evm_payment(p, true)
    }

    /// `needs_evm_nonce`: false for x402, which signs no EVM transaction and so takes no nonce lock.
    fn check_evm_payment(&self, p: &EvmPayment, needs_evm_nonce: bool) -> (AgentPolicy, u64) {
        require!(env::predecessor_account_id() == env::current_account_id(), "NotAgent");
        let agent = env::signer_account_pk();
        let policy = self.agents.get(&agent).cloned().filter(|p| p.enabled);
        let policy = policy.unwrap_or_else(|| env::panic_str("NotAgent"));
        require!(!self.paused, "VaultPaused");
        let now = now_seconds();
        require!(now <= policy.valid_until.0, "PolicyExpired");
        require!(p.agent == agent, "AgentMismatch");
        require!(self.evm_chains.get(&p.chain_id).map(|c| c.enabled).unwrap_or(false), "ChainNotAllowed");
        require!(p.policy_version == policy.version, "PolicyVersionMismatch");
        require!(now <= p.valid_until.0, "PaymentExpired");
        require!(p.amount.0 > 0, "ZeroAmount");
        let address = evm::parse_address(&p.recipient).unwrap_or_else(|| env::panic_str("InvalidAddress"));
        require!(p.recipient == format!("0x{}", evm::hex(&address)), "InvalidAddress");
        let recipient = self.evm_recipients.get(&(p.chain_id, address)).cloned().filter(|r| r.allowed);
        let recipient = recipient.unwrap_or_else(|| env::panic_str("RecipientNotAllowed"));
        require!(p.recipient_version == recipient.version, "RecipientVersionMismatch");
        require!(!self.consumed_payments.contains_key(&p.payment_id), "PaymentAlreadyUsed");
        require!(!needs_evm_nonce || self.evm_pending.is_none(), "EvmRequestInFlight");
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

    /// The chain's configured token, lowercase `0x` + 40 hex.
    fn evm_token(&self, chain_id: u64) -> String {
        self.evm_chains.get(&chain_id).map(|c| c.token.clone()).unwrap_or_else(|| env::panic_str("ChainNotAllowed"))
    }

    /// The transfer the vault signs for this payment: its token, gas caps and nonce, never the agent's.
    /// All of them are fixed when signing is requested (`fields`), never re-read in the callback.
    fn transfer_for(&self, p: &EvmPayment, nonce: u64, fields: &(U128, U128, U64, String)) -> evm::Transfer {
        evm::Transfer {
            chain_id: p.chain_id,
            nonce,
            max_priority_fee_per_gas: fields.1 .0,
            max_fee_per_gas: fields.0 .0,
            gas_limit: fields.2 .0,
            token: evm::parse_address(&fields.3).expect("token checked when set"),
            recipient: evm::parse_address(&p.recipient).expect("recipient checked"),
            amount: p.amount.0,
        }
    }

    /// Commits the counters, builds the transfer, and asks the MPC signer to sign it.
    fn execute_evm(
        &mut self,
        payment: EvmPayment,
        day: u64,
        exception: Option<(ExceptionAuthorization, [u8; 32])>,
    ) -> Promise {
        let chain = self.evm_chains.get(&payment.chain_id).cloned().expect("chain checked");
        let nonce = self.evm_nonce(payment.chain_id);
        // The gas fields are fixed now and passed to the callback, so the signed transaction is
        // exactly the one whose hash the signer saw, even if the owner changes the caps meanwhile.
        // The token is fixed the same way: the transaction assembled later is the one that was signed.
        let fields = (chain.max_fee_per_gas, chain.max_priority_fee_per_gas, chain.gas_limit, chain.token.clone());
        let transfer = self.transfer_for(&payment, nonce, &fields);
        let sighash = env::keccak256_array(&transfer.signing_payload());
        self.consumed_payments.insert(payment.payment_id.clone(), hash_evm_payment(&payment, &chain.token));
        set_payer(&payment.payment_id, &payment.agent);
        let key = (payment.agent.clone(), day);
        let agent_spent = self.spent_by_agent_day.get(&key).copied().unwrap_or(0);
        self.spent_by_agent_day.insert(key, agent_spent + payment.amount.0);
        let vault_spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
        self.spent_by_day.insert(day, vault_spent + payment.amount.0);
        self.evm_pending = Some(payment.chain_id);
        let (authorization, digest) = match exception {
            Some((a, d)) => (Some(a), Some(Base64VecU8::from(d.to_vec()))),
            None => (None, None),
        };
        let args = near_sdk::serde_json::json!({
            "request": {
                "path": EVM_KEY_PATH,
                "payload_v2": { "Ecdsa": evm::hex(&sighash) },
                "domain_id": 0,
            }
        });
        Promise::new(self.mpc_signer.clone())
            .function_call(
                "sign".to_string(),
                near_sdk::serde_json::to_vec(&args).expect("json"),
                NearToken::from_yoctonear(1),
                GAS_FOR_MPC_SIGN,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_EVM_CALLBACK)
                    .on_evm_signed(payment, day, nonce, fields, authorization, digest),
            )
    }

    /// Undoes what a payment committed: the payment id, both day counters, the approval nonce.
    fn rollback(&mut self, payment_id: &str, agent: &PublicKey, amount: u128, day: u64, exception: Option<ExceptionAuthorization>) {
        self.consumed_payments.remove(payment_id);
        clear_payer(payment_id);
        self.records.remove(payment_id);
        let key = (agent.clone(), day);
        let agent_spent = self.spent_by_agent_day.get(&key).copied().unwrap_or(0);
        self.spent_by_agent_day.insert(key, agent_spent.saturating_sub(amount));
        let vault_spent = self.spent_by_day.get(&day).copied().unwrap_or(0);
        self.spent_by_day.insert(day, vault_spent.saturating_sub(amount));
        if let Some(a) = exception {
            let nonce = to_32(&a.approval_nonce.0, "BadNonce");
            self.consumed_nonces.remove(&(a.signer, nonce));
        }
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
        set_payer(&payment.payment_id, &payment.agent);
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

// Who paid each payment, written when it is consumed and removed when it rolls back, so only that
// agent can post its record. A raw storage prefix rather than a new field: the root state layout,
// and so existing deployments, stay as they are. No other key starts with these bytes.
const PAYER_PREFIX: &[u8] = b"payer:";

fn payer_key(payment_id: &str) -> Vec<u8> {
    [PAYER_PREFIX, payment_id.as_bytes()].concat()
}

fn set_payer(payment_id: &str, agent: &PublicKey) {
    env::storage_write(&payer_key(payment_id), &near_sdk::borsh::to_vec(agent).expect("borsh"));
}

fn payer(payment_id: &str) -> Option<PublicKey> {
    env::storage_read(&payer_key(payment_id)).map(|b| near_sdk::borsh::from_slice(&b).expect("payer"))
}

fn clear_payer(payment_id: &str) {
    env::storage_remove(&payer_key(payment_id));
}

fn hash_evm_payment(p: &EvmPayment, token: &str) -> [u8; 32] {
    // Domain-separated from `hash_payment`, so a NEAR payment's approval can never match an EVM one.
    // v2 appends the token the vault will transfer, so an approval names the asset as well.
    let mut bytes = b"styx-evm-payment-v2".to_vec();
    p.serialize(&mut bytes).expect("borsh");
    token.to_string().serialize(&mut bytes).expect("borsh");
    env::sha256_array(&bytes)
}

/// The EIP-712 digest USDC verifies for `transferWithAuthorization` (EIP-3009):
/// keccak256(0x1901 || domainSeparator || keccak256(typehash, from, to, value, validAfter, validBefore, nonce)).
#[allow(clippy::too_many_arguments)]
fn x402_digest(d: &X402Domain, chain_id: u64, token: &str, from: &str, to: &str, value: u128, valid_after: u64, valid_before: u64, nonce: &[u8; 32]) -> [u8; 32] {
    let word_u = |v: u128| { let mut w = [0u8; 32]; w[16..].copy_from_slice(&v.to_be_bytes()); w };
    let word_a = |a: &str| { let mut w = [0u8; 32]; w[12..].copy_from_slice(&evm::parse_address(a).expect("address checked")); w };
    let k = |b: &[u8]| env::keccak256_array(b);
    let mut domain = k(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)").to_vec();
    domain.extend_from_slice(&k(d.name.as_bytes()));
    domain.extend_from_slice(&k(d.version.as_bytes()));
    domain.extend_from_slice(&word_u(chain_id as u128));
    domain.extend_from_slice(&word_a(token));
    let mut message = k(b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)").to_vec();
    message.extend_from_slice(&word_a(from));
    message.extend_from_slice(&word_a(to));
    message.extend_from_slice(&word_u(value));
    message.extend_from_slice(&word_u(valid_after as u128));
    message.extend_from_slice(&word_u(valid_before as u128));
    message.extend_from_slice(nonce);
    let mut out = vec![0x19, 0x01];
    out.extend_from_slice(&k(&domain));
    out.extend_from_slice(&k(&message));
    k(&out)
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

mod evm;

#[cfg(test)]
mod tests;
