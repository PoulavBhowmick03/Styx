//! EIP-712 digests that must equal the contract's. `tests/vault_vector.rs` pins them to a vector
//! generated independently with `cast`.

use sha3::{Digest, Keccak256};

use super::types::{ExceptionAuthorization, Payment};

/// The vault's `Payment` EIP-712 type string.
pub const PAYMENT_TYPE: &str = "Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint64 validUntil)";
/// The vault's `ExceptionAuthorization` EIP-712 type string.
pub const AUTHORIZATION_TYPE: &str =
    "ExceptionAuthorization(bytes32 paymentHash,uint256 approvalNonce,uint64 authorizationExpiry)";
const DOMAIN_TYPE: &str =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
const DOMAIN_NAME: &str = "ErebusPolicyVault";
const DOMAIN_VERSION: &str = "1";
const EVIDENCE_TAG: &[u8] = b"VAULT_EVIDENCE_V1";

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn word_address(address: &[u8; 20]) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(address);
    word
}

fn word_u128(value: u128) -> [u8; 32] {
    let mut word = [0u8; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}

/// The EIP-712 domain separator for one vault.
#[must_use]
pub fn domain_separator(chain_id: u64, vault: &[u8; 20]) -> [u8; 32] {
    keccak(&[
        &keccak(&[DOMAIN_TYPE.as_bytes()]),
        &keccak(&[DOMAIN_NAME.as_bytes()]),
        &keccak(&[DOMAIN_VERSION.as_bytes()]),
        &word_u128(u128::from(chain_id)),
        &word_address(vault),
    ])
}

/// The EIP-712 struct hash of a payment.
#[must_use]
pub fn payment_hash(payment: &Payment) -> [u8; 32] {
    keccak(&[
        &keccak(&[PAYMENT_TYPE.as_bytes()]),
        &payment.payment_id,
        &word_address(&payment.agent),
        &word_address(&payment.token),
        &word_address(&payment.recipient),
        &word_u128(payment.amount),
        &payment.evidence_commitment,
        &word_u128(u128::from(payment.policy_version)),
        &word_u128(u128::from(payment.valid_until)),
    ])
}

/// The full EIP-712 digest the owner signs.
#[must_use]
pub fn approval_digest(
    chain_id: u64,
    vault: &[u8; 20],
    authorization: &ExceptionAuthorization,
) -> [u8; 32] {
    let struct_hash = keccak(&[
        &keccak(&[AUTHORIZATION_TYPE.as_bytes()]),
        &authorization.payment_hash,
        &word_u128(authorization.approval_nonce),
        &word_u128(u128::from(authorization.authorization_expiry)),
    ]);
    keccak(&[
        &[0x19, 0x01],
        &domain_separator(chain_id, vault),
        &struct_hash,
    ])
}

/// `keccak256("VAULT_EVIDENCE_V1" || salt || invoice)`. The fixed-width salt comes before the
/// variable bytes, so the encoding is unambiguous.
#[must_use]
pub fn evidence_commitment(salt: &[u8; 32], invoice: &[u8]) -> [u8; 32] {
    keccak(&[EVIDENCE_TAG, salt, invoice])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evidence_commitment_binds_salt_and_invoice() {
        let base = evidence_commitment(&[1; 32], b"invoice");
        assert_ne!(base, evidence_commitment(&[2; 32], b"invoice"));
        assert_ne!(base, evidence_commitment(&[1; 32], b"invoicE"));
    }
}
