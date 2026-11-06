//! The operations behind the `styx-vault` CLI. Each holds the journal lock for its whole run.

use std::fs::OpenOptions;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use super::abi::{self, classify_revert, RevertMeaning};
use super::config::VaultConfig;
use super::digest::{approval_digest, evidence_commitment, payment_hash};
use super::error::{VaultCode, VaultError};
use super::events::find_in_receipt;
use super::journal::{Binding, Journal, PaymentRecord, PaymentRef};
use super::record::{
    EvidenceOpening, ExceptionEvidence, PolicySnapshot, SettlementPointer, VaultPaymentRecord,
    RECORD_SCHEMA,
};
use super::rpc::{receipt_block, receipt_succeeded, receipt_tx_hash, CallOutcome, VaultRpc};
use super::types::{
    parse_hex, ExceptionAuthorization, OwnerSignature, Payment, PendingApproval, PENDING_SCHEMA,
    SIGNATURE_SCHEMA,
};
use super::verify::recover_signer;
use crate::chain::{
    build_signed_call, Eip1559Fees, SignedTransaction, TransactionKey, TransactionParams,
};

const MAX_INVOICE_BYTES: u64 = 1024 * 1024;
const MAX_SIGNATURE_FILE_BYTES: u64 = 4 * 1024;
const SECONDS_PER_DAY: u64 = 86_400;
const RECEIPT_POLL: Duration = Duration::from_millis(500);
/// Headroom over the node's estimate, as a percentage.
const GAS_HEADROOM_PERCENT: u64 = 130;

/// One CLI request.
#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    /// Reports the protocol version. Needs no configuration.
    Version,
    /// Creates and journals a new payment.
    Propose {
        /// Recipient address.
        recipient: String,
        /// Amount in ERC-20 base units, as a decimal string.
        amount: String,
        /// Path to the canonical invoice bytes.
        invoice_file: PathBuf,
        /// Agent-supplied reference shown to the owner as unverified text.
        invoice_reference: String,
        /// Last unix second the payment may execute.
        valid_until: u64,
    },
    /// Writes the pending-approval file for the owner page.
    RequestApproval {
        /// Payment ID.
        payment_id: String,
        /// Last unix second the owner's approval may be used.
        authorization_expiry: u64,
        /// Where to write the pending file.
        pending_file: PathBuf,
        /// V2 approver address. Defaults to the immutable owner.
        #[serde(default)]
        signer: Option<String>,
    },
    /// Submits a journaled payment, or reconciles an earlier attempt.
    Submit {
        /// Payment ID.
        payment_id: String,
        /// The owner's signature file, for an exception.
        #[serde(default)]
        signature_file: Option<PathBuf>,
    },
    /// Reads a payment's on-chain state.
    Status {
        /// Payment ID.
        payment_id: String,
    },
    /// Independently verifies a v2 record with the configured code pin.
    VerifyRecord {
        /// Private record path.
        record_file: PathBuf,
    },
    /// Writes the reviewer record for a settled payment.
    ExportRecord {
        /// Payment ID.
        payment_id: String,
        /// Where to write the record, owner-only. It holds private invoice bytes.
        record_file: PathBuf,
    },
}

/// Runs one request.
pub async fn handle(request: Request) -> Result<Value, VaultError> {
    if super::v2::selected()? {
        return super::v2::service::handle(request).await;
    }
    if matches!(request, Request::Version) {
        return Ok(json!({"status": "ok", "protocol": 1}));
    }
    let config = VaultConfig::from_env()?;
    let rpc = VaultRpc::new(&config.rpc_urls, config.rpc_timeout, config.chain_id)?;
    match request {
        Request::Version => unreachable!("handled above"),
        Request::VerifyRecord { .. } => Err(VaultError::invalid(
            "record verification requires vault version 2",
        )),
        Request::Propose {
            recipient,
            amount,
            invoice_file,
            invoice_reference,
            valid_until,
        } => {
            propose(
                &config,
                &rpc,
                &recipient,
                &amount,
                &invoice_file,
                invoice_reference,
                valid_until,
            )
            .await
        }
        Request::RequestApproval {
            payment_id,
            authorization_expiry,
            pending_file,
            signer,
        } => {
            if signer.is_some() {
                return Err(VaultError::invalid(
                    "signer selection requires vault version 2",
                ));
            }
            request_approval(
                &config,
                &rpc,
                &payment_id,
                authorization_expiry,
                &pending_file,
            )
            .await
        }
        Request::Submit {
            payment_id,
            signature_file,
        } => submit(&config, &rpc, &payment_id, signature_file.as_deref()).await,
        Request::Status { payment_id } => status(&config, &rpc, &payment_id).await,
        Request::ExportRecord {
            payment_id,
            record_file,
        } => export_record(&config, &rpc, &payment_id, &record_file).await,
    }
}

