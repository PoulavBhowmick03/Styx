//! Vault configuration, read from `STYX_VAULT_*` variables.
//!
//! No key material is held here: a key's file path is resolved only by the operation that needs it.

use std::path::PathBuf;
use std::time::Duration;

use super::error::VaultError;
use super::types::parse_hex;

const DEFAULT_RECEIPT_TIMEOUT_SECONDS: u64 = 60;
const DEFAULT_RPC_TIMEOUT_SECONDS: u64 = 15;

/// Everything needed to talk to one vault.
#[derive(Debug, Clone)]
pub struct VaultConfig {
    /// Expected chain ID. Every RPC endpoint is checked against it.
    pub chain_id: u64,
    /// RPC URLs in failover order.
    pub rpc_urls: Vec<String>,
    /// Vault address.
    pub vault: [u8; 20],
    /// Expected vault token.
    pub token: [u8; 20],
    /// Journal directory, outside the repo.
    pub state_root: PathBuf,
    /// How long `submit` waits for a receipt before reporting `unknown`.
    pub receipt_timeout: Duration,
    /// Per-request RPC timeout.
    pub rpc_timeout: Duration,
}

fn required(name: &str) -> Result<String, VaultError> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| VaultError::invalid(format!("{name} must be set")))
}

fn optional_seconds(name: &str, default: u64) -> Result<Duration, VaultError> {
    match std::env::var(name) {
        Ok(value) => value
            .parse()
            .map(Duration::from_secs)
            .map_err(|_| VaultError::invalid(format!("{name} must be whole seconds"))),
        Err(_) => Ok(Duration::from_secs(default)),
    }
}

fn address(name: &str) -> Result<[u8; 20], VaultError> {
    parse_hex(&required(name)?.to_ascii_lowercase())
        .map_err(|error| VaultError::invalid(format!("{name}: {error}")))
}

impl VaultConfig {
    /// Reads the configuration from the environment.
    pub fn from_env() -> Result<Self, VaultError> {
        let rpc_urls: Vec<String> = required("STYX_VAULT_RPC_URLS")?
            .split(',')
            .map(|url| url.trim().to_owned())
            .filter(|url| !url.is_empty())
            .collect();
        if rpc_urls.is_empty() {
            return Err(VaultError::invalid(
                "STYX_VAULT_RPC_URLS names no endpoint",
            ));
        }
        Ok(Self {
            chain_id: required("STYX_VAULT_CHAIN_ID")?
                .parse()
                .map_err(|_| VaultError::invalid("STYX_VAULT_CHAIN_ID must be an integer"))?,
            rpc_urls,
            vault: address("STYX_VAULT_ADDRESS")?,
            token: address("STYX_VAULT_TOKEN")?,
            state_root: PathBuf::from(required("STYX_VAULT_STATE_ROOT")?),
            receipt_timeout: optional_seconds(
                "STYX_VAULT_RECEIPT_TIMEOUT_SECONDS",
                DEFAULT_RECEIPT_TIMEOUT_SECONDS,
            )?,
            rpc_timeout: optional_seconds(
                "STYX_VAULT_RPC_TIMEOUT_SECONDS",
                DEFAULT_RPC_TIMEOUT_SECONDS,
            )?,
        })
    }

    /// The agent key's file path. Only operations that sign or identify the agent read it.
    pub fn agent_key_file() -> Result<PathBuf, VaultError> {
        Ok(PathBuf::from(required("STYX_VAULT_AGENT_KEY_FILE")?))
    }
}
