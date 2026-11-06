//! Regression tests for RPC trust boundaries. No signing keys are needed.
use super::{digest::evidence_commitment, record::*, rpc::VaultRpc, types::Payment, verify::*};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};

fn server(answer: impl Fn(&str) -> Value + Send + 'static) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            let request: Value = loop {
                let mut buf = [0; 4096];
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    return;
                }
                bytes.extend_from_slice(&buf[..n]);
                if let Some(split) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    if let Ok(value) = serde_json::from_slice(&bytes[split + 4..]) {
                        break value;
                    }
                }
            };
            let response = answer(request["method"].as_str().unwrap());
            let body = json!({"jsonrpc":"2.0", "id":request["id"], "result":response}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
    });
    url
}

#[tokio::test]
async fn failover_must_validate_the_endpoint_that_answers() {
    let other = server(|method| match method {
        "eth_chainId" => json!("0x1"),
        _ => json!("0x6000"),
    });
    let rpc = VaultRpc::new(
        &["http://127.0.0.1:1".into(), other],
        Duration::from_millis(100),
        31337,
    )
    .unwrap();
    assert!(
        rpc.code_hash(&[1; 20]).await.is_err(),
        "wrong-chain code must never become verification evidence"
    );
}

#[tokio::test]
async fn malformed_receipt_status_is_unknown() {
    let rpc_url = server(|method| match method {
        "eth_chainId" => json!("0x7a69"),
        "eth_getTransactionReceipt" => json!({"blockNumber":"0x1", "logs":[]}),
        "eth_getCode" => json!("0x6000"),
        _ => json!(format!("0x{}", "00".repeat(32))),
    });
    let rpc = VaultRpc::new(&[rpc_url], Duration::from_secs(1), 31337).unwrap();
    let report = verify_record(
        &record(31337),
        &rpc,
        &ReviewerPins {
            vault_code_hash: [0; 32],
        },
    )
    .await;
    assert_eq!(report.settlement, Check::Unavailable);
}

#[tokio::test]
async fn record_chain_must_equal_the_reviewers_chain() {
    let rpc_url = server(|method| match method {
        "eth_chainId" => json!("0x7a69"),
        _ => json!(null),
    });
    let rpc = VaultRpc::new(&[rpc_url], Duration::from_secs(1), 31337).unwrap();
    let report = verify_record(
        &record(1),
        &rpc,
        &ReviewerPins {
            vault_code_hash: [0; 32],
        },
    )
    .await;
    assert_eq!(report.settlement, Check::Failed);
    assert!(report.reasons.iter().any(|reason| reason.contains("chain")));
}

fn record(chain_id: u64) -> VaultPaymentRecord {
    VaultPaymentRecord {
        schema: RECORD_SCHEMA.into(),
        chain_id,
        vault: [1; 20],
        vault_code_hash: [0; 32],
        payment: Payment {
            payment_id: [2; 32],
            agent: [3; 20],
            token: [4; 20],
            recipient: [5; 20],
            amount: 1,
            evidence_commitment: evidence_commitment(&[6; 32], b"invoice"),
            policy_version: 1,
            valid_until: 100,
        },
        policy: PolicySnapshot {
            policy_version: 1,
            per_payment_limit: 1,
            daily_limit: 10,
            day: 0,
            day_spent_after: 1,
        },
        exception: None,
        evidence: EvidenceOpening {
            invoice_hex: format!("0x{}", hex::encode(b"invoice")),
            salt: [6; 32],
        },
        settlement: SettlementPointer {
            tx_hash: [7; 32],
            block_number: 1,
            log_index: 0,
        },
    }
}