fn parse_payment_id(text: &str) -> Result<[u8; 32], VaultError> {
    parse_hex(text).map_err(|error| VaultError::invalid(format!("payment_id: {error}")))
}

pub(super) fn random<const N: usize>() -> Result<[u8; N], VaultError> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| VaultError::invalid("the system random source failed"))?;
    Ok(bytes)
}

pub(super) fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, VaultError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(maximum + 1).read_to_end(&mut bytes))
        .map_err(|_| VaultError::invalid("a named file could not be read"))?;
    if bytes.len() as u64 > maximum {
        return Err(VaultError::invalid("a named file exceeds its size limit"));
    }
    Ok(bytes)
}

/// Writes a new owner-only file, refusing to replace an existing one.
pub(super) fn write_new_private(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|_| VaultError::invalid("the output file exists or cannot be created"))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| VaultError::invalid("the output file could not be written"))
}

/// Loads the agent's key from an owner-only file holding 32 raw bytes or 64 hex digits.
fn load_agent_key() -> Result<TransactionKey, VaultError> {
    load_agent_key_from(&VaultConfig::agent_key_file()?)
}

pub(super) fn load_agent_key_from(path: &Path) -> Result<TransactionKey, VaultError> {
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(path)
            .map_err(|_| VaultError::invalid("the agent key file cannot be read"))?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(VaultError::invalid("the agent key file must be owner-only"));
        }
    }
    let contents = Zeroizing::new(
        read_bounded(path, 128)
            .map_err(|_| VaultError::invalid("the agent key file cannot be read"))?,
    );
    let bytes: Zeroizing<Vec<u8>> = if contents.len() == 32 {
        Zeroizing::new(contents.to_vec())
    } else {
        let text = std::str::from_utf8(&contents)
            .map_err(|_| VaultError::invalid("the agent key file is malformed"))?
            .trim();
        Zeroizing::new(
            hex::decode(text.strip_prefix("0x").unwrap_or(text))
                .map_err(|_| VaultError::invalid("the agent key file is malformed"))?,
        )
    };
    let key: Zeroizing<[u8; 32]> = Zeroizing::new(
        bytes
            .as_slice()
            .try_into()
            .map_err(|_| VaultError::invalid("the agent key must be 32 bytes"))?,
    );
    TransactionKey::from_bytes(&key).map_err(|_| VaultError::invalid("the agent key is invalid"))
}

/// The vault's current rules.
struct VaultState {
    agent: [u8; 20],
    token: [u8; 20],
    policy_version: u64,
    per_payment_limit: u128,
    daily_limit: u128,
    policy_valid_until: u64,
    paused: bool,
}

async fn read_vault(config: &VaultConfig, rpc: &VaultRpc) -> Result<VaultState, VaultError> {
    let vault = &config.vault;
    let getter = abi::encode_getter;
    let out_of_range = || VaultError::unavailable("a policy value is out of range");
    Ok(VaultState {
        agent: rpc.view_address(vault, &getter("agent")).await?,
        token: rpc.view_address(vault, &getter("token")).await?,
        policy_version: u64::try_from(rpc.view_u128(vault, &getter("policyVersion")).await?)
            .map_err(|_| out_of_range())?,
        per_payment_limit: rpc.view_u128(vault, &getter("perPaymentLimit")).await?,
        daily_limit: rpc.view_u128(vault, &getter("dailyLimit")).await?,
        policy_valid_until: u64::try_from(rpc.view_u128(vault, &getter("policyValidUntil")).await?)
            .map_err(|_| out_of_range())?,
        paused: rpc.view_bool(vault, &getter("paused")).await?,
    })
}

