//! Keccak256 and secp256k1 ECDSA signatures.
//!
//! Keys are 20-byte Ethereum-style addresses. Signatures are 65 bytes `r || s || v`, with low-`s` enforced.

use core::fmt;

use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, VerifyingKey};
use sha3::{Digest, Keccak256};

/// Suite id for keccak256 with secp256k1 ECDSA signatures.
pub const EVM_SECP256K1_KECCAK_SUITE_ID: u16 = 1;

/// Length of a suite-1 authorization key.
pub const EVM_SECP256K1_KECCAK_KEY_BYTES: usize = 20;
/// Length of a suite-1 authorization signature.
pub const EVM_SECP256K1_KECCAK_SIGNATURE_BYTES: usize = 65;

/// A suite could not be selected or could not verify an authorization.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum SuiteError {
    /// The suite id names no implemented suite.
    #[error("agreement suite {0} is not supported")]
    Unsupported(u16),
    /// The authorization key had the wrong length for the suite.
    #[error("authorization key must be {expected} bytes, found {actual}")]
    KeyLength {
        /// Expected length.
        expected: usize,
        /// Actual length.
        actual: usize,
    },
    /// The signature had the wrong length for the suite.
    #[error("authorization signature must be {expected} bytes, found {actual}")]
    SignatureLength {
        /// Expected length.
        expected: usize,
        /// Actual length.
        actual: usize,
    },
    /// The signature bytes did not parse.
    #[error("authorization signature is not valid")]
    InvalidSignature,
    /// The signature used a high-`s` encoding.
    #[error("authorization signature does not use the canonical low-`s` form")]
    NonCanonicalSignature,
    /// The signature was valid but recovered a different address.
    #[error("authorization signature was not produced by the agreement key")]
    SignerMismatch,
}

/// Authorization behavior selected by an agreement.
///
/// Commitments and authorization messages use their suite-specific field mappings.
/// They cannot be expressed as one interchangeable byte-hash function.
pub trait Suite: fmt::Debug + Send + Sync {
    /// The suite id bound into the agreement.
    fn id(&self) -> u16;

    /// The authorization key length the suite accepts.
    fn authorization_key_length(&self) -> usize;

    /// Verifies one authorization signature over `digest` against `key`.
    fn verify_authorization(
        &self,
        key: &[u8],
        digest: &[u8; 32],
        signature: &[u8],
    ) -> Result<(), SuiteError>;
}

/// Keccak256 and secp256k1, as described in the module documentation.
#[derive(Debug)]
pub struct EvmSecp256k1Keccak;

static EVM_SECP256K1_KECCAK: EvmSecp256k1Keccak = EvmSecp256k1Keccak;

impl Suite for EvmSecp256k1Keccak {
    fn id(&self) -> u16 {
        EVM_SECP256K1_KECCAK_SUITE_ID
    }

    fn authorization_key_length(&self) -> usize {
        EVM_SECP256K1_KECCAK_KEY_BYTES
    }

    fn verify_authorization(
        &self,
        key: &[u8],
        digest: &[u8; 32],
        signature: &[u8],
    ) -> Result<(), SuiteError> {
        if key.len() != EVM_SECP256K1_KECCAK_KEY_BYTES {
            return Err(SuiteError::KeyLength {
                expected: EVM_SECP256K1_KECCAK_KEY_BYTES,
                actual: key.len(),
            });
        }
        if signature.len() != EVM_SECP256K1_KECCAK_SIGNATURE_BYTES {
            return Err(SuiteError::SignatureLength {
                expected: EVM_SECP256K1_KECCAK_SIGNATURE_BYTES,
                actual: signature.len(),
            });
        }
        let (scalars, recovery) = signature.split_at(64);
        let recovery = recovery[0];
        if recovery > 1 {
            return Err(SuiteError::InvalidSignature);
        }
        let signature =
            EcdsaSignature::from_slice(scalars).map_err(|_| SuiteError::InvalidSignature)?;
        if signature.normalize_s().is_some() {
            return Err(SuiteError::NonCanonicalSignature);
        }
        let recovery_id = RecoveryId::from_byte(recovery).ok_or(SuiteError::InvalidSignature)?;
        let verifying_key =
            VerifyingKey::recover_from_prehash(&digest[..], &signature, recovery_id)
                .map_err(|_| SuiteError::InvalidSignature)?;
        let point = verifying_key.to_encoded_point(false);
        let point_bytes = point.as_bytes();
        let digest = Keccak256::digest(&point_bytes[1..]);
        if &digest[12..] != key {
            return Err(SuiteError::SignerMismatch);
        }
        Ok(())
    }
}

/// Keccak256 over ordered byte slices, with no added separators.
/// Callers supply their own domain tag and canonical encoding.
pub fn keccak256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Resolves a suite id to its implementation.
pub fn suite(id: u16) -> Result<&'static dyn Suite, SuiteError> {
    match id {
        EVM_SECP256K1_KECCAK_SUITE_ID => Ok(&EVM_SECP256K1_KECCAK),
        _ => Err(SuiteError::Unsupported(id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keccak_matches_published_vectors() {
        assert_eq!(
            hex::encode(keccak256(&[b""])),
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        );
        assert_eq!(
            hex::encode(keccak256(&[b"abc"])),
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        );
    }

    #[test]
    fn hashing_parts_is_concatenation() {
        assert_eq!(keccak256(&[b"ab", b"c"]), keccak256(&[b"a", b"bc"]));
    }

    /// EIP-155's worked example, an external signature vector outside this codebase.
    ///
    /// The signing hash and signature are from the EIP text; the address is the example's
    /// sender. Recovery here exercises the same keccak + secp256k1 path an EVM contract
    /// would use.
    #[test]
    fn recovers_the_eip155_signing_address() {
        let suite = suite(EVM_SECP256K1_KECCAK_SUITE_ID).expect("suite 1 exists");
        let digest: [u8; 32] =
            hex::decode("daf5a779ae972f972197303d7b574746c7ef83eadac0f2791ad23db92e4c8e53")
                .expect("hex")
                .try_into()
                .expect("32 bytes");
        let mut signature = hex::decode(concat!(
            "28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276",
            "67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83",
        ))
        .expect("hex");
        signature.push(0);
        let address = hex::decode("9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f").expect("hex");
        suite
            .verify_authorization(&address, &digest, &signature)
            .expect("the EIP-155 signature must recover the example address");
    }

    #[test]
    fn wrong_key_length_is_rejected() {
        let suite = suite(EVM_SECP256K1_KECCAK_SUITE_ID).expect("suite 1 exists");
        let error = suite
            .verify_authorization(&[0u8; 19], &[0u8; 32], &[0u8; 65])
            .expect_err("short key");
        assert_eq!(
            error,
            SuiteError::KeyLength {
                expected: 20,
                actual: 19
            }
        );
    }

    #[test]
    fn wrong_signature_length_is_rejected() {
        let suite = suite(EVM_SECP256K1_KECCAK_SUITE_ID).expect("suite 1 exists");
        let error = suite
            .verify_authorization(&[0u8; 20], &[0u8; 32], &[0u8; 64])
            .expect_err("short signature");
        assert_eq!(
            error,
            SuiteError::SignatureLength {
                expected: 65,
                actual: 64
            }
        );
    }

    #[test]
    fn unknown_suites_fail_explicitly() {
        assert!(matches!(suite(3), Err(SuiteError::Unsupported(3))));
    }
}
