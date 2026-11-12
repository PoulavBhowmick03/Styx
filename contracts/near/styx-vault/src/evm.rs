//! EIP-1559 transactions for an ERC-20 `transfer`, built and hashed inside the vault, and the
//! signed raw transaction assembled from the MPC signer's secp256k1 signature.
//!
//! Only what the vault needs: one transaction type, one call. The encoding is checked against a
//! transaction produced by `cast` in the unit tests.

/// secp256k1 group order n, big-endian.
const SECP256K1_N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
    0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
];
/// n / 2, big-endian. EIP-2: a valid s is at most this.
const SECP256K1_HALF_N: [u8; 32] = [
    0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    0x5d, 0x57, 0x6e, 0x73, 0x57, 0xa4, 0x50, 0x1d, 0xdf, 0xe9, 0x2f, 0x46, 0x68, 0x1b, 0x20, 0xa0,
];

/// The fields of one EIP-1559 call to `token.transfer(recipient, amount)`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transfer {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub token: [u8; 20],
    pub recipient: [u8; 20],
    pub amount: u128,
}

impl Transfer {
    /// ABI calldata for `transfer(address,uint256)`.
    pub fn calldata(&self) -> Vec<u8> {
        let mut data = vec![0xa9, 0x05, 0x9c, 0xbb];
        data.extend_from_slice(&[0u8; 12]);
        data.extend_from_slice(&self.recipient);
        data.extend_from_slice(&[0u8; 16]);
        data.extend_from_slice(&self.amount.to_be_bytes());
        data
    }

    /// The RLP list items common to the unsigned and signed forms.
    fn fields(&self) -> Vec<Vec<u8>> {
        vec![
            rlp_uint(self.chain_id as u128),
            rlp_uint(self.nonce as u128),
            rlp_uint(self.max_priority_fee_per_gas),
            rlp_uint(self.max_fee_per_gas),
            rlp_uint(self.gas_limit as u128),
            rlp_bytes(&self.token),
            rlp_uint(0), // value
            rlp_bytes(&self.calldata()),
            rlp_list(&[]), // access list
        ]
    }

    /// `0x02 || rlp([...])`: the bytes whose keccak256 is signed.
    pub fn signing_payload(&self) -> Vec<u8> {
        let mut out = vec![0x02];
        out.extend(rlp_list(&self.fields()));
        out
    }

    /// The signed raw transaction, `0x02 || rlp([..., y_parity, r, s])`.
    pub fn signed(&self, y_parity: u8, r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
        let mut items = self.fields();
        items.push(rlp_uint(y_parity as u128));
        items.push(rlp_bytes(strip_zeros(r)));
        items.push(rlp_bytes(strip_zeros(s)));
        let mut out = vec![0x02];
        out.extend(rlp_list(&items));
        out
    }
}

/// Normalizes an MPC signature to EIP-2 low-s form. `big_r` is the compressed point R
/// (0x02/0x03 prefix and x); r is its x coordinate. Flipping s to n - s flips the recovery bit.
pub fn normalize(big_r: &[u8; 33], s: &[u8; 32], recovery_id: u8) -> Option<([u8; 32], [u8; 32], u8)> {
    if big_r[0] != 0x02 && big_r[0] != 0x03 || recovery_id > 1 {
        return None;
    }
    let mut r = [0u8; 32];
    r.copy_from_slice(&big_r[1..]);
    if r == [0u8; 32] || *s == [0u8; 32] || *s >= SECP256K1_N {
        return None;
    }
    if *s > SECP256K1_HALF_N {
        Some((r, sub_be(&SECP256K1_N, s), recovery_id ^ 1))
    } else {
        Some((r, *s, recovery_id))
    }
}

/// a - b for big-endian 256-bit values with a >= b.
fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut d = a[i] as i16 - b[i] as i16 - borrow;
        borrow = if d < 0 {
            d += 256;
            1
        } else {
            0
        };
        out[i] = d as u8;
    }
    out
}

fn strip_zeros(bytes: &[u8]) -> &[u8] {
    let first = bytes.iter().position(|b| *b != 0).unwrap_or(bytes.len());
    &bytes[first..]
}

fn rlp_uint(value: u128) -> Vec<u8> {
    rlp_bytes(strip_zeros(&value.to_be_bytes()))
}