#[allow(clippy::too_many_arguments)]
async fn propose(
    config: &VaultConfig,
    rpc: &VaultRpc,
    recipient: &str,
    amount: &str,
    invoice_file: &Path,
    invoice_reference: String,
    valid_until: u64,
) -> Result<Value, VaultError> {
    let recipient: [u8; 20] = parse_hex(&recipient.to_ascii_lowercase())
        .map_err(|error| VaultError::invalid(format!("recipient: {error}")))?;
    let canonical = !amount.is_empty()
        && amount.bytes().all(|byte| byte.is_ascii_digit())
        && (amount == "0" || !amount.starts_with('0'));
    let amount: u128 = canonical
        .then(|| amount.parse().ok())
        .flatten()
        .ok_or_else(|| VaultError::invalid("amount must be a canonical decimal string"))?;
    let invoice = read_bounded(invoice_file, MAX_INVOICE_BYTES)?;
    let agent_address = load_agent_key()?.address();

    rpc.check_chain().await?;
    let state = read_vault(config, rpc).await?;
    let now = rpc.latest_timestamp().await?;
    let refuse = |reason: &str| Err(VaultError::new(VaultCode::PolicyLimit, reason));
    if state.token != config.token {
        return Err(VaultError::invalid(
            "the vault's token differs from the configured token",
        ));
    }
    if state.agent != agent_address {
        return refuse("this key is not the vault's agent");
    }
    if state.paused {
        return refuse("the vault is paused");
    }
    if now > state.policy_valid_until {
        return refuse("the vault's policy has expired");
    }
    if amount == 0 {
        return refuse("the amount is zero");
    }
    if valid_until < now {
        return refuse("valid_until has already passed");
    }
    if !rpc
        .view_bool(&config.vault, &abi::encode_allowed_recipient(&recipient))
        .await?
    {
        return refuse("the recipient is not on the owner's allowlist");
    }
    let spent = rpc
        .view_u128(
            &config.vault,
            &abi::encode_spent_by_day(now / SECONDS_PER_DAY),
        )
        .await?;
    if spent.saturating_add(amount) > state.daily_limit {
        return refuse("the amount would exceed the daily limit, which no approval can lift");
    }

    let salt = random::<32>()?;
    let payment = Payment {
        payment_id: random::<32>()?,
        agent: agent_address,
        token: state.token,
        recipient,
        amount,
        evidence_commitment: evidence_commitment(&salt, &invoice),
        policy_version: state.policy_version,
        valid_until,
    };
    let hash = payment_hash(&payment);
    let exception_required = amount > state.per_payment_limit;
    let id = PaymentRef::new(&payment.payment_id);
    let journal = Journal::open(&config.state_root)?;
    let _held = journal.lock(&id)?;
    journal.write(&PaymentRecord {
        version: 1,
        id,
        binding: Some(Binding {
            chain_id: config.chain_id,
            vault: config.vault,
            token: config.token,
            agent: agent_address,
        }),
        payment: payment.clone(),
        payment_hash: hash,
        invoice_hex: format!("0x{}", hex::encode(&invoice)),
        salt,
        invoice_reference,
        per_payment_limit: state.per_payment_limit,
        exception_required,
        authorization: None,
        owner_signature: None,
        attempts: Vec::new(),
    })?;
    Ok(json!({
        "status": "ok",
        "payment_id": format!("0x{}", hex::encode(payment.payment_id)),
        "payment_hash": format!("0x{}", hex::encode(hash)),
        "path": if exception_required { "exception_required" } else { "ordinary" },
    }))
}

fn load_record(
    journal: &Journal,
    payment_id: &[u8; 32],
) -> Result<(PaymentRef, PaymentRecord), VaultError> {
    let id = PaymentRef::new(payment_id);
    let record = journal
        .read(&id)?
        .ok_or_else(|| VaultError::invalid("no journaled payment has this ID"))?;
    Ok((id, record))
}

/// Validates retained context before signing, reconciling or exporting. An old signed
/// transaction provides authenticated context; an unsigned legacy record does not.
fn check_binding(
    config: &VaultConfig,
    journal: &Journal,
    record: &mut PaymentRecord,
) -> Result<(), VaultError> {
    let expected = Binding {
        chain_id: config.chain_id,
        vault: config.vault,
        token: config.token,
        agent: record.payment.agent,
    };
    if record.id != PaymentRef::new(&record.payment.payment_id)
        || record.payment_hash != payment_hash(&record.payment)
        || record.payment.token != config.token
        || record
            .binding
            .as_ref()
            .is_some_and(|binding| binding != &expected)
    {
        return Err(VaultError::invalid(
            "journal binding does not match this deployment and payment",
        ));
    }
    // Check every retained transaction before any resend or new attempt. Old versions
    // stored the same blobs, so this also validates legacy records without rewriting them.
    for (index, attempt) in record.attempts.iter().enumerate() {
        let raw = journal.read_attempt(&record.id, index)?;
        let signed = SignedTransaction::from_raw(&raw)
            .map_err(|_| VaultError::invalid("journal binding: invalid retained transaction"))?;
        if signed.hash() != attempt.tx_hash
            || signed.chain_id() != config.chain_id
            || signed.to() != config.vault
            || signed.sender() != record.payment.agent
            || signed.params().value != 0
        {
            return Err(VaultError::invalid(
                "journal binding: retained transaction belongs to another context",
            ));
        }
        // The fixed payment tuple is the first eight ABI words in either call.
        let ordinary = abi::encode_pay(&record.payment);
        let input = signed.input();
        let exception_selector = record
            .authorization
            .as_ref()
            .map(|a| abi::encode_pay_with_exception(&record.payment, a, &[0; 65]));
        let selector_ok = input.get(..4) == ordinary.get(..4)
            || exception_selector
                .as_ref()
                .is_some_and(|encoded| input.get(..4) == encoded.get(..4));
        if !selector_ok || input.get(4..260) != ordinary.get(4..260) {
            return Err(VaultError::invalid(
                "journal binding: retained transaction names a different payment",
            ));
        }
    }
    if record.binding.is_none() {
        if record.attempts.is_empty() {
            return Err(VaultError::invalid("legacy journal binding is unknown: no signed attempt proves its original vault; leave this record unchanged for operator review"));
        }
        record.binding = Some(expected);
        journal.write(record)?;
    }
    Ok(())
}

