//! The operations behind the `erebus-vault` CLI. Each holds the journal lock for its whole run.

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
use super::journal::{Journal, PaymentRecord, PaymentRef};
use super::record::{
    EvidenceOpening, ExceptionEvidence, PolicySnapshot, SettlementPointer, VaultPaymentRecord,
    RECORD_SCHEMA,
};
use super::rpc::{receipt_block, receipt_succeeded, CallOutcome, VaultRpc};
use super::types::{
    parse_hex, ExceptionAuthorization, OwnerSignature, Payment, PendingApproval, PENDING_SCHEMA,
    SIGNATURE_SCHEMA,
};
use super::verify::recover_signer;
use crate::chain::{build_signed_call, Eip1559Fees, TransactionKey, TransactionParams};

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
    if matches!(request, Request::Version) {
        return Ok(json!({"status": "ok", "protocol": 1}));
    }
    let config = VaultConfig::from_env()?;
    let rpc = VaultRpc::new(&config.rpc_urls, config.rpc_timeout, config.chain_id)?;
    match request {
        Request::Version => unreachable!("handled above"),
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
        } => {
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

fn random<const N: usize>() -> Result<[u8; N], VaultError> {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| VaultError::invalid("the system random source failed"))?;
    Ok(bytes)
}

fn read_bounded(path: &Path, maximum: u64) -> Result<Vec<u8>, VaultError> {
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
fn write_new_private(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
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
    let path = VaultConfig::agent_key_file()?;
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(&path)
            .map_err(|_| VaultError::invalid("the agent key file cannot be read"))?;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(VaultError::invalid("the agent key file must be owner-only"));
        }
    }
    let contents = Zeroizing::new(
        read_bounded(&path, 128)
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

fn revert_error(data: &[u8]) -> VaultError {
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

fn tx_hex(hash: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(hash))
}

/// Waits for a receipt, returning the state to report. Running out of time is `unknown`.
async fn await_outcome(config: &VaultConfig, rpc: &VaultRpc, tx_hash: &[u8; 32]) -> Value {
    let started = Instant::now();
    loop {
        if let Ok(Some(receipt)) = rpc.receipt(tx_hash).await {
            return match receipt_succeeded(&receipt) {
                Some(true) => {
                    json!({"status": "ok", "state": "settled", "tx_hash": tx_hex(tx_hash)})
                }
                Some(false) => {
                    json!({"status": "ok", "state": "reverted", "tx_hash": tx_hex(tx_hash)})
                }
                None => json!({"status": "ok", "state": "unknown", "tx_hash": tx_hex(tx_hash)}),
            };
        }
        if started.elapsed() >= config.receipt_timeout {
            return json!({"status": "ok", "state": "unknown", "tx_hash": tx_hex(tx_hash)});
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
    rpc.check_chain().await?;

    let consumed = rpc
        .view_bool(&config.vault, &abi::encode_consumed_payment(&payment_id))
        .await?;
    if consumed {
        return match record.attempts.last() {
            Some(attempt) => {
                Ok(json!({"status": "ok", "state": "settled", "tx_hash": tx_hex(&attempt.tx_hash)}))
            }
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
            Some(receipt) if receipt_succeeded(&receipt) == Some(false) => {}
            Some(_) => {
                return Ok(json!({"status": "ok", "state": "unknown", "tx_hash": tx_hex(&tx_hash)}))
            }
            None => {
                let raw = journal.read_attempt(&id, record.attempts.len() - 1)?;
                // A failed resend leaves the outcome unknown; the poll below reports it.
                let _ = rpc.send_raw(&raw).await;
                return Ok(await_outcome(config, rpc, &tx_hash).await);
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
    Ok(await_outcome(config, rpc, &tx_hash).await)
}

async fn status(
    config: &VaultConfig,
    rpc: &VaultRpc,
    payment_id: &str,
) -> Result<Value, VaultError> {
    let payment_id = parse_payment_id(payment_id)?;
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
    match rpc
        .view_word(&config.vault, &abi::encode_payment_hash_by_id(&payment_id))
        .await
    {
        Ok(hash) => Ok(json!({
            "status": "ok",
            "state": "settled",
            "payment_hash": format!("0x{}", hex::encode(hash)),
        })),
        Err(error) => Ok(unavailable(error)),
    }
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
    let (_, record) = load_record(&journal, &payment_id)?;
    let attempt = record
        .attempts
        .last()
        .ok_or_else(|| VaultError::invalid("this payment has not been submitted"))?;
    rpc.check_chain().await?;
    let receipt = rpc
        .receipt(&attempt.tx_hash)
        .await?
        .ok_or_else(|| VaultError::unavailable("no receipt is visible for this payment yet"))?;
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
