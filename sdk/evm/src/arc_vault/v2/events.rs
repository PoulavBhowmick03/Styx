//! Organization event decoding. A different topic and shape keep v1 evidence separate.
use super::{
    abi,
    types::{decimal, hex_fixed, parse_hex},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha3::{Digest, Keccak256};

pub const EVENT_TYPE: &str = "PaymentExecuted(bytes32,address,address,uint256,bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool,address,uint256,bytes32)";
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PaymentExecuted {
    #[serde(with = "hex_fixed")]
    pub payment_id: [u8; 32],
    #[serde(with = "hex_fixed")]
    pub agent: [u8; 20],
    #[serde(with = "hex_fixed")]
    pub recipient: [u8; 20],
    #[serde(with = "decimal")]
    pub amount: u128,
    #[serde(with = "hex_fixed")]
    pub payment_hash: [u8; 32],
    #[serde(with = "hex_fixed")]
    pub evidence_commitment: [u8; 32],
    #[serde(with = "decimal")]
    pub policy_version: u64,
    #[serde(with = "decimal")]
    pub recipient_version: u64,
    #[serde(with = "decimal")]
    pub per_payment_limit: u128,
    #[serde(with = "decimal")]
    pub daily_limit: u128,
    #[serde(with = "decimal")]
    pub vault_daily_limit: u128,
    #[serde(with = "decimal")]
    pub day: u64,
    #[serde(with = "decimal")]
    pub agent_day_spent_after: u128,
    #[serde(with = "decimal")]
    pub vault_day_spent_after: u128,
    pub exception: bool,
    #[serde(with = "hex_fixed")]
    pub signer: [u8; 20],
    #[serde(with = "decimal")]
    pub signer_version: u64,
    #[serde(with = "hex_fixed")]
    pub approval_digest: [u8; 32],
}
#[derive(Debug, Clone)]
pub struct LocatedPayment {
    pub event: PaymentExecuted,
    pub log_index: u64,
}
pub fn topic() -> [u8; 32] {
    Keccak256::digest(EVENT_TYPE.as_bytes()).into()
}
pub fn find_in_receipt(receipt: &Value, vault: &[u8; 20], id: &[u8; 32]) -> Option<LocatedPayment> {
    for log in receipt["logs"].as_array()? {
        if log["address"]
            .as_str()
            .and_then(|s| parse_hex::<20>(s).ok())
            .as_ref()
            != Some(vault)
        {
            continue;
        }
        let topics: Vec<[u8; 32]> = log["topics"]
            .as_array()?
            .iter()
            .map(|x| parse_hex(x.as_str()?).ok())
            .collect::<Option<_>>()?;
        if topics.len() != 4 || topics[0] != topic() || &topics[1] != id {
            continue;
        }
        let data = hex::decode(log["data"].as_str()?.strip_prefix("0x")?).ok()?;
        if data.len() != 15 * 32 {
            return None;
        }
        let w = |i: usize| &data[i * 32..(i + 1) * 32];
        let fixed = |i: usize| <[u8; 32]>::try_from(w(i)).ok();
        let exception = match abi::word_u128(w(11))? {
            0 => false,
            1 => true,
            _ => return None,
        };
        let event = PaymentExecuted {
            payment_id: topics[1],
            agent: abi::word_address(&topics[2])?,
            recipient: abi::word_address(&topics[3])?,
            amount: abi::word_u128(w(0))?,
            payment_hash: fixed(1)?,
            evidence_commitment: fixed(2)?,
            policy_version: abi::word_u64(w(3))?,
            recipient_version: abi::word_u64(w(4))?,
            per_payment_limit: abi::word_u128(w(5))?,
            daily_limit: abi::word_u128(w(6))?,
            vault_daily_limit: abi::word_u128(w(7))?,
            day: abi::word_u64(w(8))?,
            agent_day_spent_after: abi::word_u128(w(9))?,
            vault_day_spent_after: abi::word_u128(w(10))?,
            exception,
            signer: abi::word_address(w(12))?,
            signer_version: abi::word_u64(w(13))?,
            approval_digest: fixed(14)?,
        };
        let log_index =
            u64::from_str_radix(log["logIndex"].as_str()?.strip_prefix("0x")?, 16).ok()?;
        return Some(LocatedPayment { event, log_index });
    }
    None
}