fn rlp_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() == 1 && bytes[0] < 0x80 {
        return bytes.to_vec();
    }
    let mut out = rlp_length(bytes.len(), 0x80);
    out.extend_from_slice(bytes);
    out
}

fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = items.concat();
    let mut out = rlp_length(body.len(), 0xc0);
    out.extend(body);
    out
}

fn rlp_length(len: usize, offset: u8) -> Vec<u8> {
    if len < 56 {
        vec![offset + len as u8]
    } else {
        let len_bytes = strip_zeros(&(len as u64).to_be_bytes()).to_vec();
        let mut out = vec![offset + 55 + len_bytes.len() as u8];
        out.extend(len_bytes);
        out
    }
}

/// Parses `0x` + 40 hex digits.
pub fn parse_address(text: &str) -> Option<[u8; 20]> {
    let hex = text.strip_prefix("0x")?;
    if hex.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, chunk) in text.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Produced with `cast mktx` and Anvil's public test key #0: chain 5042002, nonce 7, gas
    /// limit 100000, max fee 50 gwei, priority 1 gwei, USDC at 0x3600…0000,
    /// `transfer(0x1111…1111, 25000000)`.
    const CAST_RAW: &str = "02f8b4834cef5207843b9aca00850ba43b7400830186a094360000000000000000000000000000000000000080b844a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000017d7840c001a042d7a1c499eaebc1494892fb18c72aee7cf233c6d1c32c111c25788bceb9e639a01d2b25167e724c8c880d67c2310b55fd1da0c92b024443818f2cfe117d532ae4";

    fn vector() -> Transfer {
        Transfer {
            chain_id: 5_042_002,
            nonce: 7,
            max_priority_fee_per_gas: 1_000_000_000,
            max_fee_per_gas: 50_000_000_000,
            gas_limit: 100_000,
            token: parse_address("0x3600000000000000000000000000000000000000").unwrap(),
            recipient: [0x11; 20],
            amount: 25_000_000,
        }
    }

    #[test]
    fn signed_transaction_matches_cast_byte_for_byte() {
        let r = unhex::<32>("42d7a1c499eaebc1494892fb18c72aee7cf233c6d1c32c111c25788bceb9e639").unwrap();
        let s = unhex::<32>("1d2b25167e724c8c880d67c2310b55fd1da0c92b024443818f2cfe117d532ae4").unwrap();
        assert_eq!(hex(&vector().signed(1, &r, &s)), CAST_RAW);
    }

    #[test]
    fn signing_hash_recovers_to_the_cast_signer() {
        use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
        use sha3::{Digest, Keccak256};
        let hash = Keccak256::digest(vector().signing_payload());
        let r = unhex::<32>("42d7a1c499eaebc1494892fb18c72aee7cf233c6d1c32c111c25788bceb9e639").unwrap();
        let s = unhex::<32>("1d2b25167e724c8c880d67c2310b55fd1da0c92b024443818f2cfe117d532ae4").unwrap();
        let sig = Signature::from_scalars(r, s).unwrap();
        let key = VerifyingKey::recover_from_prehash(&hash, &sig, RecoveryId::from_byte(1).unwrap()).unwrap();
        let point = key.to_encoded_point(false);
        let address = &Keccak256::digest(&point.as_bytes()[1..])[12..];
        // Anvil's account #0.
        assert_eq!(hex(address), "f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    }

    #[test]
    fn high_s_is_flipped_with_its_recovery_bit() {
        let mut big_r = [0x02u8; 33];
        big_r[1..].copy_from_slice(&[0x42; 32]);
        let high_s = sub_be(&SECP256K1_N, &[0x01; 32]);
        let (_, s, v) = normalize(&big_r, &high_s, 0).unwrap();
        assert_eq!(s, [0x01; 32]);
        assert_eq!(v, 1);
        let (_, s, v) = normalize(&big_r, &[0x01; 32], 1).unwrap();
        assert_eq!((s, v), ([0x01; 32], 1));
        assert!(normalize(&big_r, &[0u8; 32], 0).is_none());
        assert!(normalize(&big_r, &SECP256K1_N, 0).is_none());
    }

    #[test]
    fn addresses_parse_strictly() {
        assert!(parse_address("0x1111111111111111111111111111111111111111").is_some());
        assert!(parse_address("1111111111111111111111111111111111111111").is_none());
        assert!(parse_address("0x11").is_none());
        assert!(parse_address("0xzz11111111111111111111111111111111111111").is_none());
    }
}
