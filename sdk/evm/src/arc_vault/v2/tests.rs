use super::{abi, digest, types::*};
use serde_json::Value;

#[test]
fn shared_vector_matches_all_hashes() {
    let v: Value = serde_json::from_str(include_str!("vector.json")).unwrap();
    let p: Payment = serde_json::from_value(v["payment"].clone()).unwrap();
    let a: ExceptionAuthorization = serde_json::from_value(v["authorization"].clone()).unwrap();
    let vault = parse_hex(v["domain"]["verifyingContract"].as_str().unwrap()).unwrap();
    let expected = |key: &str| parse_hex::<32>(v["expected"][key].as_str().unwrap()).unwrap();
    assert_eq!(digest::payment_hash(&p), expected("paymentHash"));
    assert_eq!(
        digest::domain_separator(31337, &vault),
        expected("domainSeparator")
    );
    assert_eq!(
        digest::approval_digest(31337, &vault, &a),
        expected("approvalDigest")
    );
}

#[test]
fn signatures_use_dynamic_abi_offsets_and_padding() {
    let v: Value = serde_json::from_str(include_str!("vector.json")).unwrap();
    let p: Payment = serde_json::from_value(v["payment"].clone()).unwrap();
    let a: ExceptionAuthorization = serde_json::from_value(v["authorization"].clone()).unwrap();
    for length in [0usize, 1, 65, 130, 4096] {
        let bytes = abi::encode_pay_with_exception(&p, &a, &vec![0x33; length]);
        assert_eq!(bytes.len(), 4 + 16 * 32 + length.div_ceil(32) * 32);
        assert_eq!(bytes[4 + 14 * 32 + 31], 0xe0); // 15 words = 480 bytes.
        assert_eq!(&bytes[4 + 16 * 32..][..length], &vec![0x33; length]);
    }
}

#[test]
fn v2_json_refuses_v1_and_round_trips_contract_signature() {
    let v: Value = serde_json::from_str(include_str!("vector.json")).unwrap();
    let mut p = v["payment"].clone();
    p.as_object_mut().unwrap().remove("recipientVersion");
    assert!(serde_json::from_value::<Payment>(p).is_err());
    let file = ApproverSignature {
        schema: SIGNATURE_SCHEMA.into(),
        payment_id: [1; 32],
        approval_digest: [2; 32],
        signer: [3; 20],
        signer_version: 4,
        signature: vec![5; 130],
    };
    let encoded = serde_json::to_vec(&file).unwrap();
    assert_eq!(
        serde_json::from_slice::<ApproverSignature>(&encoded).unwrap(),
        file
    );
}

#[test]
fn retained_identity_rejects_chain_vault_token_agent_and_hash_changes() {
    use super::{
        config::Config,
        journal::{Binding, PaymentRecord, PaymentRef},
        service,
    };
    use std::{path::PathBuf, time::Duration};
    let v: Value = serde_json::from_str(include_str!("vector.json")).unwrap();
    let payment: Payment = serde_json::from_value(v["payment"].clone()).unwrap();
    let cfg = Config {
        chain_id: 31337,
        rpc_urls: vec![],
        vault: [1; 20],
        token: payment.token,
        code_hash: [2; 32],
        state_root: PathBuf::new(),
        agent_key_file: None,
        receipt_timeout: Duration::ZERO,
        rpc_timeout: Duration::ZERO,
    };
    let record = PaymentRecord {
        version: 1,
        id: PaymentRef::new(&payment.payment_id),
        binding: Binding {
            chain_id: cfg.chain_id,
            vault: cfg.vault,
            token: cfg.token,
            code_hash: cfg.code_hash,
            agent: payment.agent,
        },
        payment_hash: digest::payment_hash(&payment),
        payment,
        invoice_hex: "0x".into(),
        salt: [0; 32],
        invoice_reference: String::new(),
        per_payment_limit: 1,
        exception_required: true,
        authorization: None,
        signature: None,
        attempts: vec![],
    };
    assert!(service::check_binding(&cfg, &record).is_ok());
    let mut changed = cfg.clone();
    changed.chain_id += 1;
    assert!(service::check_binding(&changed, &record).is_err());
    let mut changed = cfg.clone();
    changed.vault[0] ^= 1;
    assert!(service::check_binding(&changed, &record).is_err());
    let mut changed = cfg.clone();
    changed.token[0] ^= 1;
    assert!(service::check_binding(&changed, &record).is_err());
    let mut changed = cfg.clone();
    changed.code_hash[0] ^= 1;
    assert!(service::check_binding(&changed, &record).is_err());
    let mut changed = record.clone();
    changed.payment.agent[0] ^= 1;
    assert!(service::check_binding(&cfg, &changed).is_err());
    let mut changed = record.clone();
    changed.payment_hash[0] ^= 1;
    assert!(service::check_binding(&cfg, &changed).is_err());
}
