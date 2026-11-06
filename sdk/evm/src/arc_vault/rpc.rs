//! Minimal JSON-RPC with failover. A failed read is "unavailable", never a statement about the chain.

use std::time::Duration;

use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};

use super::error::VaultError;
use super::types::parse_hex;

/// Arc's mempool rejects a `maxFeePerGas` below 20 gwei.
pub const MIN_MAX_FEE_PER_GAS: u128 = 20_000_000_000;

/// The result of simulating a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallOutcome {
    /// The call returned these bytes.
    Returned(Vec<u8>),
    /// The node reported a revert with this data.
    Reverted(Vec<u8>),
}

/// RPC endpoints in failover order, bound to one expected chain.
pub struct VaultRpc {
    providers: Vec<DynProvider>,
    timeout: Duration,
    chain_id: u64,
}

fn quantity(value: &Value, label: &str) -> Result<u128, VaultError> {
    value
        .as_str()
        .and_then(|text| text.strip_prefix("0x"))
        .and_then(|digits| u128::from_str_radix(digits, 16).ok())
        .ok_or_else(|| VaultError::unavailable(format!("malformed {label} from RPC")))
}

fn hex_bytes(value: &Value) -> Option<Vec<u8>> {
    hex::decode(value.as_str()?.strip_prefix("0x")?).ok()
}

impl VaultRpc {
    /// Connects to each URL. No request is sent yet.
    pub fn new(urls: &[String], timeout: Duration, chain_id: u64) -> Result<Self, VaultError> {
        let providers = urls
            .iter()
            .map(|url| {
                let parsed = url
                    .parse()
                    .map_err(|_| VaultError::invalid("invalid RPC URL"))?;
                Ok(ProviderBuilder::new().connect_http(parsed).erased())
            })
            .collect::<Result<Vec<_>, VaultError>>()?;
        if providers.is_empty() {
            return Err(VaultError::invalid("no RPC endpoint configured"));
        }
        Ok(Self {
            providers,
            timeout,
            chain_id,
        })
    }

