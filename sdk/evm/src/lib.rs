//! The Styx vault client and the reviewer's disclosure tool.
//!
//! [`arc_vault`] proposes, journals, signs and submits vault payments, and verifies payment records
//! against the chain. [`disclosure`] seals one record to one reviewer and opens it again.

pub mod abi;
pub mod arc_vault;
pub mod chain;
pub mod disclosure;
pub mod error;
