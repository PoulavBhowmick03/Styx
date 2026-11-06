//! The reviewer's payment record, version 1.

use serde::{Deserialize, Serialize};

use super::types::{decimal, hex_fixed, Payment};

/// Schema tag of [`VaultPaymentRecord`].
pub const RECORD_SCHEMA: &str = "vault-payment-record/1";

/// The policy snapshot, exactly as the vault emitted it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicySnapshot {
    /// Policy version enforced.
    #[serde(with = "decimal")]
    pub policy_version: u64,
    /// Per-payment limit enforced.
    #[serde(with = "decimal")]
    pub per_payment_limit: u128,
    /// Daily limit enforced.
    #[serde(with = "decimal")]
    pub daily_limit: u128,
    /// UTC day number.
    #[serde(with = "decimal")]
    pub day: u64,
    /// That day's spend after this payment.
    #[serde(with = "decimal")]
    pub day_spent_after: u128,
}

/// The owner's approval, present only for exceptions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExceptionEvidence {
    /// The signed nonce.
    #[serde(with = "decimal")]
    pub approval_nonce: u128,
    /// The signed expiry.
    #[serde(with = "decimal")]
    pub authorization_expiry: u64,
    /// The digest the owner signed.
    #[serde(with = "hex_fixed")]
    pub approval_digest: [u8; 32],
    /// The owner's 65-byte signature.
    #[serde(with = "hex_fixed")]
    pub owner_signature: [u8; 65],
}

/// The opening of the evidence commitment.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceOpening {
    /// Canonical invoice bytes as `0x` hex.
    pub invoice_hex: String,
    /// The commitment's salt.
    #[serde(with = "hex_fixed")]
    pub salt: [u8; 32],
}

impl core::fmt::Debug for EvidenceOpening {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("EvidenceOpening { <redacted> }")
    }
}

/// Where the payment landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettlementPointer {
    /// Transaction hash.
    #[serde(with = "hex_fixed")]
    pub tx_hash: [u8; 32],
    /// Block number.
    #[serde(with = "decimal")]
    pub block_number: u64,
    /// Log index.
    #[serde(with = "decimal")]
    pub log_index: u64,
}

/// One record a reviewer can check against the chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultPaymentRecord {
    /// Always [`RECORD_SCHEMA`].
    pub schema: String,
    /// Chain ID.
    #[serde(with = "decimal")]
    pub chain_id: u64,
    /// Vault address.
    #[serde(with = "hex_fixed")]
    pub vault: [u8; 20],
    /// keccak256 of the vault's runtime code.
    #[serde(with = "hex_fixed")]
    pub vault_code_hash: [u8; 32],
    /// The exact payment.
    pub payment: Payment,
    /// The policy snapshot as emitted.
    pub policy: PolicySnapshot,
    /// The owner's approval, when the exception path ran.
    pub exception: Option<ExceptionEvidence>,
    /// The evidence opening.
    pub evidence: EvidenceOpening,
    /// Where it settled.
    pub settlement: SettlementPointer,
}