    /// Sends one request, moving to the next endpoint on a transport failure. RPC URLs can embed
    /// API keys, so errors never include them.
    async fn request(&self, method: &'static str, params: Value) -> Result<Value, RpcFailure> {
        let mut rejected = None;
        for provider in &self.providers {
            // Failover changes the source of evidence. Check that source before every
            // operation, including reads and rebroadcasts; a prior endpoint's check
            // says nothing about this one.
            if method != "eth_chainId" {
                let chain = provider
                    .client()
                    .request::<Value, Value>("eth_chainId", json!([]));
                match tokio::time::timeout(self.timeout, chain).await {
                    Ok(Ok(value))
                        if quantity(&value, "chain ID").ok() == Some(u128::from(self.chain_id)) => {
                    }
                    _ => continue,
                }
            }
            let call = provider
                .client()
                .request::<Value, Value>(method, params.clone());
            match tokio::time::timeout(self.timeout, call).await {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(error)) => {
                    if let Some(payload) = error.as_error_resp() {
                        // A busy endpoint has not answered the question, so try the next one.
                        if is_rate_limited(payload.code, &payload.message) {
                            continue;
                        }
                        rejected = Some(RpcFailure::Rejected {
                            message: payload.message.to_string(),
                            data: payload
                                .data
                                .as_ref()
                                .and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok()),
                        });
                        // A node's answer is an answer, so it does not trigger failover.
                        break;
                    }
                }
                Err(_) => {}
            }
        }
        Err(rejected.unwrap_or(RpcFailure::Unavailable))
    }

    async fn read(&self, method: &'static str, params: Value) -> Result<Value, VaultError> {
        self.request(method, params)
            .await
            .map_err(|_| VaultError::unavailable(format!("{method} is unavailable")))
    }

    /// The chain this RPC instance is configured to serve.
    #[must_use]
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// Fails unless the endpoint serves the configured chain.
    pub async fn check_chain(&self) -> Result<(), VaultError> {
        let reported = quantity(&self.read("eth_chainId", json!([])).await?, "chain ID")?;
        if reported != u128::from(self.chain_id) {
            return Err(VaultError::invalid(format!(
                "RPC serves chain {reported}, expected {}",
                self.chain_id
            )));
        }
        Ok(())
    }

    /// `eth_call` at the latest block.
    pub async fn call(
        &self,
        from: Option<&[u8; 20]>,
        to: &[u8; 20],
        input: &[u8],
    ) -> Result<CallOutcome, VaultError> {
        let mut request = json!({
            "to": format!("0x{}", hex::encode(to)),
            "data": format!("0x{}", hex::encode(input)),
        });
        if let Some(from) = from {
            request["from"] = json!(format!("0x{}", hex::encode(from)));
        }
        match self.request("eth_call", json!([request, "latest"])).await {
            Ok(value) => hex_bytes(&value)
                .map(CallOutcome::Returned)
                .ok_or_else(|| VaultError::unavailable("malformed eth_call result")),
            Err(RpcFailure::Rejected { data, message }) => {
                if let Some(bytes) = data.as_ref().and_then(hex_bytes) {
                    return Ok(CallOutcome::Reverted(bytes));
                }
                if message.to_ascii_lowercase().contains("revert") {
                    return Ok(CallOutcome::Reverted(Vec::new()));
                }
                Err(VaultError::unavailable("eth_call was rejected"))
            }
            Err(RpcFailure::Unavailable) => Err(VaultError::unavailable("eth_call is unavailable")),
        }
    }

    /// `eth_call` for a view that must not revert.
    pub async fn view(&self, to: &[u8; 20], input: &[u8]) -> Result<Vec<u8>, VaultError> {
        match self.call(None, to, input).await? {
            CallOutcome::Returned(bytes) => Ok(bytes),
            CallOutcome::Reverted(_) => Err(VaultError::unavailable("a view call reverted")),
        }
    }

    /// Reads one word as an integer.
    pub async fn view_u128(&self, to: &[u8; 20], input: &[u8]) -> Result<u128, VaultError> {
        let bytes = self.view(to, input).await?;
        if bytes.len() != 32 || bytes[..16] != [0; 16] {
            return Err(VaultError::unavailable("unexpected word from a view call"));
        }
        let mut word = [0u8; 16];
        word.copy_from_slice(&bytes[16..]);
        Ok(u128::from_be_bytes(word))
    }

    /// Reads one word as a boolean.
    pub async fn view_bool(&self, to: &[u8; 20], input: &[u8]) -> Result<bool, VaultError> {
        match self.view_u128(to, input).await? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(VaultError::unavailable("unexpected boolean from a view")),
        }
    }

    /// Reads one word as an address.
    pub async fn view_address(&self, to: &[u8; 20], input: &[u8]) -> Result<[u8; 20], VaultError> {
        let bytes = self.view(to, input).await?;
        if bytes.len() != 32 || bytes[..12] != [0; 12] {
            return Err(VaultError::unavailable("unexpected address from a view"));
        }
        let mut address = [0u8; 20];
        address.copy_from_slice(&bytes[12..]);
        Ok(address)
    }

    /// Reads one word as 32 bytes.
    pub async fn view_word(&self, to: &[u8; 20], input: &[u8]) -> Result<[u8; 32], VaultError> {
        self.view(to, input)
            .await?
            .try_into()
            .map_err(|_| VaultError::unavailable("unexpected word from a view call"))
    }

    /// The latest block's timestamp.
    pub async fn latest_timestamp(&self) -> Result<u64, VaultError> {
        let block = self
            .read("eth_getBlockByNumber", json!(["latest", false]))
            .await?;
        u64::try_from(quantity(&block["timestamp"], "timestamp")?)
            .map_err(|_| VaultError::unavailable("timestamp out of range"))
    }

    /// The account's next nonce, including pending transactions.
    pub async fn pending_nonce(&self, account: &[u8; 20]) -> Result<u64, VaultError> {
        let value = self
            .read(
                "eth_getTransactionCount",
                json!([format!("0x{}", hex::encode(account)), "pending"]),
            )
            .await?;
        u64::try_from(quantity(&value, "nonce")?)
            .map_err(|_| VaultError::unavailable("nonce out of range"))
    }

    /// Fee caps honouring Arc's floor: `(max_fee_per_gas, max_priority_fee_per_gas)`.
    pub async fn fees(&self) -> Result<(u128, u128), VaultError> {
        let price = quantity(&self.read("eth_gasPrice", json!([])).await?, "gas price")?;
        let max_fee = price.saturating_mul(2).max(MIN_MAX_FEE_PER_GAS);
        Ok((max_fee, price.min(1_000_000_000)))
    }

    /// Estimates gas for a call from `from`.
    pub async fn estimate_gas(
        &self,
        from: &[u8; 20],
        to: &[u8; 20],
        input: &[u8],
    ) -> Result<u64, VaultError> {
        let value = self
            .read(
                "eth_estimateGas",
                json!([{
                    "from": format!("0x{}", hex::encode(from)),
                    "to": format!("0x{}", hex::encode(to)),
                    "data": format!("0x{}", hex::encode(input)),
                }]),
            )
            .await?;
        u64::try_from(quantity(&value, "gas estimate")?)
            .map_err(|_| VaultError::unavailable("gas estimate out of range"))
    }

    /// Sends exact raw bytes. Any failure leaves the outcome unknown, so the caller must
    /// reconcile before doing anything else.
    pub async fn send_raw(&self, raw: &[u8]) -> Result<(), VaultError> {
        self.read(
            "eth_sendRawTransaction",
            json!([format!("0x{}", hex::encode(raw))]),
        )
        .await
        .map(|_| ())
    }

    /// A receipt, or `None` when none is visible. `None` does not mean the transaction failed:
    /// on Arc a blocklist revert also leaves no receipt.
    pub async fn receipt(&self, tx_hash: &[u8; 32]) -> Result<Option<Value>, VaultError> {
        let value = self
            .read(
                "eth_getTransactionReceipt",
                json!([format!("0x{}", hex::encode(tx_hash))]),
            )
            .await?;
        Ok((!value.is_null()).then_some(value))
    }

    /// Reads a transaction to bind disclosed signature bytes to actual execution.
    pub async fn transaction(&self, hash: &[u8; 32]) -> Result<Option<Value>, VaultError> {
        let value = self
            .read(
                "eth_getTransactionByHash",
                json!([format!("0x{}", hex::encode(hash))]),
            )
            .await?;
        Ok((!value.is_null()).then_some(value))
    }

    /// Reads the canonical block hash for a receipt observation. This is not a finality check.
    pub async fn canonical_block_hash(&self, number: u64) -> Result<[u8; 32], VaultError> {
        let block = self
            .read(
                "eth_getBlockByNumber",
                json!([format!("0x{number:x}"), false]),
            )
            .await?;
        parse_hex(
            block["hash"]
                .as_str()
                .ok_or_else(|| VaultError::unavailable("missing canonical block hash"))?,
        )
        .map_err(|_| VaultError::unavailable("invalid canonical block hash"))
    }

    /// keccak256 of the runtime code at `address`.
    pub async fn code_hash(&self, address: &[u8; 20]) -> Result<[u8; 32], VaultError> {
        let value = self
            .read(
                "eth_getCode",
                json!([format!("0x{}", hex::encode(address)), "latest"]),
            )
            .await?;
        let code =
            hex_bytes(&value).ok_or_else(|| VaultError::unavailable("malformed code from RPC"))?;
        if code.is_empty() {
            return Err(VaultError::unavailable("no code at the vault address"));
        }
        Ok(Keccak256::digest(&code).into())
    }
}