fn check_agent(record: &PaymentRecord) -> Result<(), VaultError> {
    if load_agent_key()?.address() != record.payment.agent {
        return Err(VaultError::invalid(
            "journal binding does not match the configured agent",
        ));
    }
    Ok(())
}

async fn request_approval(
    config: &VaultConfig,
    rpc: &VaultRpc,
    payment_id: &str,
    authorization_expiry: u64,
    pending_file: &Path,
) -> Result<Value, VaultError> {
    let payment_id = parse_payment_id(payment_id)?;
    let journal = Journal::open(&config.state_root)?;
    let _held = journal.lock(&PaymentRef::new(&payment_id))?;
    let (_, mut record) = load_record(&journal, &payment_id)?;
    check_binding(config, &journal, &mut record)?;
    check_agent(&record)?;
    if !record.exception_required {
        return Err(VaultError::invalid(
            "this payment is within the limit and needs no owner approval",
        ));
    }
    rpc.check_chain().await?;
    let state = read_vault(config, rpc).await?;
    if state.policy_version != record.payment.policy_version {
        return Err(VaultError::new(
            VaultCode::PolicyVersionChanged,
            "the policy changed after this payment was proposed; propose it again",
        ));
    }
    // A repeated request keeps the same nonce, so one payment has one live authorization.
    let nonce = match &record.authorization {
        Some(existing) => existing.approval_nonce,
        None => u128::from_be_bytes(random::<16>()?),
    };
    let authorization = ExceptionAuthorization {
        payment_hash: record.payment_hash,
        approval_nonce: nonce,
        authorization_expiry,
    };
    record.authorization = Some(authorization.clone());
    journal.write(&record)?;
    let pending = PendingApproval {
        schema: PENDING_SCHEMA.to_owned(),
        chain_id: config.chain_id,
        vault: config.vault,
        payment: record.payment.clone(),
        authorization: authorization.clone(),
        invoice_reference: record.invoice_reference.clone(),
        exceeded_rule: "perPaymentLimit".to_owned(),
        per_payment_limit: state.per_payment_limit,
    };
    let encoded = serde_json::to_vec_pretty(&pending)
        .map_err(|_| VaultError::invalid("the pending approval could not be encoded"))?;
    write_new_private(pending_file, &encoded)?;
    Ok(json!({
        "status": "ok",
        "pending_file": pending_file,
        "approval_digest": format!(
            "0x{}",
            hex::encode(approval_digest(config.chain_id, &config.vault, &authorization))
        ),
    }))
}

/// Loads and checks the owner's signature file against this payment's exact digest.
fn load_signature(
    config: &VaultConfig,
    record: &PaymentRecord,
    path: &Path,
) -> Result<[u8; 65], VaultError> {
    let authorization = record.authorization.as_ref().ok_or_else(|| {
        VaultError::new(
            VaultCode::OwnerApprovalRequired,
            "request the owner's approval first",
        )
    })?;
    let file: OwnerSignature =
        serde_json::from_slice(&read_bounded(path, MAX_SIGNATURE_FILE_BYTES)?)
            .map_err(|_| VaultError::invalid("the signature file is malformed"))?;
    let digest = approval_digest(config.chain_id, &config.vault, authorization);
    if file.schema != SIGNATURE_SCHEMA
        || file.payment_id != record.payment.payment_id
        || file.approval_digest != digest
    {
        return Err(VaultError::new(
            VaultCode::OwnerApprovalRequired,
            "the signature file does not approve this exact payment",
        ));
    }
    Ok(file.signature)
}

pub(super) fn revert_error(data: &[u8]) -> VaultError {
    match classify_revert(data) {
        RevertMeaning::Policy(name) => {
            VaultError::new(VaultCode::PolicyLimit, format!("the vault refused: {name}"))
        }
        RevertMeaning::Approval(name) => VaultError::new(
            VaultCode::OwnerApprovalRequired,
            format!("the vault refused: {name}"),
        ),
        RevertMeaning::PolicyVersion => VaultError::new(
            VaultCode::PolicyVersionChanged,
            "the policy changed after this payment was proposed; propose it again",
        ),
        RevertMeaning::AlreadySettled => VaultError::new(
            VaultCode::PaymentAlreadySettled,
            "the vault already consumed this payment ID",
        ),
        RevertMeaning::Other(name) => {
            VaultError::invalid(format!("the simulated call reverted: {name}"))
        }
    }
}

