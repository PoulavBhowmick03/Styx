//! V2 uses only the STYX configuration namespace.
use super::super::error::VaultError;
use super::types::parse_hex;
use std::{path::PathBuf, time::Duration};

#[derive(Clone)]
pub struct Config {
    pub chain_id: u64,
    pub rpc_urls: Vec<String>,
    pub vault: [u8; 20],
    pub token: [u8; 20],
    pub code_hash: [u8; 32],
    pub state_root: PathBuf,
    pub agent_key_file: Option<PathBuf>,
    pub receipt_timeout: Duration,
    pub rpc_timeout: Duration,
}
fn required(name: &str) -> Result<String, VaultError> {
    std::env::var(name)
        .ok()
        .filter(|x| !x.is_empty())
        .ok_or_else(|| VaultError::invalid(format!("{name} must be set")))
}
fn seconds(name: &str, default: u64) -> Result<Duration, VaultError> {
    std::env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .parse()
        .map(Duration::from_secs)
        .map_err(|_| VaultError::invalid(format!("{name} must be whole seconds")))
}
impl Config {
    pub fn from_env() -> Result<Self, VaultError> {
        let rpc_urls: Vec<String> = required("STYX_VAULT_RPC_URLS")?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if rpc_urls.is_empty() {
            return Err(VaultError::invalid("no STYX RPC endpoint configured"));
        }
        Ok(Self {
            chain_id: required("STYX_VAULT_CHAIN_ID")?
                .parse()
                .map_err(|_| VaultError::invalid("invalid STYX chain ID"))?,
            rpc_urls,
            vault: parse_hex(&required("STYX_VAULT_ADDRESS")?).map_err(VaultError::invalid)?,
            token: parse_hex(&required("STYX_VAULT_TOKEN")?).map_err(VaultError::invalid)?,
            code_hash: parse_hex(&required("STYX_VAULT_CODE_HASH")?)
                .map_err(VaultError::invalid)?,
            state_root: PathBuf::from(required("STYX_VAULT_STATE_ROOT")?),
            agent_key_file: std::env::var("STYX_VAULT_AGENT_KEY_FILE")
                .ok()
                .map(PathBuf::from),
            receipt_timeout: seconds("STYX_VAULT_RECEIPT_TIMEOUT_SECONDS", 60)?,
            rpc_timeout: seconds("STYX_VAULT_RPC_TIMEOUT_SECONDS", 15)?,
        })
    }
}
