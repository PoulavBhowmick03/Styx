//! The Rust digests against the vector generated independently with `cast`.

use styx_evm::arc_vault::digest::{approval_digest, domain_separator, payment_hash};
use styx_evm::arc_vault::types::parse_hex;
use styx_evm::arc_vault::verify::recover_signer;
use styx_evm::arc_vault::{ExceptionAuthorization, Payment};
use k256::ecdsa::SigningKey;
use serde_json::Value;
use sha3::{Digest, Keccak256};

const VECTOR: &str = include_str!("../../core/tests/fixtures/vault-eip712-vector.json");

fn fixture() -> Value {
    serde_json::from_str(VECTOR).unwrap()
}

fn hash(value: &Value) -> [u8; 32] {
    parse_hex(value.as_str().unwrap()).unwrap()
}

#[test]
fn digests_match_the_shared_vector() {
    let vector = fixture();
    let payment: Payment = serde_json::from_value(vector["payment"].clone()).unwrap();
    let chain_id: u64 = vector["domain"]["chainId"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let vault: [u8; 20] =
        parse_hex(vector["domain"]["verifyingContract"].as_str().unwrap()).unwrap();
    let expected = &vector["expected"];

    assert_eq!(
        domain_separator(chain_id, &vault),
        hash(&expected["domainSeparator"])
    );
    let payment_digest = payment_hash(&payment);
    assert_eq!(payment_digest, hash(&expected["paymentHash"]));

    let authorization = ExceptionAuthorization {
        payment_hash: payment_digest,
        approval_nonce: vector["authorization"]["approvalNonce"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        authorization_expiry: vector["authorization"]["authorizationExpiry"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
    };
    assert_eq!(
        approval_digest(chain_id, &vault, &authorization),
        hash(&expected["approvalDigest"])
    );
}

#[test]
fn recover_accepts_wallet_and_raw_recovery_ids_and_refuses_others() {
    let key = SigningKey::from_slice(&[0x07; 32]).unwrap();
    let digest = hash(&fixture()["expected"]["approvalDigest"]);
    let (signature, id) = key.sign_prehash_recoverable(&digest).unwrap();
    let point = key.verifying_key().to_encoded_point(false);
    let hashed: [u8; 32] = Keccak256::digest(&point.as_bytes()[1..]).into();
    let address: [u8; 20] = hashed[12..].try_into().unwrap();

    let mut encoded = [0u8; 65];
    encoded[..64].copy_from_slice(&signature.to_bytes());
    encoded[64] = id.to_byte();
    assert_eq!(recover_signer(&digest, &encoded), Some(address));
    encoded[64] = id.to_byte() + 27;
    assert_eq!(recover_signer(&digest, &encoded), Some(address));
    encoded[64] = 29;
    assert_eq!(recover_signer(&digest, &encoded), None);
}