/// Whether a JSON-RPC error means the endpoint is busy, rather than an answer about the chain.
fn is_rate_limited(code: i64, message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    matches!(code, 429 | -32005 | -32029)
        || message.contains("rate limit")
        || message.contains("too many requests")
}

/// Reads a receipt's status: `Some(true)` for success, `Some(false)` for a revert.
#[must_use]
pub fn receipt_succeeded(receipt: &Value) -> Option<bool> {
    match receipt["status"].as_str()? {
        "0x1" => Some(true),
        "0x0" => Some(false),
        _ => None,
    }
}

/// Reads a receipt's block number.
#[must_use]
pub fn receipt_block(receipt: &Value) -> Option<u64> {
    u64::from_str_radix(receipt["blockNumber"].as_str()?.strip_prefix("0x")?, 16).ok()
}

/// Reads a receipt's transaction hash.
#[must_use]
pub fn receipt_tx_hash(receipt: &Value) -> Option<[u8; 32]> {
    parse_hex(receipt["transactionHash"].as_str()?).ok()
}

enum RpcFailure {
    /// No endpoint answered.
    Unavailable,
    /// A node answered with a JSON-RPC error.
    Rejected {
        message: String,
        data: Option<Value>,
    },
}

#[cfg(test)]
mod tests {
    use super::is_rate_limited;

    #[test]
    fn only_busy_endpoints_count_as_rate_limited() {
        assert!(is_rate_limited(-32005, "limit exceeded"));
        assert!(is_rate_limited(429, "slow down"));
        assert!(is_rate_limited(-32000, "Rate limit reached"));
        // Vault reverts and fee errors are real answers, even when they mention a limit.
        assert!(!is_rate_limited(3, "execution reverted"));
        assert!(!is_rate_limited(-32000, "exceeds block gas limit"));
    }
}
