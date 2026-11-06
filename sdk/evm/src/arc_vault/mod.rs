//! Client for `StyxPolicyVault` on Arc: typed payments, EIP-712 digests, transaction building,
//! event decoding, a durable payment journal and the operations behind the `styx-vault` CLI.
//!
//! USDC through the ERC-20 interface uses 6 decimals. Amounts here are always integer base
//! units of that interface; native gas balances never pass through this module.

pub mod abi;
pub mod config;
pub mod digest;
pub mod error;
pub mod events;
pub mod journal;
pub mod record;
pub mod rpc;
pub mod service;
pub mod types;
/// Explicit organization-vault protocol, isolated from v1.
#[allow(missing_docs)]
pub mod v2;
pub mod verify;

pub use config::VaultConfig;
pub use error::{VaultCode, VaultError};
pub use types::{ExceptionAuthorization, Payment};

#[cfg(test)]
mod security_tests;
