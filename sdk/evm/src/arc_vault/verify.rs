//! Independent verification of a payment record against the chain.
//!
//! The four results are separate, because each can hold or fail on its own. An unreadable chain
//! reads "unavailable", never "unpaid".

use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde::Serialize;
use sha3::{Digest, Keccak256};

use super::digest::{approval_digest, evidence_commitment, payment_hash};
use super::events::find_in_receipt;
use super::record::{VaultPaymentRecord, RECORD_SCHEMA};
use super::rpc::{receipt_block, receipt_succeeded, VaultRpc};
use super::types::ExceptionAuthorization;

/// The outcome of one verification check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Check {
    /// The check passed.
    Verified,
    /// The check ran and failed.
    Failed,
    /// The chain could not be read, so nothing is claimed either way.
    Unavailable,
    /// The check does not apply to this record.
    NotApplicable,
}

/// The four separately reported results.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VerificationReport {
    /// The commitment and payment hash recompute from the record.
    pub record_integrity: Check,
    /// The owner's signature recovers to the vault's owner (exceptions only).
    pub authorization: Check,
    /// The receipt succeeded and its log matches the record.
    pub settlement: Check,
    /// The vault's code hash is pinned and its event reports this policy.
    pub policy_at_execution: Check,
    /// Why anything other than `verified` was reported, without private content.
    pub reasons: Vec<String>,
}

/// The vault code hash and owner the reviewer pinned independently of the record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewerPins {
    /// Expected keccak256 of the vault's runtime code.
    pub vault_code_hash: [u8; 32],
}

/// Recovers an address from a 65-byte signature, accepting `v` of 0, 1, 27 or 28.
/// High-s signatures are refused, as the vault refuses them.
#[must_use]
pub fn recover_signer(digest: &[u8; 32], signature: &[u8; 65]) -> Option<[u8; 20]> {
    let v = signature[64];
    let id = RecoveryId::from_byte(if v >= 27 { v.checked_sub(27)? } else { v })?;
    let parsed = Signature::from_slice(&signature[..64]).ok()?;
    if parsed.normalize_s().is_some() {
        return None;
    }
    let key = VerifyingKey::recover_from_prehash(digest, &parsed, id).ok()?;
    let point = key.to_encoded_point(false);
    let hash: [u8; 32] = Keccak256::digest(&point.as_bytes()[1..]).into();
    hash[12..].try_into().ok()
}

/// Checks everything that needs no network. `reasons` collects each failure.
fn check_integrity(record: &VaultPaymentRecord, reasons: &mut Vec<String>) -> Check {
    let invoice = record
        .evidence
        .invoice_hex
        .strip_prefix("0x")
        .and_then(|digits| hex::decode(digits).ok());
    let commitment_matches = invoice.is_some_and(|invoice| {
        evidence_commitment(&record.evidence.salt, &invoice) == record.payment.evidence_commitment
    });
    if record.schema != RECORD_SCHEMA {
        reasons.push("record schema is not supported".to_owned());
        return Check::Failed;
    }
    if !commitment_matches {
        reasons.push("evidence opening does not match the commitment".to_owned());
        return Check::Failed;
    }
    Check::Verified
}

fn check_authorization(
    record: &VaultPaymentRecord,
    owner: Option<[u8; 20]>,
    reasons: &mut Vec<String>,
) -> Check {
    let Some(exception) = &record.exception else {
        return Check::NotApplicable;
    };
    let digest = approval_digest(
        record.chain_id,
        &record.vault,
        &ExceptionAuthorization {
            payment_hash: payment_hash(&record.payment),
            approval_nonce: exception.approval_nonce,
            authorization_expiry: exception.authorization_expiry,
        },
    );
    if digest != exception.approval_digest {
        reasons.push("approval digest does not match the payment".to_owned());
        return Check::Failed;
    }
    let Some(owner) = owner else {
        reasons.push("the vault owner could not be read".to_owned());
        return Check::Unavailable;
    };
    if recover_signer(&digest, &exception.owner_signature) != Some(owner) {
        reasons.push("signature does not recover to the vault owner".to_owned());
        return Check::Failed;
    }
    Check::Verified
}

