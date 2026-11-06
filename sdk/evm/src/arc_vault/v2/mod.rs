//! StyxVault organization protocol. Version selection is explicit; v1 remains the default.
pub mod abi;
pub mod config;
pub mod digest;
pub mod events;
pub mod journal;
pub mod service;
pub mod types;
pub mod verify;

use super::error::VaultError;

/// Selects v2 only through its new configuration namespace. Unknown versions fail closed.
pub fn selected() -> Result<bool, VaultError> {
    match std::env::var("STYX_VAULT_VERSION").as_deref() {
        Err(std::env::VarError::NotPresent) | Ok("1") => Ok(false),
        Ok("2") => Ok(true),
        _ => Err(VaultError::invalid("STYX_VAULT_VERSION must be 1 or 2")),
    }
}

#[cfg(test)]
mod integration;
#[cfg(test)]
mod tests;