fn tx_hex(hash: &[u8]) -> String {
    format!("0x{}", hex::encode(hash))
}

/// Confirms the exact payment in a canonical receipt from this vault and agent.
async fn matching_receipt(
    config: &VaultConfig,
    rpc: &VaultRpc,
    record: &PaymentRecord,
    tx_hash: &[u8; 32],
    receipt: &Value,
) -> bool {
    if receipt_succeeded(receipt) != Some(true)
        || receipt_tx_hash(receipt) != Some(*tx_hash)
        || receipt["to"].as_str().and_then(|s| parse_hex::<20>(s).ok()) != Some(config.vault)
        || receipt["from"]
            .as_str()
            .and_then(|s| parse_hex::<20>(s).ok())
            != Some(record.payment.agent)
    {
        return false;
    }
    let Some(found) = find_in_receipt(receipt, &config.vault, &record.payment.payment_id) else {
        return false;
    };
    let p = &record.payment;
    let e = found.event;
    if e.recipient != p.recipient
        || e.amount != p.amount
        || e.payment_hash != record.payment_hash
        || e.evidence_commitment != p.evidence_commitment
        || e.policy_version != p.policy_version
    {
        return false;
    }
    if e.exception {
        if record
            .authorization
            .as_ref()
            .map(|a| approval_digest(config.chain_id, &config.vault, a))
            != Some(e.approval_digest)
        {
            return false;
        }
    } else if e.approval_digest != [0; 32] {
        return false;
    }
    let Some(block) = receipt_block(receipt) else {
        return false;
    };
    match rpc.canonical_block_hash(block).await {
        Ok(hash) => {
            receipt["blockHash"]
                .as_str()
                .and_then(|s| parse_hex::<32>(s).ok())
                == Some(hash)
        }
        Err(_) => false,
    }
}

/// A receipt without the exact canonical event leaves the outcome unknown.
async fn await_outcome(
    config: &VaultConfig,
    rpc: &VaultRpc,
    record: &PaymentRecord,
    tx_hash: &[u8; 32],
) -> Value {
    let started = Instant::now();
    loop {
        if let Ok(Some(receipt)) = rpc.receipt(tx_hash).await {
            let state = if matching_receipt(config, rpc, record, tx_hash, &receipt).await {
                "settled"
            } else if receipt_succeeded(&receipt) == Some(false)
                && receipt_tx_hash(&receipt) == Some(*tx_hash)
                && receipt_block(&receipt).is_some()
            {
                "reverted"
            } else {
                "unknown"
            };
            return json!({"status":"ok", "state":state, "tx_hash":tx_hex(tx_hash)});
        }
        if started.elapsed() >= config.receipt_timeout {
            return json!({"status":"ok", "state":"unknown", "tx_hash":tx_hex(tx_hash)});
        }
        tokio::time::sleep(RECEIPT_POLL).await;
    }
}

