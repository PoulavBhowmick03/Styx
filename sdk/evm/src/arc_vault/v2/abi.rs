//! Static payment/authorization tuples followed by arbitrary-length signature bytes.
pub use super::super::abi::{
    encode_allowed_recipient, encode_consumed_payment, encode_getter, encode_payment_hash_by_id,
    encode_spent_by_day,
};
use super::types::{ExceptionAuthorization, Payment};
use crate::abi::selector;

pub fn uint(value: u128) -> [u8; 32] {
    let mut word = [0; 32];
    word[16..].copy_from_slice(&value.to_be_bytes());
    word
}
pub fn address(value: &[u8; 20]) -> [u8; 32] {
    let mut word = [0; 32];
    word[12..].copy_from_slice(value);
    word
}
pub fn call(signature: &str, words: &[[u8; 32]]) -> Vec<u8> {
    let mut out = selector(signature).to_vec();
    for word in words {
        out.extend_from_slice(word);
    }
    out
}
pub fn payment_words(p: &Payment) -> [[u8; 32]; 9] {
    [
        p.payment_id,
        address(&p.agent),
        address(&p.token),
        address(&p.recipient),
        uint(p.amount),
        p.evidence_commitment,
        uint(p.policy_version.into()),
        uint(p.recipient_version.into()),
        uint(p.valid_until.into()),
    ]
}
const P: &str = "(bytes32,address,address,address,uint256,bytes32,uint256,uint256,uint64)";
const A: &str = "(bytes32,address,uint256,uint256,uint64)";
pub fn encode_pay(p: &Payment) -> Vec<u8> {
    call(&format!("pay({P})"), &payment_words(p))
}
pub fn encode_pay_with_exception(
    p: &Payment,
    a: &ExceptionAuthorization,
    signature: &[u8],
) -> Vec<u8> {
    let mut words = payment_words(p).to_vec();
    words.extend([
        a.payment_hash,
        address(&a.signer),
        uint(a.signer_version.into()),
        uint(a.approval_nonce),
        uint(a.authorization_expiry.into()),
        uint(15 * 32),
    ]);
    let mut out = call(&format!("payWithException({P},{A},bytes)"), &words);
    out.extend(uint(signature.len() as u128));
    out.extend(signature);
    out.resize(4 + 16 * 32 + signature.len().div_ceil(32) * 32, 0);
    out
}
pub fn word_u128(word: &[u8]) -> Option<u128> {
    if word.len() != 32 || word[..16] != [0; 16] {
        return None;
    }
    Some(u128::from_be_bytes(word[16..].try_into().ok()?))
}
pub fn word_u64(word: &[u8]) -> Option<u64> {
    word_u128(word)?.try_into().ok()
}
pub fn word_address(word: &[u8]) -> Option<[u8; 20]> {
    if word.len() != 32 || word[..12] != [0; 12] {
        return None;
    }
    word[12..].try_into().ok()
}
