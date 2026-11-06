//! Function selectors.

use sha3::{Digest, Keccak256};

/// The first four bytes of the keccak256 of a function signature.
#[must_use]
pub fn selector(signature: &str) -> [u8; 4] {
    let digest: [u8; 32] = Keccak256::digest(signature.as_bytes()).into();
    [digest[0], digest[1], digest[2], digest[3]]
}

/// Encodes the `balanceOf(address)` calldata for an `eth_call`.
#[must_use]
pub fn encode_balance_of_call(account: &[u8; 20]) -> Vec<u8> {
    let mut out = selector("balanceOf(address)").to_vec();
    out.extend_from_slice(&[0; 12]);
    out.extend_from_slice(account);
    out
}