async fn submit(
    config: &VaultConfig,
    rpc: &VaultRpc,
    payment_id: &str,
    signature_file: Option<&Path>,
) -> Result<Value, VaultError> {
    let payment_id = parse_payment_id(payment_id)?;
    let journal = Journal::open(&config.state_root)?;
    let id = PaymentRef::new(&payment_id);
    let _held = journal.lock(&id)?;
    let (_, mut record) = load_record(&journal, &payment_id)?;
    check_binding(config, &journal, &mut record)?;
    check_agent(&record)?;
    rpc.check_chain().await?;

    let consumed = rpc
        .view_bool(&config.vault, &abi::encode_consumed_payment(&payment_id))
        .await?;
    if consumed {
        if rpc
            .view_word(&config.vault, &abi::encode_payment_hash_by_id(&payment_id))
            .await?
            != record.payment_hash
        {
            return Err(VaultError::invalid(
                "payment ID was consumed by a different payment",
            ));
        }
        return match record.attempts.last() {
            Some(attempt) => Ok(await_outcome(config, rpc, &record, &attempt.tx_hash).await),
            None => Err(VaultError::new(
                VaultCode::PaymentAlreadySettled,
                "the vault already consumed this payment ID",
            )),
        };
    }

    // An earlier attempt may still land, so it is reconciled first. Only a visible revert
    // permits signing a new transaction, and that one keeps the same payment ID.
    if let Some(attempt) = record.attempts.last() {
        let tx_hash = attempt.tx_hash;
        match rpc.receipt(&tx_hash).await? {
            Some(receipt)
                if receipt_succeeded(&receipt) == Some(false)
                    && receipt_tx_hash(&receipt) == Some(tx_hash)
                    && receipt_block(&receipt).is_some() => {}
            Some(_) => {
                return Ok(json!({"status": "ok", "state": "unknown", "tx_hash": tx_hex(&tx_hash)}))
            }
            None => {
                let raw = journal.read_attempt(&id, record.attempts.len() - 1)?;
                // A failed resend leaves the outcome unknown; the poll below reports it.
                let _ = rpc.send_raw(&raw).await;
                return Ok(await_outcome(config, rpc, &record, &tx_hash).await);
            }
        }
    }

    let signature = match signature_file {
        Some(path) => {
            let signature = load_signature(config, &record, path)?;
            record.owner_signature = Some(format!("0x{}", hex::encode(signature)));
            journal.write(&record)?;
            Some(signature)
        }
        None => None,
    };
    let input = match (&signature, &record.authorization) {
        (Some(signature), Some(authorization)) => {
            abi::encode_pay_with_exception(&record.payment, authorization, signature)
        }
        (None, _) if record.exception_required => {
            return Err(VaultError::new(
                VaultCode::OwnerApprovalRequired,
                "this amount exceeds the per-payment limit and needs the owner's signature",
            ));
        }
        _ => abi::encode_pay(&record.payment),
    };

    let key = load_agent_key()?;
    let agent = key.address();
    match rpc.call(Some(&agent), &config.vault, &input).await? {
        CallOutcome::Returned(_) => {}
        CallOutcome::Reverted(data) => return Err(revert_error(&data)),
    }
    let estimate = rpc.estimate_gas(&agent, &config.vault, &input).await?;
    let (max_fee, priority_fee) = rpc.fees().await?;
    let params = TransactionParams {
        nonce: rpc.pending_nonce(&agent).await?,
        fees: Eip1559Fees::new(max_fee, priority_fee)
            .map_err(|_| VaultError::unavailable("the RPC's fee values are unusable"))?,
        gas_limit: estimate.saturating_mul(GAS_HEADROOM_PERCENT) / 100,
        value: 0,
    };
    let signed = build_signed_call(&key, config.chain_id, config.vault, input, params)
        .map_err(|_| VaultError::invalid("the transaction could not be signed"))?;
    let tx_hash = signed.hash();
    journal.store_attempt(&mut record, signed.raw(), tx_hash)?;
    // The bytes are durable, so a failed send leaves a state the next call can reconcile.
    let _ = rpc.send_raw(signed.raw()).await;
    Ok(await_outcome(config, rpc, &record, &tx_hash).await)
}

async fn status(
    config: &VaultConfig,
    rpc: &VaultRpc,
    payment_id: &str,
) -> Result<Value, VaultError> {
    let payment_id = parse_payment_id(payment_id)?;
    let journal = Journal::open(&config.state_root)?;
    let reference = PaymentRef::new(&payment_id);
    let _held = journal.lock(&reference)?;
    let mut retained = journal.read(&reference)?;
    if let Some(record) = retained.as_mut() {
        check_binding(config, &journal, record)?;
    }
    let unavailable = |_| json!({"status": "ok", "state": "unavailable"});
    if let Err(error) = rpc.check_chain().await {
        return Ok(unavailable(error));
    }
    let consumed = match rpc
        .view_bool(&config.vault, &abi::encode_consumed_payment(&payment_id))
        .await
    {
        Ok(consumed) => consumed,
        Err(error) => return Ok(unavailable(error)),
    };
    if !consumed {
        return Ok(json!({"status": "ok", "state": "not_settled"}));
    }
    let Some(record) = retained else {
        return Ok(json!({"status":"ok", "state":"unknown"}));
    };
    let hash = rpc
        .view_word(&config.vault, &abi::encode_payment_hash_by_id(&payment_id))
        .await?;
    if hash != record.payment_hash {
        return Err(VaultError::invalid(
            "payment ID was consumed by a different payment",
        ));
    }
    if let Some(attempt) = record.attempts.last() {
        if let Ok(Some(receipt)) = rpc.receipt(&attempt.tx_hash).await {
            if matching_receipt(config, rpc, &record, &attempt.tx_hash, &receipt).await {
                return Ok(json!({"status":"ok", "state":"settled", "payment_hash":tx_hex(&hash)}));
            }
        }
    }
    Ok(json!({"status":"ok", "state":"unknown", "payment_hash":tx_hex(&hash)}))
}

