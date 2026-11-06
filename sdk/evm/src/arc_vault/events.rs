//! Decoding of `PaymentExecuted`, the event that records the policy the vault enforced.

use serde_json::Value;
use sha3::{Digest, Keccak256};

use super::types::parse_hex;

const SIGNATURE: &str =
    "PaymentExecuted(bytes32,address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,bool,bytes32)";
const DATA_WORDS: usize = 10;

/// Topic zero of `PaymentExecuted`.
#[must_use]
pub fn payment_executed_topic() -> [u8; 32] {
    Keccak256::digest(SIGNATURE.as_bytes()).into()
}

/// One decoded `PaymentExecuted` log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentExecuted {
    /// Indexed payment ID.
    pub payment_id: [u8; 32],
    /// Indexed recipient.
    pub recipient: [u8; 20],
    /// Amount paid.
    pub amount: u128,
    /// Struct hash of the payment.
    pub payment_hash: [u8; 32],
    /// Commitment to the invoice.
    pub evidence_commitment: [u8; 32],
    /// Policy version enforced.
    pub policy_version: u64,
    /// Per-payment limit enforced.
    pub per_payment_limit: u128,
    /// Daily limit enforced.
    pub daily_limit: u128,
    /// UTC day number.
    pub day: u64,
    /// That day's spend after this payment.
    pub day_spent_after: u128,
    /// Whether the exception path ran.
    pub exception: bool,
    /// Owner-approved digest; zero for ordinary payments.
    pub approval_digest: [u8; 32],
}

fn word_u128(word: &[u8]) -> Option<u128> {
    if word[..16] != [0; 16] {
        return None;
    }
    Some(u128::from_be_bytes(word[16..32].try_into().ok()?))
}

fn word_u64(word: &[u8]) -> Option<u64> {
    u64::try_from(word_u128(word)?).ok()
}

/// Decodes one log, returning `None` if it is any other event or is malformed.
#[must_use]
pub fn decode_payment_executed(topics: &[[u8; 32]], data: &[u8]) -> Option<PaymentExecuted> {
    if topics.len() != 3 || topics[0] != payment_executed_topic() || data.len() != DATA_WORDS * 32 {
        return None;
    }
    if topics[2][..12] != [0; 12] {
        return None;
    }
    let word = |index: usize| &data[index * 32..(index + 1) * 32];
    let fixed = |index: usize| -> Option<[u8; 32]> { word(index).try_into().ok() };
    let exception = match word_u128(word(8))? {
        0 => false,
        1 => true,
        _ => return None,
    };
    Some(PaymentExecuted {
        payment_id: topics[1],
        recipient: topics[2][12..].try_into().ok()?,
        amount: word_u128(word(0))?,
        payment_hash: fixed(1)?,
        evidence_commitment: fixed(2)?,
        policy_version: word_u64(word(3))?,
        per_payment_limit: word_u128(word(4))?,
        daily_limit: word_u128(word(5))?,
        day: word_u64(word(6))?,
        day_spent_after: word_u128(word(7))?,
        exception,
        approval_digest: fixed(9)?,
    })
}

/// A vault log located inside a transaction receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocatedPayment {
    /// The decoded event.
    pub event: PaymentExecuted,
    /// The log's index in its block.
    pub log_index: u64,
}

fn parse_quantity(value: &Value) -> Option<u64> {
    u64::from_str_radix(value.as_str()?.strip_prefix("0x")?, 16).ok()
}

/// Finds the vault's `PaymentExecuted` for one payment ID in a receipt's JSON.
/// Logs from any other address are ignored, so a token cannot forge the event.
#[must_use]
pub fn find_in_receipt(
    receipt: &Value,
    vault: &[u8; 20],
    payment_id: &[u8; 32],
) -> Option<LocatedPayment> {
    for log in receipt["logs"].as_array()? {
        let Some(address) = log["address"]
            .as_str()
            .and_then(|text| parse_hex::<20>(&text.to_ascii_lowercase()).ok())
        else {
            continue;
        };
        if &address != vault {
            continue;
        }
        let Some(topics) = log["topics"].as_array().and_then(|topics| {
            topics
                .iter()
                .map(|topic| parse_hex::<32>(topic.as_str()?).ok())
                .collect::<Option<Vec<_>>>()
        }) else {
            continue;
        };
        let Some(data) = log["data"]
            .as_str()
            .and_then(|text| text.strip_prefix("0x"))
            .and_then(|digits| hex::decode(digits).ok())
        else {
            continue;
        };
        let Some(event) = decode_payment_executed(&topics, &data) else {
            continue;
        };
        if &event.payment_id == payment_id {
            return Some(LocatedPayment {
                event,
                log_index: parse_quantity(&log["logIndex"])?,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> (Vec<[u8; 32]>, Vec<u8>) {
        let mut recipient = [0u8; 32];
        recipient[31] = 0xa1;
        let mut data = Vec::new();
        for value in [6u8, 0, 0, 3, 1, 10, 200, 7, 1, 0] {
            let mut word = [0u8; 32];
            word[31] = value;
            data.extend_from_slice(&word);
        }
        (vec![payment_executed_topic(), [9; 32], recipient], data)
    }

    #[test]
    fn decodes_fields_in_order() {
        let (topics, data) = sample();
        let event = decode_payment_executed(&topics, &data).unwrap();
        assert_eq!(event.amount, 6);
        assert_eq!(event.policy_version, 3);
        assert_eq!(event.per_payment_limit, 1);
        assert_eq!(event.daily_limit, 10);
        assert_eq!(event.day, 200);
        assert_eq!(event.day_spent_after, 7);
        assert!(event.exception);
        assert_eq!(event.recipient[19], 0xa1);
    }

    #[test]
    fn rejects_other_events_and_bad_shapes() {
        let (mut topics, mut data) = sample();
        data.pop();
        assert!(decode_payment_executed(&topics, &data).is_none());
        data.push(0);
        topics[0] = [0; 32];
        assert!(decode_payment_executed(&topics, &data).is_none());
    }

    #[test]
    fn a_log_from_another_address_is_ignored() {
        let (topics, data) = sample();
        let receipt = serde_json::json!({"logs": [{
            "address": format!("0x{}", "22".repeat(20)),
            "topics": topics.iter().map(|t| format!("0x{}", hex::encode(t))).collect::<Vec<_>>(),
            "data": format!("0x{}", hex::encode(&data)),
            "logIndex": "0x4",
        }]});
        assert!(find_in_receipt(&receipt, &[0x11; 20], &[9; 32]).is_none());
        let found = find_in_receipt(&receipt, &[0x22; 20], &[9; 32]).unwrap();
        assert_eq!(found.log_index, 4);
    }
}