/// Verifies one record using only the reviewer's RPC and pins.
pub async fn verify_record(
    record: &VaultPaymentRecord,
    rpc: &VaultRpc,
    pins: &ReviewerPins,
) -> VerificationReport {
    let mut reasons = Vec::new();
    let record_integrity = check_integrity(record, &mut reasons);

    if record.chain_id != rpc.chain_id() {
        reasons.push("the record chain differs from the reviewer's configured chain".to_owned());
        return VerificationReport {
            record_integrity,
            authorization: if record.exception.is_some() {
                Check::Failed
            } else {
                Check::NotApplicable
            },
            settlement: Check::Failed,
            policy_at_execution: Check::Failed,
            reasons,
        };
    }

    let owner = rpc
        .view_address(&record.vault, &super::abi::encode_getter("owner"))
        .await
        .ok();
    let authorization = check_authorization(record, owner, &mut reasons);

    let (settlement, policy_at_execution) = check_chain(record, rpc, pins, &mut reasons).await;
    VerificationReport {
        record_integrity,
        authorization,
        settlement,
        policy_at_execution,
        reasons,
    }
}

async fn check_chain(
    record: &VaultPaymentRecord,
    rpc: &VaultRpc,
    pins: &ReviewerPins,
    reasons: &mut Vec<String>,
) -> (Check, Check) {
    if rpc.check_chain().await.is_err() {
        reasons.push("the RPC is unavailable or serves another chain".to_owned());
        return (Check::Unavailable, Check::Unavailable);
    }
    let code_check = match rpc.code_hash(&record.vault).await {
        Ok(hash) if hash == pins.vault_code_hash && hash == record.vault_code_hash => {
            Check::Verified
        }
        Ok(_) => {
            reasons.push("the vault's code hash does not match the pinned hash".to_owned());
            Check::Failed
        }
        Err(_) => {
            reasons.push("the vault's code could not be read".to_owned());
            Check::Unavailable
        }
    };
    let receipt = match rpc.receipt(&record.settlement.tx_hash).await {
        Ok(Some(receipt)) => receipt,
        Ok(None) => {
            reasons.push("no receipt is visible for this transaction".to_owned());
            return (Check::Unavailable, Check::Unavailable);
        }
        Err(_) => {
            reasons.push("the receipt could not be read".to_owned());
            return (Check::Unavailable, Check::Unavailable);
        }
    };
    if receipt_succeeded(&receipt).is_none() || receipt_block(&receipt).is_none() {
        reasons.push("the receipt is incomplete or malformed".to_owned());
        return (Check::Unavailable, Check::Unavailable);
    }
    if receipt_succeeded(&receipt) != Some(true)
        || receipt_block(&receipt) != Some(record.settlement.block_number)
    {
        reasons.push("the receipt does not show this settlement".to_owned());
        return (Check::Failed, Check::Failed);
    }
    let Some(found) = find_in_receipt(&receipt, &record.vault, &record.payment.payment_id) else {
        reasons.push("the receipt has no matching vault event".to_owned());
        return (Check::Failed, Check::Failed);
    };
    let event = &found.event;
    let expected_digest = record
        .exception
        .as_ref()
        .map_or([0; 32], |exception| exception.approval_digest);
    let settlement_matches = found.log_index == record.settlement.log_index
        && event.recipient == record.payment.recipient
        && event.amount == record.payment.amount
        && event.payment_hash == payment_hash(&record.payment)
        && event.evidence_commitment == record.payment.evidence_commitment
        && event.exception == record.exception.is_some()
        && event.approval_digest == expected_digest;
    let settlement = if settlement_matches {
        Check::Verified
    } else {
        reasons.push("the vault event differs from the record".to_owned());
        Check::Failed
    };
    let policy_matches = event.policy_version == record.policy.policy_version
        && event.policy_version == record.payment.policy_version
        && event.per_payment_limit == record.policy.per_payment_limit
        && event.daily_limit == record.policy.daily_limit
        && event.day == record.policy.day
        && event.day_spent_after == record.policy.day_spent_after;
    let policy = match (code_check, policy_matches) {
        (Check::Verified, true) => Check::Verified,
        (Check::Unavailable, true) => Check::Unavailable,
        (_, false) => {
            reasons.push("the policy in the record differs from the vault event".to_owned());
            Check::Failed
        }
        _ => Check::Failed,
    };
    (settlement, policy)
}
