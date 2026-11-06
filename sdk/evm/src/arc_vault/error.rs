//! Structured errors. The agent acts on the code, so a code never overstates what is known.

use core::fmt;

/// Stable error codes returned through the CLI and the MCP tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultCode {
    /// The vault's rules refuse this payment and an owner signature cannot lift the refusal.
    PolicyLimit,
    /// The payment needs a valid owner signature.
    OwnerApprovalRequired,
    /// The vault's policy changed after this payment was proposed.
    PolicyVersionChanged,
    /// The vault already consumed this payment ID.
    PaymentAlreadySettled,
    /// The chain could not be read. This never means unpaid.
    VerificationUnavailable,
    /// The request itself is malformed, or local state is missing or unreadable.
    InvalidRequest,
}

impl VaultCode {
    /// The code as it appears in JSON.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PolicyLimit => "POLICY_LIMIT",
            Self::OwnerApprovalRequired => "OWNER_APPROVAL_REQUIRED",
            Self::PolicyVersionChanged => "POLICY_VERSION_CHANGED",
            Self::PaymentAlreadySettled => "PAYMENT_ALREADY_SETTLED",
            Self::VerificationUnavailable => "VERIFICATION_UNAVAILABLE",
            Self::InvalidRequest => "INVALID_REQUEST",
        }
    }
}

/// A coded failure with a message that holds no key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultError {
    /// What the caller should act on.
    pub code: VaultCode,
    /// A human-readable explanation.
    pub message: String,
}

impl VaultError {
    /// Builds an error.
    pub fn new(code: VaultCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// A malformed request or unusable local state.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(VaultCode::InvalidRequest, message)
    }

    /// The chain could not be read.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(VaultCode::VerificationUnavailable, message)
    }
}

impl fmt::Display for VaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for VaultError {}
