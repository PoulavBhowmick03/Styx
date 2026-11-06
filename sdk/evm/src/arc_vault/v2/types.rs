//! The vault's typed structs and their JSON form.
//!
//! JSON integers are decimal strings, so no amount or nonce passes through a JavaScript float.

use serde::{Deserialize, Serialize};

/// Serde for `0x`-prefixed lowercase fixed-width hex.
pub mod hex_fixed {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    /// Encodes as `0x` hex.
    pub fn serialize<S: Serializer, const N: usize>(
        value: &[u8; N],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("0x{}", hex::encode(value)))
    }

    /// Decodes `0x` hex of exactly `N` bytes.
    pub fn deserialize<'de, D: Deserializer<'de>, const N: usize>(
        deserializer: D,
    ) -> Result<[u8; N], D::Error> {
        let text = String::deserialize(deserializer)?;
        super::parse_hex(&text).map_err(D::Error::custom)
    }
}

/// Serde for decimal-string integers.
pub mod decimal {
    use core::fmt::Display;
    use core::str::FromStr;
    use serde::{de::Error, Deserialize, Deserializer, Serializer};

    /// Encodes as a decimal string.
    pub fn serialize<S: Serializer, T: Display>(
        value: &T,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_str(value)
    }

    /// Decodes canonical ASCII digits only: no sign, no leading zeros.
    pub fn deserialize<'de, D: Deserializer<'de>, T: FromStr>(
        deserializer: D,
    ) -> Result<T, D::Error> {
        let text = String::deserialize(deserializer)?;
        let canonical = !text.is_empty()
            && text.bytes().all(|byte| byte.is_ascii_digit())
            && (text == "0" || !text.starts_with('0'));
        if !canonical {
            return Err(D::Error::custom("expected a canonical decimal string"));
        }
        text.parse()
            .map_err(|_| D::Error::custom("decimal out of range"))
    }
}

/// Parses `0x`-prefixed hex of exactly `N` bytes.
pub fn parse_hex<const N: usize>(text: &str) -> Result<[u8; N], String> {
    let digits = text
        .strip_prefix("0x")
        .ok_or_else(|| "expected 0x-prefixed hex".to_owned())?;
    let bytes = hex::decode(digits).map_err(|_| "invalid hex".to_owned())?;
    bytes
        .try_into()
        .map_err(|_| format!("expected {N} bytes of hex"))
}

/// `Payment` as the vault hashes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payment {
    /// One-time payment identifier.
    #[serde(with = "hex_fixed")]
    pub payment_id: [u8; 32],
    /// The agent the vault must have configured.
    #[serde(with = "hex_fixed")]
    pub agent: [u8; 20],
    /// The vault's token.
    #[serde(with = "hex_fixed")]
    pub token: [u8; 20],
    /// An allowed recipient.
    #[serde(with = "hex_fixed")]
    pub recipient: [u8; 20],
    /// Amount in ERC-20 base units (6 decimals for USDC).
    #[serde(with = "decimal")]
    pub amount: u128,
    /// Commitment to the private invoice.
    #[serde(with = "hex_fixed")]
    pub evidence_commitment: [u8; 32],
    /// The policy version this payment was proposed under.
    #[serde(with = "decimal")]
    pub policy_version: u64,
    /// The recipient-specific allowlist version.
    #[serde(with = "decimal")]
    pub recipient_version: u64,
    /// Last unix second this payment may execute.
    #[serde(with = "decimal")]
    pub valid_until: u64,
}

/// `ExceptionAuthorization` as the owner signs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExceptionAuthorization {
    /// EIP-712 struct hash of the exact payment.
    #[serde(with = "hex_fixed")]
    pub payment_hash: [u8; 32],
    /// Explicit approver address, or immutable owner.
    #[serde(with = "hex_fixed")]
    pub signer: [u8; 20],
    /// Current signer version (zero for owner).
    #[serde(with = "decimal")]
    pub signer_version: u64,
    /// One-time nonce scoped to the signer.
    #[serde(with = "decimal")]
    pub approval_nonce: u128,
    /// Last unix second this authorization may be used.
    #[serde(with = "decimal")]
    pub authorization_expiry: u64,
}

/// The file the owner page loads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingApproval {
    /// Always [`PENDING_SCHEMA`].
    pub schema: String,
    /// Chain ID, as a decimal string.
    #[serde(with = "decimal")]
    pub chain_id: u64,
    /// The vault that must verify the signature.
    #[serde(with = "hex_fixed")]
    pub vault: [u8; 20],
    /// The exact payment.
    pub payment: Payment,
    /// The struct the owner signs.
    pub authorization: ExceptionAuthorization,
    /// The agent's invoice reference. Display it as unverified agent text.
    pub invoice_reference: String,
    /// The rule this payment exceeds.
    pub exceeded_rule: String,
    /// The limit in force when this was requested.
    #[serde(with = "decimal")]
    pub per_payment_limit: u128,
}

/// The file the approver page produces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApproverSignature {
    /// Always [`SIGNATURE_SCHEMA`].
    pub schema: String,
    /// The payment this signature approves.
    #[serde(with = "hex_fixed")]
    pub payment_id: [u8; 32],
    /// The digest that was signed.
    #[serde(with = "hex_fixed")]
    pub approval_digest: [u8; 32],
    /// Signer named by the authorization.
    #[serde(with = "hex_fixed")]
    pub signer: [u8; 20],
    /// Signer version named by the authorization.
    #[serde(with = "decimal")]
    pub signer_version: u64,
    /// EOA or arbitrary-length ERC-1271 signature bytes.
    #[serde(with = "hex_bytes")]
    pub signature: Vec<u8>,
}

/// Schema tag of [`PendingApproval`].
pub const PENDING_SCHEMA: &str = "vault-pending-approval/2";
/// Schema tag of [`ApproverSignature`].
pub const SIGNATURE_SCHEMA: &str = "vault-approver-signature/2";

/// Serde for arbitrary signature bytes, capped by file-size checks at the service boundary.
pub mod hex_bytes {
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("0x{}", hex::encode(value)))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let value = String::deserialize(deserializer)?;
        let digits = value
            .strip_prefix("0x")
            .ok_or_else(|| D::Error::custom("expected 0x hex"))?;
        hex::decode(digits).map_err(|_| D::Error::custom("invalid signature hex"))
    }
}
