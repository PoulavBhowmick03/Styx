//! The EVM side of a Chain Signatures payment: find the vault's derived address, broadcast the
//! transactions the vault signed, and confirm a transfer from its receipt.
//!
//! Nothing here signs. The vault built and the MPC network signed every transaction; this only
//! carries them to the chain and reads back what happened.

use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

/// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

pub struct EvmRpc {
    url: String,
    client: reqwest::Client,
}

impl EvmRpc {
    pub fn new(url: &str) -> Self {
        Self { url: url.to_string(), client: reqwest::Client::new() }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let reply: Value = self
            .client
            .post(&self.url)
            .json(&body)
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("{method}: {e}"))?
            .json()
            .await
            .map_err(|e| format!("{method}: {e}"))?;
        if let Some(error) = reply.get("error") {
            return Err(format!("{method}: {error}"));
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn chain_id(&self) -> Result<u64, String> {
        let hex = self.call("eth_chainId", json!([])).await?;
        parse_quantity(&hex).ok_or_else(|| "eth_chainId: malformed".into())
    }

    /// The next nonce the chain expects from `address`, counting only included transactions.
    pub async fn nonce(&self, address: &str) -> Result<u64, String> {
        let hex = self.call("eth_getTransactionCount", json!([address, "latest"])).await?;
        parse_quantity(&hex).ok_or_else(|| "eth_getTransactionCount: malformed".into())
    }

    /// Sends a raw transaction. A node that already has it is not an error.
    pub async fn send_raw(&self, raw: &str) -> Result<(), String> {
        match self.call("eth_sendRawTransaction", json!([raw])).await {
            Ok(_) => Ok(()),
            Err(e) if e.contains("already known") || e.contains("nonce too low") || e.contains("AlreadyKnown") => Ok(()),
            Err(e) => Err(e),
        }
    }

    pub async fn receipt(&self, tx_hash: &str) -> Result<Option<Value>, String> {
        let r = self.call("eth_getTransactionReceipt", json!([tx_hash])).await?;
        Ok((!r.is_null()).then_some(r))
    }
}

/// The EVM address for a secp256k1 public key given as NEAR's `secp256k1:<base58 of 64 bytes>`.
pub fn address_from_near_key(key: &str) -> Option<String> {
    let encoded = key.strip_prefix("secp256k1:")?;
    let bytes = bs58::decode(encoded).into_vec().ok()?;
    if bytes.len() != 64 {
        return None;
    }
    let hash = Keccak256::digest(&bytes);
    Some(format!("0x{}", hex::encode(&hash[12..])))
}

/// What a receipt says about the transfer the vault signed.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Included, succeeded, and the token logged exactly this transfer.
    Transferred,
    /// Included but reverted, or succeeded without the expected Transfer log.
    Failed(String),
}

pub fn check_receipt(receipt: &Value, token: &str, from: &str, to: &str, amount: u128) -> Outcome {
    if receipt.get("status").and_then(Value::as_str) != Some("0x1") {
        return Outcome::Failed("the transaction reverted on the EVM chain".into());
    }
    let padded = |address: &str| format!("0x{:0>64}", address.trim_start_matches("0x").to_ascii_lowercase());
    let found = receipt.get("logs").and_then(Value::as_array).map(|logs| {
        logs.iter().any(|log| {
            let topics: Vec<String> = log
                .get("topics")
                .and_then(Value::as_array)
                .map(|t| t.iter().filter_map(|x| x.as_str().map(str::to_ascii_lowercase)).collect())
                .unwrap_or_default();
            log.get("address").and_then(Value::as_str).map(str::to_ascii_lowercase).as_deref() == Some(&token.to_ascii_lowercase())
                && topics.len() == 3
                && topics[0] == TRANSFER_TOPIC
                && topics[1] == padded(from)
                && topics[2] == padded(to)
                && log.get("data").and_then(Value::as_str).and_then(word_u128) == Some(amount)
        })
    });
    if found == Some(true) {
        Outcome::Transferred
    } else {
        Outcome::Failed("the receipt has no matching USDC Transfer log".into())
    }
}

/// A 32-byte ABI word as u128, refusing anything that does not fit.
fn word_u128(data: &str) -> Option<u128> {
    let digits = data.strip_prefix("0x")?;
    if digits.len() != 64 || !digits[..32].bytes().all(|b| b == b'0') {
        return None;
    }
    u128::from_str_radix(&digits[32..], 16).ok()
}

fn parse_quantity(value: &Value) -> Option<u64> {
    u64::from_str_radix(value.as_str()?.strip_prefix("0x")?, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_vault_v2_address_from_the_signer_key() {
        // From v1.signer-prod.testnet derived_public_key(path "styx-evm", predecessor vault-v2…).
        let key = "secp256k1:5B25Wg1ThS6QAEw821NdqYtyhmECJvTW45h3indqwQbzrjqFFX6kcYiC4LKqQ2rSKSRWum4gWeXuwxfFwdUfWhjM";
        assert_eq!(address_from_near_key(key).unwrap(), "0xb0241fcbd5a1d9d79a37c927559186ed08563cad");
    }

    fn receipt(status: &str, amount_hex: &str) -> Value {
        json!({"status": status, "logs": [{
            "address": "0x3600000000000000000000000000000000000000",
            "topics": [TRANSFER_TOPIC,
                "0x000000000000000000000000b0241fcbd5a1d9d79a37c927559186ed08563cad",
                "0x000000000000000000000000f4d88218d13333247bf7616affb45f24a21e07cc"],
            "data": amount_hex}]})
    }

    #[test]
    fn a_transfer_counts_only_with_the_exact_log() {
        let token = "0x3600000000000000000000000000000000000000";
        let from = "0xb0241fcbd5a1d9d79a37c927559186ed08563cad";
        let to = "0xf4D88218d13333247BF7616AFFb45F24a21E07cc";
        let amount_hex = "0x00000000000000000000000000000000000000000000000000000000017d7840";
        assert_eq!(check_receipt(&receipt("0x1", amount_hex), token, from, to, 25_000_000), Outcome::Transferred);
        assert!(matches!(check_receipt(&receipt("0x1", amount_hex), token, from, to, 1), Outcome::Failed(_)));
        assert!(matches!(check_receipt(&receipt("0x0", amount_hex), token, from, to, 25_000_000), Outcome::Failed(_)));
        assert!(matches!(check_receipt(&receipt("0x1", amount_hex), token, to, from, 25_000_000), Outcome::Failed(_)));
    }
}