async fn export_record(
    config: &VaultConfig,
    rpc: &VaultRpc,
    payment_id: &str,
    record_file: &Path,
) -> Result<Value, VaultError> {
    let payment_id = parse_payment_id(payment_id)?;
    let journal = Journal::open(&config.state_root)?;
    let id = PaymentRef::new(&payment_id);
    let _held = journal.lock(&id)?;
    let (_, mut record) = load_record(&journal, &payment_id)?;
    check_binding(config, &journal, &mut record)?;
    let attempt = record
        .attempts
        .last()
        .ok_or_else(|| VaultError::invalid("this payment has not been submitted"))?;
    rpc.check_chain().await?;
    let receipt = rpc
        .receipt(&attempt.tx_hash)
        .await?
        .ok_or_else(|| VaultError::unavailable("no receipt is visible for this payment yet"))?;
    if !matching_receipt(config, rpc, &record, &attempt.tx_hash, &receipt).await {
        return Err(VaultError::unavailable(
            "the receipt does not prove this exact payment",
        ));
    }
    let found = find_in_receipt(&receipt, &config.vault, &payment_id)
        .ok_or_else(|| VaultError::invalid("the receipt has no matching vault event"))?;
    let block_number = receipt_block(&receipt)
        .ok_or_else(|| VaultError::unavailable("the receipt has no block number"))?;
    let exception = if found.event.exception {
        let authorization = record
            .authorization
            .as_ref()
            .ok_or_else(|| VaultError::invalid("the journal lost this exception's approval"))?;
        let signature = record
            .owner_signature
            .as_deref()
            .ok_or_else(|| VaultError::invalid("the journal lost this exception's signature"))
            .and_then(|text| parse_hex::<65>(text).map_err(VaultError::invalid))?;
        let digest = approval_digest(config.chain_id, &config.vault, authorization);
        if recover_signer(&digest, &signature).is_none() {
            return Err(VaultError::invalid(
                "the stored owner signature is malformed",
            ));
        }
        Some(ExceptionEvidence {
            approval_nonce: authorization.approval_nonce,
            authorization_expiry: authorization.authorization_expiry,
            approval_digest: digest,
            owner_signature: signature,
        })
    } else {
        None
    };
    let exported = VaultPaymentRecord {
        schema: RECORD_SCHEMA.to_owned(),
        chain_id: config.chain_id,
        vault: config.vault,
        vault_code_hash: rpc.code_hash(&config.vault).await?,
        payment: record.payment.clone(),
        policy: PolicySnapshot {
            policy_version: found.event.policy_version,
            per_payment_limit: found.event.per_payment_limit,
            daily_limit: found.event.daily_limit,
            day: found.event.day,
            day_spent_after: found.event.day_spent_after,
        },
        exception,
        evidence: EvidenceOpening {
            invoice_hex: record.invoice_hex.clone(),
            salt: record.salt,
        },
        settlement: SettlementPointer {
            tx_hash: attempt.tx_hash,
            block_number,
            log_index: found.log_index,
        },
    };
    let encoded = Zeroizing::new(
        serde_json::to_vec_pretty(&exported)
            .map_err(|_| VaultError::invalid("the record could not be encoded"))?,
    );
    write_new_private(record_file, &encoded)?;
    Ok(json!({"status": "ok", "record_file": record_file}))
}

#[cfg(test)]
mod settlement_tests {
    use super::*;

    #[tokio::test]
    async fn successful_receipt_without_payment_event_is_unknown() {
        let url = super::super::security_tests::server(|method| match method {
            "eth_chainId" => json!("0x7a69"),
            "eth_getTransactionReceipt" => json!({"status":"0x1", "blockNumber":"0x1", "logs":[],
                "transactionHash":tx_hex(&[3;32]), "to":tx_hex(&[1;20]), "from":tx_hex(&[4;20]), "blockHash":tx_hex(&[7;32])}),
            _ => json!(null),
        });
        let config = VaultConfig {
            chain_id: 31337,
            rpc_urls: vec![url.clone()],
            vault: [1; 20],
            token: [2; 20],
            state_root: PathBuf::new(),
            receipt_timeout: Duration::ZERO,
            rpc_timeout: Duration::from_secs(1),
        };
        let rpc = VaultRpc::new(&[url], Duration::from_secs(1), 31337).unwrap();
        let record = retained_record();
        let response = await_outcome(&config, &rpc, &record, &[3; 32]).await;
        assert_eq!(response["state"], "unknown");
    }
    fn retained_record() -> PaymentRecord {
        let payment = Payment {
            payment_id: [3; 32],
            agent: [4; 20],
            token: [2; 20],
            recipient: [5; 20],
            amount: 1,
            evidence_commitment: [6; 32],
            policy_version: 1,
            valid_until: u64::MAX,
        };
        PaymentRecord {
            version: 1,
            id: PaymentRef::new(&payment.payment_id),
            binding: None,
            payment_hash: payment_hash(&payment),
            payment,
            invoice_hex: String::new(),
            salt: [0; 32],
            invoice_reference: String::new(),
            per_payment_limit: 1,
            exception_required: false,
            authorization: None,
            owner_signature: None,
            attempts: vec![],
        }
    }

