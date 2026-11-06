//! Local signing of transactions, with every field chosen by the caller.
//!
//! [`build_signed_call`] is a pure function, so the caller can persist the exact bytes before
//! broadcasting them. Signing is RFC 6979 deterministic.

use alloy::consensus::{SignableTransaction, TxEip1559, TxEnvelope};
use alloy::eips::eip2718::{Decodable2718, Encodable2718};
use alloy::primitives::{keccak256, Address, Bytes, TxKind, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::SignerSync;

use super::ADDRESS_BYTES;
use crate::error::EvmError;

/// Minimum fee increase, in percent, for a same-nonce replacement.
///
/// This is a local policy, not a node rule. A node can still reject a replacement.
pub const REPLACEMENT_BUMP_PERCENT: u128 = 10;

/// A gas-paying transaction key, independent of the deal authorization role.
pub struct TransactionKey(PrivateKeySigner);

impl TransactionKey {
    /// Wraps a secp256k1 secret key.
    pub fn from_bytes(key: &[u8; 32]) -> Result<Self, EvmError> {
        PrivateKeySigner::from_slice(key)
            .map(Self)
            .map_err(|_| EvmError::InvalidSigningKey)
    }

    /// The address transactions signed with this key are sent from.
    #[must_use]
    pub fn address(&self) -> [u8; ADDRESS_BYTES] {
        self.0.address().0 .0
    }
}

impl std::fmt::Debug for TransactionKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TransactionKey")
            .field("address", &format!("{:#x}", self.0.address()))
            .finish_non_exhaustive()
    }
}

/// EIP-1559 fee caps, with the priority fee never above the max fee.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Eip1559Fees {
    max_fee_per_gas: u128,
    max_priority_fee_per_gas: u128,
}

impl Eip1559Fees {
    /// Builds fee caps. This adapter rejects zero max fees and priority above max fee.
    pub fn new(max_fee_per_gas: u128, max_priority_fee_per_gas: u128) -> Result<Self, EvmError> {
        if max_fee_per_gas == 0 {
            return Err(EvmError::InvalidFees("max fee per gas is zero"));
        }
        if max_priority_fee_per_gas > max_fee_per_gas {
            return Err(EvmError::InvalidFees("priority fee exceeds max fee"));
        }
        Ok(Self {
            max_fee_per_gas,
            max_priority_fee_per_gas,
        })
    }

    /// The max fee per gas, in wei.
    #[must_use]
    pub const fn max_fee_per_gas(&self) -> u128 {
        self.max_fee_per_gas
    }

    /// The max priority fee per gas, in wei.
    #[must_use]
    pub const fn max_priority_fee_per_gas(&self) -> u128 {
        self.max_priority_fee_per_gas
    }

    /// The lowest fees a same-nonce replacement of a transaction with these fees should carry:
    /// both caps raised by [`REPLACEMENT_BUMP_PERCENT`], rounded up.
    pub fn replacement_floor(&self) -> Result<Self, EvmError> {
        let bump = |value: u128| -> Result<u128, EvmError> {
            let increase = (value / 100) * REPLACEMENT_BUMP_PERCENT
                + ((value % 100) * REPLACEMENT_BUMP_PERCENT).div_ceil(100);
            value
                .checked_add(increase)
                .ok_or(EvmError::InvalidFees("replacement fee overflows"))
        };
        Self::new(
            bump(self.max_fee_per_gas)?,
            bump(self.max_priority_fee_per_gas)?,
        )
    }

    /// Reports whether these fees meet the replacement floor of `previous`.
    #[must_use]
    pub fn can_replace(&self, previous: &Self) -> bool {
        previous.replacement_floor().is_ok_and(|floor| {
            self.max_fee_per_gas >= floor.max_fee_per_gas
                && self.max_priority_fee_per_gas >= floor.max_priority_fee_per_gas
        })
    }
}

