//! Independent v2 evidence verification. Contract signatures are proven by pinned execution,
//! never by a present-day ERC-1271 call that can change its answer after settlement.
use super::super::{
    record::{EvidenceOpening, SettlementPointer},
    rpc::{receipt_block, receipt_succeeded, receipt_tx_hash, VaultRpc},
    verify::{Check, VerificationReport},
};
use super::{
    abi, digest,
    events::{find_in_receipt, PaymentExecuted},
    types::*,
};
use serde::{Deserialize, Serialize};

pub const RECORD_SCHEMA: &str = "vault-payment-record/2";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentRecord {
    pub schema: String,
    #[serde(with = "decimal")]
    pub chain_id: u64,
    #[serde(with = "hex_fixed")]
    pub vault: [u8; 20],
    #[serde(with = "hex_fixed")]
    pub vault_code_hash: [u8; 32],
    pub payment: Payment,
    pub policy: PaymentExecuted,
    pub authorization: Option<ExceptionAuthorization>,
    pub signature: Option<ApproverSignature>,
    pub evidence: EvidenceOpening,
    pub settlement: SettlementPointer,
}
pub fn matches_payment(event: &PaymentExecuted, p: &Payment) -> bool {
    event.payment_id == p.payment_id
        && event.agent == p.agent
        && event.recipient == p.recipient
        && event.amount == p.amount
        && event.payment_hash == digest::payment_hash(p)
        && event.evidence_commitment == p.evidence_commitment
        && event.policy_version == p.policy_version
        && event.recipient_version == p.recipient_version
}
pub async fn verify_record(
    record: &PaymentRecord,
    rpc: &VaultRpc,
    pin: &[u8; 32],
) -> VerificationReport {
    let mut report = VerificationReport {
        record_integrity: Check::Failed,
        authorization: if record.policy.exception {
            Check::Unavailable
        } else {
            Check::NotApplicable
        },
        settlement: Check::Unavailable,
        policy_at_execution: Check::Unavailable,
        reasons: Vec::new(),
    };
    let invoice = record
        .evidence
        .invoice_hex
        .strip_prefix("0x")
        .and_then(|s| hex::decode(s).ok());
    if record.schema != RECORD_SCHEMA
        || !invoice.is_some_and(|bytes| {
            digest::evidence_commitment(&record.evidence.salt, &bytes)
                == record.payment.evidence_commitment
        })
        || !matches_payment(&record.policy, &record.payment)
    {
        report
            .reasons
            .push("record opening or payment fields do not match".into());
        return report;
    }
    report.record_integrity = Check::Verified;
    if record.chain_id != rpc.chain_id() {
        report.settlement = Check::Failed;
        report.policy_at_execution = Check::Failed;
        report
            .reasons
            .push("record chain differs from reviewer chain".into());
        return report;
    }
    let code = match rpc.code_hash(&record.vault).await {
        Ok(code) => code,
        Err(_) => return report,
    };
    if code != *pin || code != record.vault_code_hash {
        report.policy_at_execution = Check::Failed;
        report
            .reasons
            .push("vault code differs from the independent pin".into());
        return report;
    }
    let receipt = match rpc.receipt(&record.settlement.tx_hash).await {
        Ok(Some(r)) => r,
        _ => return report,
    };
    if receipt_succeeded(&receipt).is_none() || receipt_block(&receipt).is_none() {
        return report;
    }
    if receipt_succeeded(&receipt) != Some(true)
        || receipt_block(&receipt) != Some(record.settlement.block_number)
        || receipt_tx_hash(&receipt) != Some(record.settlement.tx_hash)
    {
        report.settlement = Check::Failed;
        return report;
    }
    let canonical = match rpc
        .canonical_block_hash(record.settlement.block_number)
        .await
    {
        Ok(hash) => hash,
        Err(_) => return report,
    };
    if receipt["blockHash"]
        .as_str()
        .and_then(|s| parse_hex::<32>(s).ok())
        != Some(canonical)
    {
        return report;
    }
    let Some(found) = find_in_receipt(&receipt, &record.vault, &record.payment.payment_id) else {
        report.settlement = Check::Failed;
        return report;
    };
    if found.event != record.policy || found.log_index != record.settlement.log_index {
        report.settlement = Check::Failed;
        return report;
    }
    let expected_input = if found.event.exception {
        let (Some(a), Some(sig)) = (&record.authorization, &record.signature) else {
            report.authorization = Check::Failed;
            return report;
        };
        let expected = digest::approval_digest(record.chain_id, &record.vault, a);
        if a.payment_hash != digest::payment_hash(&record.payment)
            || expected != found.event.approval_digest
            || found.event.signer != a.signer
            || found.event.signer_version != a.signer_version
            || sig.schema != SIGNATURE_SCHEMA
            || sig.payment_id != record.payment.payment_id
            || sig.approval_digest != expected
            || sig.signer != a.signer
            || sig.signer_version != a.signer_version
        {
            report.authorization = Check::Failed;
            return report;
        }
        abi::encode_pay_with_exception(&record.payment, a, &sig.signature)
    } else {
        if found.event.signer != [0; 20]
            || found.event.signer_version != 0
            || found.event.approval_digest != [0; 32]
            || record.authorization.is_some()
            || record.signature.is_some()
        {
            report.settlement = Check::Failed;
            return report;
        }
        abi::encode_pay(&record.payment)
    };
    let transaction = match rpc.transaction(&record.settlement.tx_hash).await {
        Ok(Some(tx)) => tx,
        _ => return report,
    };
    let actual = transaction["input"]
        .as_str()
        .and_then(|s| s.strip_prefix("0x"))
        .and_then(|s| hex::decode(s).ok());
    if actual.as_ref() != Some(&expected_input)
        || transaction["hash"]
            .as_str()
            .and_then(|s| parse_hex::<32>(s).ok())
            != Some(record.settlement.tx_hash)
        || transaction["to"]
            .as_str()
            .and_then(|s| parse_hex::<20>(s).ok())
            != Some(record.vault)
        || transaction["from"]
            .as_str()
            .and_then(|s| parse_hex::<20>(s).ok())
            != Some(record.payment.agent)
        || transaction["blockHash"]
            .as_str()
            .and_then(|s| parse_hex::<32>(s).ok())
            != Some(canonical)
    {
        report.settlement = Check::Failed;
        report
            .reasons
            .push("transaction does not match the exact retained payment and signature".into());
        return report;
    }
    if rpc
        .canonical_block_hash(record.settlement.block_number)
        .await
        .ok()
        != Some(canonical)
    {
        return report;
    }
    report.settlement = Check::Verified;
    report.policy_at_execution = Check::Verified;
    if found.event.exception {
        report.authorization = Check::Verified;
    }
    report
        .reasons
        .push("verified at the observed canonical block; no finality guarantee".into());
    report
}
