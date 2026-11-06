//! Hand-encoded vault calls, in the style of [`crate::abi`]. `tests/vault_local_chain.rs` proves
//! these bytes are the ones the deployed contract accepts.

use super::types::{ExceptionAuthorization, Payment};
use crate::abi::selector;

const PAYMENT_TUPLE: &str = "(bytes32,address,address,address,uint256,bytes32,uint256,uint64)";
const AUTHORIZATION_TUPLE: &str = "(bytes32,uint256,uint64)";
/// The eight `Payment` words, three `ExceptionAuthorization` words and the signature offset word.
const SIGNATURE_OFFSET: u128 = 12 * 32;

fn push_address(out: &mut Vec<u8>, address: &[u8; 20]) {
    out.extend_from_slice(&[0; 12]);
    out.extend_from_slice(address);
}

fn push_uint(out: &mut Vec<u8>, value: u128) {
    out.extend_from_slice(&[0; 16]);
    out.extend_from_slice(&value.to_be_bytes());
}

fn push_payment(out: &mut Vec<u8>, payment: &Payment) {
    out.extend_from_slice(&payment.payment_id);
    push_address(out, &payment.agent);
    push_address(out, &payment.token);
    push_address(out, &payment.recipient);
    push_uint(out, payment.amount);
    out.extend_from_slice(&payment.evidence_commitment);
    push_uint(out, u128::from(payment.policy_version));
    push_uint(out, u128::from(payment.valid_until));
}

/// Encodes `pay(Payment)`.
#[must_use]
pub fn encode_pay(payment: &Payment) -> Vec<u8> {
    let mut out = selector(&format!("pay({PAYMENT_TUPLE})")).to_vec();
    push_payment(&mut out, payment);
    out
}

/// Encodes `payWithException(Payment,ExceptionAuthorization,bytes)`.
#[must_use]
pub fn encode_pay_with_exception(
    payment: &Payment,
    authorization: &ExceptionAuthorization,
    signature: &[u8; 65],
) -> Vec<u8> {
    let mut out = selector(&format!(
        "payWithException({PAYMENT_TUPLE},{AUTHORIZATION_TUPLE},bytes)"
    ))
    .to_vec();
    push_payment(&mut out, payment);
    out.extend_from_slice(&authorization.payment_hash);
    push_uint(&mut out, authorization.approval_nonce);
    push_uint(&mut out, u128::from(authorization.authorization_expiry));
    push_uint(&mut out, SIGNATURE_OFFSET);
    push_uint(&mut out, 65);
    out.extend_from_slice(signature);
    out.extend_from_slice(&[0; 31]);
    out
}

/// Encodes a no-argument getter.
#[must_use]
pub fn encode_getter(name: &str) -> Vec<u8> {
    selector(&format!("{name}()")).to_vec()
}

/// Encodes `allowedRecipient(address)`.
#[must_use]
pub fn encode_allowed_recipient(recipient: &[u8; 20]) -> Vec<u8> {
    let mut out = selector("allowedRecipient(address)").to_vec();
    push_address(&mut out, recipient);
    out
}

/// Encodes `spentByDay(uint256)`.
#[must_use]
pub fn encode_spent_by_day(day: u64) -> Vec<u8> {
    let mut out = selector("spentByDay(uint256)").to_vec();
    push_uint(&mut out, u128::from(day));
    out
}

/// Encodes `consumedPayment(bytes32)`.
#[must_use]
pub fn encode_consumed_payment(payment_id: &[u8; 32]) -> Vec<u8> {
    let mut out = selector("consumedPayment(bytes32)").to_vec();
    out.extend_from_slice(payment_id);
    out
}

/// Encodes `paymentHashById(bytes32)`.
#[must_use]
pub fn encode_payment_hash_by_id(payment_id: &[u8; 32]) -> Vec<u8> {
    let mut out = selector("paymentHashById(bytes32)").to_vec();
    out.extend_from_slice(payment_id);
    out
}

/// What a vault revert means to the agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevertMeaning {
    /// The vault's rules refuse this payment.
    Policy(&'static str),
    /// A valid owner approval is missing or unusable.
    Approval(&'static str),
    /// The policy version moved.
    PolicyVersion,
    /// This payment ID is already consumed.
    AlreadySettled,
    /// Any other revert.
    Other(&'static str),
}

const POLICY_ERRORS: &[&str] = &[
    "NotAgent",
    "VaultPaused",
    "PolicyExpired",
    "AgentMismatch",
    "TokenMismatch",
    "PaymentExpired",
    "ZeroAmount",
    "RecipientNotAllowed",
    "DailyLimitExceeded",
    "ZeroAddress",
];
const APPROVAL_ERRORS: &[&str] = &[
    "PerPaymentLimitExceeded",
    "PaymentHashMismatch",
    "BadSignature",
    "ApprovalNonceUsed",
    "AuthorizationExpired",
];
const OTHER_ERRORS: &[&str] = &["TransferFailed", "Reentrancy", "NotOwner"];

fn lookup(names: &'static [&'static str], data: &[u8]) -> Option<&'static str> {
    names
        .iter()
        .copied()
        .find(|name| data.starts_with(&selector(&format!("{name}()"))))
}

/// Maps revert data to its meaning. Unrecognized data is [`RevertMeaning::Other`].
#[must_use]
pub fn classify_revert(data: &[u8]) -> RevertMeaning {
    if data.starts_with(&selector("PolicyVersionMismatch()")) {
        return RevertMeaning::PolicyVersion;
    }
    if data.starts_with(&selector("PaymentAlreadyUsed()")) {
        return RevertMeaning::AlreadySettled;
    }
    if let Some(name) = lookup(POLICY_ERRORS, data) {
        return RevertMeaning::Policy(name);
    }
    if let Some(name) = lookup(APPROVAL_ERRORS, data) {
        return RevertMeaning::Approval(name);
    }
    RevertMeaning::Other(lookup(OTHER_ERRORS, data).unwrap_or("unrecognized revert"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payment() -> Payment {
        Payment {
            payment_id: [1; 32],
            agent: [2; 20],
            token: [3; 20],
            recipient: [4; 20],
            amount: 6_000_000,
            evidence_commitment: [5; 32],
            policy_version: 3,
            valid_until: 9,
        }
    }

    #[test]
    fn call_shapes_have_the_expected_lengths() {
        assert_eq!(encode_pay(&payment()).len(), 4 + 8 * 32);
        let authorization = ExceptionAuthorization {
            payment_hash: [6; 32],
            approval_nonce: 7,
            authorization_expiry: 8,
        };
        let call = encode_pay_with_exception(&payment(), &authorization, &[9; 65]);
        // Head of 12 words, the length word, and 65 bytes padded to 96.
        assert_eq!(call.len(), 4 + 12 * 32 + 32 + 96);
    }

    #[test]
    fn reverts_map_to_their_codes() {
        let data = |name: &str| selector(&format!("{name}()")).to_vec();
        assert_eq!(
            classify_revert(&data("DailyLimitExceeded")),
            RevertMeaning::Policy("DailyLimitExceeded")
        );
        assert_eq!(
            classify_revert(&data("BadSignature")),
            RevertMeaning::Approval("BadSignature")
        );
        assert_eq!(
            classify_revert(&data("PolicyVersionMismatch")),
            RevertMeaning::PolicyVersion
        );
        assert_eq!(
            classify_revert(&data("PaymentAlreadyUsed")),
            RevertMeaning::AlreadySettled
        );
        assert_eq!(
            classify_revert(&[0xde, 0xad, 0xbe, 0xef]),
            RevertMeaning::Other("unrecognized revert")
        );
    }
}