/// The caller-chosen fields of one transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransactionParams {
    /// Account nonce. The caller allocates it; nothing here reads it from the chain.
    pub nonce: u64,
    /// Fee caps.
    pub fees: Eip1559Fees,
    /// Gas limit.
    pub gas_limit: u64,
    /// Native value in wei bound to the call.
    ///
    /// Settlement, approval, deposit, withdrawal, and unwrap calls must use zero explicitly.
    /// Only a native wrap may set a nonzero value, equal to the wrapped amount.
    pub value: u128,
}

/// A signed EIP-1559 transaction and the fields it commits to.
///
/// [`Self::from_raw`] derives the transaction fields from the raw bytes. The caller must also
/// persist the expected settlement intent and check it with [`Self::validate_against`].
#[derive(Clone, PartialEq, Eq)]
pub struct SignedTransaction {
    raw: Vec<u8>,
    hash: [u8; 32],
    sender: [u8; ADDRESS_BYTES],
    chain_id: u64,
    params: TransactionParams,
    to: [u8; ADDRESS_BYTES],
    input: Vec<u8>,
}

impl std::fmt::Debug for SignedTransaction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SignedTransaction")
            .field("hash", &self.hash)
            .field("chain_id", &self.chain_id)
            .field("params", &self.params)
            .finish_non_exhaustive()
    }
}

impl SignedTransaction {
    /// Decodes raw bytes produced by [`build_signed`], for example after a restart.
    ///
    /// Accepts only a canonically encoded, signed EIP-1559 contract call. The hash is
    /// recomputed and the sender recovered from the signature; neither is trusted from
    /// storage. Rejects nonempty access lists, zero gas, and high-s signatures. The native
    /// value is decoded into the parameters; callers that require zero must compare against
    /// their plan. This only decodes the transaction; use [`Self::validate_against`] before
    /// rebroadcast.
    pub fn from_raw(raw: &[u8]) -> Result<Self, EvmError> {
        let envelope = TxEnvelope::decode_2718_exact(raw)
            .map_err(|error| EvmError::TransactionEncoding(error.to_string()))?;
        if envelope.encoded_2718() != raw {
            return Err(EvmError::TransactionEncoding(
                "encoding is not canonical".to_owned(),
            ));
        }
        let TxEnvelope::Eip1559(signed) = envelope else {
            return Err(EvmError::TransactionEncoding(
                "not an EIP-1559 transaction".to_owned(),
            ));
        };
        let transaction = signed.tx();
        if transaction.gas_limit == 0
            || !transaction.access_list.0.is_empty()
            || signed.signature().normalize_s().is_some()
        {
            return Err(EvmError::TransactionEncoding(
                "zero gas, nonempty access list, or high-s signature".to_owned(),
            ));
        }
        let TxKind::Call(to) = transaction.to else {
            return Err(EvmError::TransactionEncoding(
                "contract creation, not a call".to_owned(),
            ));
        };
        let value: u128 = transaction
            .value
            .try_into()
            .map_err(|_| EvmError::TransactionEncoding("value exceeds u128".to_owned()))?;
        let sender = signed
            .signature()
            .recover_address_from_prehash(&transaction.signature_hash())
            .map_err(|error| EvmError::TransactionEncoding(error.to_string()))?;
        let fees = Eip1559Fees::new(
            transaction.max_fee_per_gas,
            transaction.max_priority_fee_per_gas,
        )?;
        Ok(Self {
            raw: raw.to_vec(),
            hash: signed.hash().0,
            sender: sender.0 .0,
            chain_id: transaction.chain_id,
            params: TransactionParams {
                nonce: transaction.nonce,
                fees,
                gas_limit: transaction.gas_limit,
                value,
            },
            to: to.0 .0,
            input: transaction.input.to_vec(),
        })
    }

    /// The EIP-2718 encoded signed transaction, as sent to `eth_sendRawTransaction`.
    #[must_use]
    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    /// The transaction hash, `keccak256(raw)`: the hash it is mined under.
    #[must_use]
    pub const fn hash(&self) -> [u8; 32] {
        self.hash
    }

