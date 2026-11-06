//! Client for `ErebusPolicyVault` on Arc: typed payments, EIP-712 digests, transaction building,
//! event decoding, a durable payment journal and the operations behind the `erebus-vault` CLI.
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
pub mod verify;

pub use config::VaultConfig;
pub use error::{VaultCode, VaultError};
pub use types::{ExceptionAuthorization, Payment};
