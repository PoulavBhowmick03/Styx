//! Errors from local transaction signing.

/// Signing a transaction failed.
#[derive(Debug, thiserror::Error)]
pub enum EvmError {
    /// The transaction signing key is not a valid secp256k1 scalar.
    #[error("invalid transaction signing key")]
    InvalidSigningKey,
    /// The fees are not usable.
    #[error("invalid fees: {0}")]
    InvalidFees(&'static str),
    /// Signed bytes do not match what the caller intended.
    #[error("signed transaction does not match the intended call")]
    SignedIntentMismatch,
    /// The transaction could not be built, signed or decoded.
    #[error("transaction encoding failed: {0}")]
    TransactionEncoding(String),
}