    /// The signing address.
    #[must_use]
    pub const fn sender(&self) -> [u8; ADDRESS_BYTES] {
        self.sender
    }

    /// The EIP-155 chain id the signature is bound to.
    #[must_use]
    pub const fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// Nonce, fees, gas limit, and native value.
    #[must_use]
    pub const fn params(&self) -> TransactionParams {
        self.params
    }

    /// The call destination.
    #[must_use]
    pub const fn to(&self) -> [u8; ADDRESS_BYTES] {
        self.to
    }

    /// The calldata.
    #[must_use]
    pub fn input(&self) -> &[u8] {
        &self.input
    }

    /// Checks a zero-value call against a backend-validated target and calldata.
    pub fn validate_call(
        &self,
        chain_id: u64,
        to: [u8; ADDRESS_BYTES],
        input: &[u8],
        sender: [u8; ADDRESS_BYTES],
        params: TransactionParams,
    ) -> Result<(), EvmError> {
        if self.chain_id != chain_id
            || self.to != to
            || self.input != input
            || self.sender != sender
            || self.params != params
        {
            return Err(EvmError::SignedIntentMismatch);
        }
        Ok(())
    }

    /// Requires the same payment, signer, nonce, gas limit, and native value, with increased
    /// fee caps. This local policy does not guarantee that a node will accept the replacement.
    pub fn validate_replacement(&self, previous: &Self) -> Result<(), EvmError> {
        if self.chain_id != previous.chain_id
            || self.sender != previous.sender
            || self.to != previous.to
            || self.input != previous.input
            || self.params.nonce != previous.params.nonce
            || self.params.gas_limit != previous.params.gas_limit
            || self.params.value != previous.params.value
            || !self.params.fees.can_replace(&previous.params.fees)
        {
            return Err(EvmError::SignedIntentMismatch);
        }
        Ok(())
    }
}

/// Signs a backend-validated zero-value EVM call without network I/O.
/// The caller must bind `to` and `input` to its accepted agreement first.
pub fn build_signed_call(
    key: &TransactionKey,
    chain_id: u64,
    to: [u8; ADDRESS_BYTES],
    input: Vec<u8>,
    params: TransactionParams,
) -> Result<SignedTransaction, EvmError> {
    sign_call(key, chain_id, to, input, params)
}

/// Signs one zero-value EIP-1559 call.
fn sign_call(
    key: &TransactionKey,
    chain_id: u64,
    to: [u8; ADDRESS_BYTES],
    input: Vec<u8>,
    params: TransactionParams,
) -> Result<SignedTransaction, EvmError> {
    if params.gas_limit == 0 {
        return Err(EvmError::TransactionEncoding(
            "gas limit is zero".to_owned(),
        ));
    }
    let transaction = TxEip1559 {
        chain_id,
        nonce: params.nonce,
        gas_limit: params.gas_limit,
        max_fee_per_gas: params.fees.max_fee_per_gas,
        max_priority_fee_per_gas: params.fees.max_priority_fee_per_gas,
        to: TxKind::Call(Address::from(to)),
        value: U256::from(params.value),
        access_list: Default::default(),
        input: Bytes::from(input.clone()),
    };
    let signature = key
        .0
        .sign_hash_sync(&transaction.signature_hash())
        .map_err(|_| EvmError::InvalidSigningKey)?;
    let signed = transaction.into_signed(signature);
    let hash = signed.hash().0;
    let raw = TxEnvelope::from(signed).encoded_2718();
    if keccak256(&raw).0 != hash {
        return Err(EvmError::TransactionEncoding(
            "transaction hash is not the hash of its encoding".to_owned(),
        ));
    }
    Ok(SignedTransaction {
        raw,
        hash,
        sender: key.address(),
        chain_id,
        params,
        to,
        input,
    })
}
