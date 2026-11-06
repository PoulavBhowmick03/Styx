//! Local transaction signing.

mod transaction;

pub use transaction::{
    build_signed_call, Eip1559Fees, SignedTransaction, TransactionKey, TransactionParams,
};

/// Length of an EVM address.
pub const ADDRESS_BYTES: usize = 20;
