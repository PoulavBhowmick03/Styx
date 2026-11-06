//! Durable payment records. A payment's ID and digest reach disk before any submission, and a
//! signed transaction reaches disk before any broadcast, so a retry resends the same bytes under
//! the same ID rather than minting a new payment.

use std::path::Path;

use serde::{Deserialize, Serialize};
pub(super) use styx_journal::{
    IdentityLock, JournalRecord, RecordId, RecordLock, Store, StoreError,
};

use super::error::VaultError;
use super::types::{decimal, hex_fixed, ExceptionAuthorization, Payment};

/// A payment ID as a file stem: 64 lowercase hex digits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PaymentRef(String);

impl PaymentRef {
    /// Builds the reference for a payment ID.
    #[must_use]
    pub fn new(payment_id: &[u8; 32]) -> Self {
        Self(hex::encode(payment_id))
    }
}

impl core::fmt::Display for PaymentRef {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl RecordId for PaymentRef {
    fn as_file_stem(&self) -> &str {
        &self.0
    }

    fn from_file_stem(stem: &str) -> Option<Self> {
        let valid = stem.len() == 64
            && stem
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        valid.then(|| Self(stem.to_owned()))
    }
}

/// One signed transaction stored for a payment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attempt {
    /// The transaction hash.
    #[serde(with = "hex_fixed")]
    pub tx_hash: [u8; 32],
}

/// Everything the agent side remembers about one payment.
#[derive(Clone, Serialize, Deserialize)]
pub struct PaymentRecord {
    /// Schema version.
    pub version: u32,
    /// The record's file name.
    pub id: PaymentRef,
    /// The exact payment.
    pub payment: Payment,
    /// Its EIP-712 struct hash.
    #[serde(with = "hex_fixed")]
    pub payment_hash: [u8; 32],
    /// The canonical private invoice bytes, as hex.
    pub invoice_hex: String,
    /// The salt that opens the evidence commitment.
    #[serde(with = "hex_fixed")]
    pub salt: [u8; 32],
    /// The agent's invoice reference text.
    pub invoice_reference: String,
    /// The per-payment limit read when the payment was proposed.
    #[serde(with = "decimal")]
    pub per_payment_limit: u128,
    /// Whether the amount exceeded the per-payment limit when proposed.
    pub exception_required: bool,
    /// The struct the owner is asked to sign.
    pub authorization: Option<ExceptionAuthorization>,
    /// The owner's signature, as `0x` hex.
    pub owner_signature: Option<String>,
    /// Signed transactions, oldest first; each has a stored blob.
    pub attempts: Vec<Attempt>,
}

impl JournalRecord for PaymentRecord {
    type Id = PaymentRef;

    const CURRENT_VERSION: u32 = 1;
    const OLDEST_READABLE_VERSION: u32 = 1;

    fn version(&self) -> u32 {
        self.version
    }

    fn record_id(&self) -> &Self::Id {
        &self.id
    }

    /// The engine treats zero as corruption, while a proposed payment has signed nothing yet.
    /// Blob reads are driven by `attempts` itself, so reporting one here is safe.
    fn attempt_count(&self) -> usize {
        self.attempts.len().max(1)
    }
}

/// The journal plus the locks held for the whole operation, so two processes cannot sign two
/// transactions for one payment.
pub struct Journal {
    store: Store<PaymentRecord>,
    _identity: IdentityLock,
}

/// A record's lock. Holding it serializes every operation on that payment.
pub struct HeldRecord {
    _lock: RecordLock,
}

fn storage<E: core::fmt::Display>(error: E) -> VaultError {
    VaultError::invalid(format!("journal: {error}"))
}

impl Journal {
    /// Opens the journal and takes its identity lock.
    pub fn open(root: &Path) -> Result<Self, VaultError> {
        let store = Store::open(root.to_path_buf()).map_err(storage)?;
        let identity = store.lock_identity().map_err(storage)?;
        Ok(Self {
            store,
            _identity: identity,
        })
    }

    /// Locks one record for the rest of the operation.
    pub fn lock(&self, id: &PaymentRef) -> Result<HeldRecord, VaultError> {
        Ok(HeldRecord {
            _lock: self.store.lock_record(id).map_err(storage)?,
        })
    }

    /// Reads a record, failing closed on anything unreadable.
    pub fn read(&self, id: &PaymentRef) -> Result<Option<PaymentRecord>, VaultError> {
        self.store.read(id).map_err(storage)
    }

    /// Replaces a record atomically.
    pub fn write(&self, record: &PaymentRecord) -> Result<(), VaultError> {
        self.store.write(record).map_err(storage)
    }

    /// Stores a signed transaction durably, then names it in the record.
    pub fn store_attempt(
        &self,
        record: &mut PaymentRecord,
        raw: &[u8],
        tx_hash: [u8; 32],
    ) -> Result<(), VaultError> {
        let index = record.attempts.len();
        self.store
            .write_blob_then_record::<styx_journal::StoreError<PaymentRef>>(
                record,
                index,
                raw,
                |record| {
                    record.attempts.push(Attempt { tx_hash });
                    Ok(())
                },
            )
            .map_err(storage)
    }

    /// Reads the stored bytes of one attempt.
    pub fn read_attempt(&self, id: &PaymentRef, index: usize) -> Result<Vec<u8>, VaultError> {
        self.store.read_blob(id, index).map_err(storage)
    }
}