    #[test]
    fn v1_journal_binding_checks_all_four_context_fields_before_network_access() {
        let directory = tempfile::tempdir().unwrap();
        let journal = Journal::open(directory.path()).unwrap();
        let config = VaultConfig {
            chain_id: 31337,
            rpc_urls: vec![],
            vault: [1; 20],
            token: [2; 20],
            state_root: directory.path().to_path_buf(),
            receipt_timeout: Duration::ZERO,
            rpc_timeout: Duration::ZERO,
        };
        let mut record = retained_record();
        record.binding = Some(Binding {
            chain_id: config.chain_id,
            vault: config.vault,
            token: config.token,
            agent: record.payment.agent,
        });
        assert!(check_binding(&config, &journal, &mut record.clone()).is_ok());
        for field in 0..4 {
            let mut changed = record.clone();
            let binding = changed.binding.as_mut().unwrap();
            match field {
                0 => binding.chain_id += 1,
                1 => binding.vault[0] ^= 1,
                2 => binding.token[0] ^= 1,
                _ => binding.agent[0] ^= 1,
            }
            assert!(
                check_binding(&config, &journal, &mut changed).is_err(),
                "context field {field}"
            );
        }
    }

    #[tokio::test]
    async fn settlement_requires_the_exact_event_and_canonical_receipt() {
        let url = super::super::security_tests::server(|method| match method {
            "eth_chainId" => json!("0x7a69"),
            "eth_getBlockByNumber" => json!({"hash":tx_hex(&[7;32])}),
            _ => json!(null),
        });
        let config = VaultConfig {
            chain_id: 31337,
            rpc_urls: vec![url.clone()],
            vault: [1; 20],
            token: [2; 20],
            state_root: PathBuf::new(),
            receipt_timeout: Duration::ZERO,
            rpc_timeout: Duration::from_secs(1),
        };
        let rpc = VaultRpc::new(&[url], Duration::from_secs(1), 31337).unwrap();
        let record = retained_record();
        let mut recipient = [0; 32];
        recipient[12..].copy_from_slice(&record.payment.recipient);
        let uint = |value: u128| {
            let mut word = [0; 32];
            word[16..].copy_from_slice(&value.to_be_bytes());
            word
        };
        let words = [
            uint(1),
            record.payment_hash,
            record.payment.evidence_commitment,
            uint(1),
            uint(1),
            uint(10),
            uint(0),
            uint(1),
            uint(0),
            [0; 32],
        ];
        let data: Vec<u8> = words.into_iter().flatten().collect();
        let receipt = json!({"status":"0x1", "blockNumber":"0x1", "blockHash":tx_hex(&[7;32]),
            "transactionHash":tx_hex(&[3;32]), "to":tx_hex(&config.vault), "from":tx_hex(&record.payment.agent),
            "logs":[{"address":tx_hex(&config.vault), "logIndex":"0x0",
                "topics":[tx_hex(&super::super::events::payment_executed_topic()),tx_hex(&record.payment.payment_id),tx_hex(&recipient)],"data":tx_hex(&data)}]});
        assert!(matching_receipt(&config, &rpc, &record, &[3; 32], &receipt).await);
        for field in [
            "transactionHash",
            "to",
            "from",
            "blockHash",
            "blockNumber",
            "status",
        ] {
            let mut changed = receipt.clone();
            changed[field] = json!(null);
            assert!(
                !matching_receipt(&config, &rpc, &record, &[3; 32], &changed).await,
                "{field}"
            );
        }
        for word in [0, 1, 2, 3, 8, 9] {
            let mut changed = receipt.clone();
            let mut bad = data.clone();
            bad[word * 32 + 31] ^= 1;
            changed["logs"][0]["data"] = json!(tx_hex(&bad));
            assert!(
                !matching_receipt(&config, &rpc, &record, &[3; 32], &changed).await,
                "event word {word}"
            );
        }
        for field in ["address", "topics"] {
            let mut changed = receipt.clone();
            changed["logs"][0][field] = json!(null);
            assert!(
                !matching_receipt(&config, &rpc, &record, &[3; 32], &changed).await,
                "log {field}"
            );
        }
        let mut missing = receipt.clone();
        missing["logs"] = json!([]);
        assert!(!matching_receipt(&config, &rpc, &record, &[3; 32], &missing).await);
    }
}
