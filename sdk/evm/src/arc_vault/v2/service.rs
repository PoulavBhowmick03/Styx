//! Versioned CLI operations. Retained state is checked before every retry and broadcast.
use super::super::{
    error::{VaultCode, VaultError},
    rpc::{receipt_block, receipt_succeeded, receipt_tx_hash, CallOutcome, VaultRpc},
    service::{
        load_agent_key_from, random, read_bounded, revert_error, write_new_private, Request,
    },
};
use super::{
    abi,
    config::Config,
    digest,
    events::{find_in_receipt, LocatedPayment},
    journal::{Binding, Journal, PaymentRecord, PaymentRef},
    types::*,
};
use crate::chain::{build_signed_call, Eip1559Fees, TransactionKey, TransactionParams};
use serde_json::{json, Value};
use std::time::Instant;

fn hex<const N: usize>(value: &[u8; N]) -> String {
    format!("0x{}", hex::encode(value))
}
fn invalid(message: &str) -> VaultError {
    VaultError::invalid(message)
}
fn policy(message: &str) -> VaultError {
    VaultError::new(VaultCode::PolicyLimit, message)
}
fn approval(message: &str) -> VaultError {
    VaultError::new(VaultCode::OwnerApprovalRequired, message)
}
fn key(config: &Config) -> Result<TransactionKey, VaultError> {
    load_agent_key_from(
        config
            .agent_key_file
            .as_deref()
            .ok_or_else(|| invalid("STYX_VAULT_AGENT_KEY_FILE must be set"))?,
    )
}
fn id(text: &str) -> Result<[u8; 32], VaultError> {
    parse_hex(text).map_err(VaultError::invalid)
}
fn binding(config: &Config, agent: [u8; 20]) -> Binding {
    Binding {
        chain_id: config.chain_id,
        vault: config.vault,
        token: config.token,
        code_hash: config.code_hash,
        agent,
    }
}
pub(super) fn check_binding(config: &Config, record: &PaymentRecord) -> Result<(), VaultError> {
    if record.binding != binding(config, record.payment.agent)
        || record.payment.token != config.token
        || record.payment_hash != digest::payment_hash(&record.payment)
        || record.id != PaymentRef::new(&record.payment.payment_id)
    {
        return Err(invalid(
            "retained payment belongs to another deployment or is inconsistent",
        ));
    }
    Ok(())
}
async fn deployment(config: &Config, rpc: &VaultRpc) -> Result<(), VaultError> {
    rpc.check_chain().await?;
    if rpc.code_hash(&config.vault).await? != config.code_hash {
        return Err(invalid(
            "STYX vault code hash differs from the configured pin",
        ));
    }
    if rpc
        .view_u128(&config.vault, &abi::encode_getter("contractVersion"))
        .await?
        != 2
    {
        return Err(invalid("configured contract is not vault version 2"));
    }
    if rpc
        .view_address(&config.vault, &abi::encode_getter("token"))
        .await?
        != config.token
    {
        return Err(invalid("STYX vault token mismatch"));
    }
    Ok(())
}
struct Policy {
    version: u64,
    per: u128,
    daily: u128,
    until: u64,
    enabled: bool,
}
async fn read_policy(
    config: &Config,
    rpc: &VaultRpc,
    agent: &[u8; 20],
) -> Result<Policy, VaultError> {
    let bytes = rpc
        .view(
            &config.vault,
            &abi::call("agentPolicy(address)", &[abi::address(agent)]),
        )
        .await?;
    let malformed = || VaultError::unavailable("malformed or out-of-range agent policy");
    if bytes.len() != 160 {
        return Err(malformed());
    }
    Ok(Policy {
        version: abi::word_u64(&bytes[..32]).ok_or_else(malformed)?,
        per: abi::word_u128(&bytes[32..64]).ok_or_else(malformed)?,
        daily: abi::word_u128(&bytes[64..96]).ok_or_else(malformed)?,
        until: abi::word_u64(&bytes[96..128]).ok_or_else(malformed)?,
        enabled: match abi::word_u128(&bytes[128..]) {
            Some(0) => false,
            Some(1) => true,
            _ => return Err(malformed()),
        },
    })
}
async fn signer_version(
    config: &Config,
    rpc: &VaultRpc,
    signer: &[u8; 20],
) -> Result<u64, VaultError> {
    let bytes = rpc
        .view(
            &config.vault,
            &abi::call("approverState(address)", &[abi::address(signer)]),
        )
        .await?;
    if bytes.len() != 64 {
        return Err(VaultError::unavailable("malformed approver state"));
    }
    if abi::word_u128(&bytes[32..]) != Some(1) {
        return Err(approval("this signer is not a current approver or owner"));
    }
    abi::word_u64(&bytes[..32])
        .ok_or_else(|| VaultError::unavailable("signer version out of range"))
}
fn map_revert(data: &[u8]) -> VaultError {
    use crate::abi::selector;
    for (name, is_approval) in [
        ("RecipientVersionMismatch", false),
        ("VaultDailyLimitExceeded", false),
        ("ApproverNotAllowed", true),
        ("SignerVersionMismatch", true),
    ] {
        if data.starts_with(&selector(&format!("{name}()"))) {
            return if is_approval {
                approval(name)
            } else {
                policy(name)
            };
        }
    }
    revert_error(data)
}
pub async fn handle(request: Request) -> Result<Value, VaultError> {
    if matches!(request, Request::Version) {
        return Ok(json!({"status":"ok","protocol":1,"contract_version":2}));
    }
    handle_with_config(request, Config::from_env()?).await
}
pub async fn handle_with_config(request: Request, config: Config) -> Result<Value, VaultError> {
    let rpc = VaultRpc::new(&config.rpc_urls, config.rpc_timeout, config.chain_id)?;
    deployment(&config, &rpc).await?;
    if let Request::VerifyRecord { record_file } = request {
        let record = serde_json::from_slice(&read_bounded(&record_file, 2 * 1024 * 1024)?)
            .map_err(|_| invalid("invalid v2 payment record"))?;
        return Ok(
            json!({"status":"ok","report":super::verify::verify_record(&record,&rpc,&config.code_hash).await}),
        );
    }
    let journal = Journal::open(&config.state_root)?;
    match request {
        Request::Version => Ok(json!({"status":"ok","protocol":1,"contract_version":2})),
        Request::Propose {
            recipient,
            amount,
            invoice_file,
            invoice_reference,
            valid_until,
        } => {
            let agent = key(&config)?.address();
            let recipient = id_address(&recipient)?;
            let amount: u128 = if !amount.is_empty()
                && amount.bytes().all(|b| b.is_ascii_digit())
                && (amount == "0" || !amount.starts_with('0'))
            {
                amount.parse().map_err(|_| invalid("amount out of range"))?
            } else {
                return Err(invalid("amount must be a canonical decimal string"));
            };
            let rules = read_policy(&config, &rpc, &agent).await?;
            let now = rpc.latest_timestamp().await?;
            if !rules.enabled {
                return Err(policy("agent is disabled"));
            }
            if now > rules.until || now > valid_until {
                return Err(policy("agent policy or payment has expired"));
            }
            if amount == 0 {
                return Err(policy("zero amount"));
            }
            if invoice_reference.len() > 4096 {
                return Err(invalid("invoice reference too long"));
            }
            if rpc
                .view_bool(&config.vault, &abi::encode_getter("paused"))
                .await?
            {
                return Err(policy("vault is paused"));
            }
            if !rpc
                .view_bool(&config.vault, &abi::encode_allowed_recipient(&recipient))
                .await?
            {
                return Err(policy("recipient is not allowed"));
            }
            let agent_spent = rpc
                .view_u128(
                    &config.vault,
                    &abi::call(
                        "spentByAgentDay(address,uint256)",
                        &[abi::address(&agent), abi::uint((now / 86400).into())],
                    ),
                )
                .await?;
            let spent = rpc
                .view_u128(&config.vault, &abi::encode_spent_by_day(now / 86400))
                .await?;
            let cap = rpc
                .view_u128(&config.vault, &abi::encode_getter("vaultDailyLimit"))
                .await?;
            if agent_spent > rules.daily
                || amount > rules.daily - agent_spent
                || spent > cap
                || amount > cap - spent
            {
                return Err(policy(
                    "payment exceeds a daily cap; no exception can lift it",
                ));
            }
            let recipient_version = rpc
                .view_u128(
                    &config.vault,
                    &abi::call("recipientVersion(address)", &[abi::address(&recipient)]),
                )
                .await?
                .try_into()
                .map_err(|_| invalid("recipient version out of range"))?;
            let invoice = read_bounded(&invoice_file, 1024 * 1024)?;
            let salt = random::<32>()?;
            let payment = Payment {
                payment_id: random::<32>()?,
                agent,
                token: config.token,
                recipient,
                amount,
                evidence_commitment: digest::evidence_commitment(&salt, &invoice),
                policy_version: rules.version,
                recipient_version,
                valid_until,
            };
            let record = PaymentRecord {
                version: 1,
                id: PaymentRef::new(&payment.payment_id),
                binding: binding(&config, agent),
                payment_hash: digest::payment_hash(&payment),
                payment: payment.clone(),
                invoice_hex: format!("0x{}", hex::encode(invoice)),
                salt,
                invoice_reference,
                per_payment_limit: rules.per,
                exception_required: amount > rules.per,
                authorization: None,
                signature: None,
                attempts: Vec::new(),
            };
            let _held = journal.lock(&record.id)?;
            journal.write(&record)?;
            Ok(
                json!({"status":"ok","payment_id":hex(&payment.payment_id),"payment_hash":hex(&record.payment_hash),"path":if record.exception_required {"exception_required"}else{"ordinary"}}),
            )
        }
        Request::RequestApproval {
            payment_id,
            authorization_expiry,
            pending_file,
            signer,
        } => {
            let payment_id = id(&payment_id)?;
            let payment_ref = PaymentRef::new(&payment_id);
            let _held = journal.lock(&payment_ref)?;
            let mut record = load(&config, &journal, &payment_ref)?;
            if !record.exception_required {
                return Err(invalid("this payment is within the per-payment limit"));
            }
            if !record.attempts.is_empty() {
                return Err(invalid(
                    "reconcile the retained attempt before requesting approval",
                ));
            }
            let signer = match signer {
                Some(s) => id_address(&s)?,
                None => {
                    rpc.view_address(&config.vault, &abi::encode_getter("owner"))
                        .await?
                }
            };
            let version = signer_version(&config, &rpc, &signer).await?;
            let rules = read_policy(&config, &rpc, &record.payment.agent).await?;
            if rules.version != record.payment.policy_version {
                return Err(VaultError::new(
                    VaultCode::PolicyVersionChanged,
                    "agent policy changed",
                ));
            }
            let now = rpc.latest_timestamp().await?;
            if authorization_expiry < now || record.payment.valid_until < now {
                return Err(approval("payment or authorization expired"));
            }
            // Reissue only before any transaction exists. Identical live requests remain idempotent.
            // Every authorization still binds the same one-time payment ID, so two signers cannot pay twice.
            let retained = record.authorization.as_ref().filter(|a| {
                a.signer == signer && a.signer_version == version && a.authorization_expiry >= now
            });
            let authorization = match retained {
                Some(a) => a.clone(),
                None => {
                    record.signature = None;
                    ExceptionAuthorization {
                        payment_hash: record.payment_hash,
                        signer,
                        signer_version: version,
                        approval_nonce: u128::from_be_bytes(random::<16>()?),
                        authorization_expiry,
                    }
                }
            };
            record.authorization = Some(authorization.clone());
            journal.write(&record)?;
            let pending = PendingApproval {
                schema: PENDING_SCHEMA.into(),
                chain_id: config.chain_id,
                vault: config.vault,
                payment: record.payment,
                authorization: authorization.clone(),
                invoice_reference: record.invoice_reference,
                exceeded_rule: "perPaymentLimit".into(),
                per_payment_limit: rules.per,
            };
            write_new_private(
                &pending_file,
                &serde_json::to_vec_pretty(&pending)
                    .map_err(|_| invalid("cannot encode pending approval"))?,
            )?;
            Ok(
                json!({"status":"ok","pending_file":pending_file,"approval_digest":hex(&digest::approval_digest(config.chain_id,&config.vault,&authorization))}),
            )
        }
        Request::Submit {
            payment_id,
            signature_file,
        } => {
            let payment_id = id(&payment_id)?;
            let reference = PaymentRef::new(&payment_id);
            let _held = journal.lock(&reference)?;
            let mut record = load(&config, &journal, &reference)?;
            if key(&config)?.address() != record.payment.agent {
                return Err(invalid("retained payment belongs to another agent"));
            }
            // Every retained attempt is examined. A later reverted attempt must not hide an earlier successful one.
            for attempt in &record.attempts {
                if let Some(receipt) = rpc.receipt(&attempt.tx_hash).await? {
                    if receipt_succeeded(&receipt) == Some(true) {
                        if settled(&config, &rpc, &record, &attempt.tx_hash, &receipt)
                            .await
                            .is_some()
                        {
                            return Ok(
                                json!({"status":"ok","state":"settled","tx_hash":hex(&attempt.tx_hash)}),
                            );
                        }
                        return Ok(
                            json!({"status":"ok","state":"unknown","tx_hash":hex(&attempt.tx_hash)}),
                        );
                    }
                }
            }
            if rpc
                .view_bool(&config.vault, &abi::encode_consumed_payment(&payment_id))
                .await?
            {
                let hash = rpc
                    .view_word(&config.vault, &abi::encode_payment_hash_by_id(&payment_id))
                    .await?;
                if hash != record.payment_hash {
                    return Err(invalid("payment ID was consumed by a different payment"));
                }
                return Ok(json!({"status":"ok","state":"unknown","payment_hash":hex(&hash)}));
            }
            if let Some(last) = record.attempts.last() {
                let receipt = rpc.receipt(&last.tx_hash).await?;
                match receipt {
                    Some(r)
                        if receipt_succeeded(&r) == Some(false)
                            && receipt_tx_hash(&r) == Some(last.tx_hash)
                            && receipt_block(&r).is_some() => {}
                    None => {
                        // The deployment and journal binding were checked before reading these immutable blobs.
                        let raw = journal.read_attempt(&reference, record.attempts.len() - 1)?;
                        if <[u8; 32]>::from(sha3::Keccak256::digest(&raw)) != last.tx_hash {
                            return Err(invalid(
                                "retained transaction bytes differ from their hash",
                            ));
                        }
                        let _ = rpc.send_raw(&raw).await;
                        return poll(&config, &rpc, &record, &last.tx_hash).await;
                    }
                    _ => {
                        return Ok(
                            json!({"status":"ok","state":"unknown","tx_hash":hex(&last.tx_hash)}),
                        )
                    }
                }
            }
            if let Some(path) = signature_file {
                let file: ApproverSignature =
                    serde_json::from_slice(&read_bounded(&path, 64 * 1024)?)
                        .map_err(|_| invalid("invalid v2 signature file"))?;
                check_signature(&config, &record, &file)?;
                record.signature = Some(file);
                journal.write(&record)?;
            }
            let input = match (&record.signature, &record.authorization) {
                (Some(sig), Some(a)) => {
                    check_signature(&config, &record, sig)?;
                    abi::encode_pay_with_exception(&record.payment, a, &sig.signature)
                }
                _ if record.exception_required => {
                    return Err(approval("a current approver signature is required"))
                }
                _ => abi::encode_pay(&record.payment),
            };
            let key = key(&config)?;
            let agent = key.address();
            match rpc.call(Some(&agent), &config.vault, &input).await? {
                CallOutcome::Returned(_) => {}
                CallOutcome::Reverted(data) => return Err(map_revert(&data)),
            }
            let estimate = rpc.estimate_gas(&agent, &config.vault, &input).await?;
            let (max, priority) = rpc.fees().await?;
            let signed = build_signed_call(
                &key,
                config.chain_id,
                config.vault,
                input,
                TransactionParams {
                    nonce: rpc.pending_nonce(&agent).await?,
                    fees: Eip1559Fees::new(max, priority)
                        .map_err(|_| invalid("invalid RPC fees"))?,
                    gas_limit: estimate
                        .checked_mul(130)
                        .ok_or_else(|| invalid("gas estimate overflow"))?
                        / 100,
                    value: 0,
                },
            )
            .map_err(|_| invalid("transaction signing failed"))?;
            let hash = signed.hash();
            journal.store_attempt(&mut record, signed.raw(), hash)?;
            let _ = rpc.send_raw(signed.raw()).await;
            poll(&config, &rpc, &record, &hash).await
        }
        Request::Status { payment_id } => {
            let payment_id = id(&payment_id)?;
            let reference = PaymentRef::new(&payment_id);
            let _held = journal.lock(&reference)?;
            let record = journal.read(&reference)?;
            if let Some(r) = &record {
                check_binding(&config, r)?;
            }
            let consumed = rpc
                .view_bool(&config.vault, &abi::encode_consumed_payment(&payment_id))
                .await?;
            if !consumed {
                return Ok(json!({"status":"ok","state":"not_settled"}));
            }
            let hash = rpc
                .view_word(&config.vault, &abi::encode_payment_hash_by_id(&payment_id))
                .await?;
            if record.is_some_and(|r| r.payment_hash != hash) {
                return Err(invalid("payment ID belongs to another payment"));
            }
            Ok(json!({"status":"ok","state":"settled","payment_hash":hex(&hash)}))
        }
        Request::ExportRecord {
            payment_id,
            record_file,
        } => {
            let reference = PaymentRef::new(&id(&payment_id)?);
            let _held = journal.lock(&reference)?;
            let record = load(&config, &journal, &reference)?;
            for attempt in &record.attempts {
                let Some(receipt) = rpc.receipt(&attempt.tx_hash).await? else {
                    continue;
                };
                let Some(found) = settled(&config, &rpc, &record, &attempt.tx_hash, &receipt).await
                else {
                    continue;
                };
                let exported = super::verify::PaymentRecord {
                    schema: super::verify::RECORD_SCHEMA.into(),
                    chain_id: config.chain_id,
                    vault: config.vault,
                    vault_code_hash: config.code_hash,
                    payment: record.payment.clone(),
                    policy: found.event.clone(),
                    authorization: if found.event.exception {
                        record.authorization.clone()
                    } else {
                        None
                    },
                    signature: if found.event.exception {
                        record.signature.clone()
                    } else {
                        None
                    },
                    evidence: super::super::record::EvidenceOpening {
                        invoice_hex: record.invoice_hex.clone(),
                        salt: record.salt,
                    },
                    settlement: super::super::record::SettlementPointer {
                        tx_hash: attempt.tx_hash,
                        block_number: receipt_block(&receipt)
                            .ok_or_else(|| invalid("missing receipt block"))?,
                        log_index: found.log_index,
                    },
                };
                write_new_private(
                    &record_file,
                    &serde_json::to_vec_pretty(&exported)
                        .map_err(|_| invalid("record encoding failed"))?,
                )?;
                return Ok(json!({"status":"ok","record_file":record_file}));
            }
            Err(VaultError::unavailable(
                "no matching settlement receipt is visible",
            ))
        }
        Request::VerifyRecord { .. } => unreachable!(),
    }
}
fn id_address(text: &str) -> Result<[u8; 20], VaultError> {
    parse_hex(text).map_err(VaultError::invalid)
}
fn load(config: &Config, journal: &Journal, id: &PaymentRef) -> Result<PaymentRecord, VaultError> {
    let record = journal
        .read(id)?
        .ok_or_else(|| invalid("no v2 journaled payment has this ID"))?;
    check_binding(config, &record)?;
    Ok(record)
}
fn check_signature(
    config: &Config,
    record: &PaymentRecord,
    file: &ApproverSignature,
) -> Result<(), VaultError> {
    let a = record
        .authorization
        .as_ref()
        .ok_or_else(|| approval("request approval first"))?;
    if a.payment_hash != record.payment_hash
        || file.schema != SIGNATURE_SCHEMA
        || file.payment_id != record.payment.payment_id
        || file.approval_digest != digest::approval_digest(config.chain_id, &config.vault, a)
        || file.signer != a.signer
        || file.signer_version != a.signer_version
        || file.signature.len() > 16 * 1024
    {
        return Err(approval(
            "signature file does not name this exact authorization",
        ));
    }
    Ok(())
}
async fn settled(
    config: &Config,
    rpc: &VaultRpc,
    record: &PaymentRecord,
    hash: &[u8; 32],
    receipt: &Value,
) -> Option<LocatedPayment> {
    if receipt_succeeded(receipt) != Some(true)
        || receipt_block(receipt).is_none()
        || receipt_tx_hash(receipt) != Some(*hash)
        || receipt["to"].as_str().and_then(|s| parse_hex::<20>(s).ok()) != Some(config.vault)
        || receipt["from"]
            .as_str()
            .and_then(|s| parse_hex::<20>(s).ok())
            != Some(record.payment.agent)
    {
        return None;
    }
    let canonical = rpc
        .canonical_block_hash(receipt_block(receipt)?)
        .await
        .ok()?;
    if receipt["blockHash"]
        .as_str()
        .and_then(|s| parse_hex::<32>(s).ok())
        != Some(canonical)
    {
        return None;
    }
    let found = find_in_receipt(receipt, &config.vault, &record.payment.payment_id)?;
    if !super::verify::matches_payment(&found.event, &record.payment) {
        return None;
    }
    let expected = record
        .authorization
        .as_ref()
        .map(|a| digest::approval_digest(config.chain_id, &config.vault, a));
    if found.event.exception {
        let a = record.authorization.as_ref()?;
        if expected != Some(found.event.approval_digest)
            || found.event.signer != a.signer
            || found.event.signer_version != a.signer_version
        {
            return None;
        }
    } else if found.event.approval_digest != [0; 32]
        || found.event.signer != [0; 20]
        || found.event.signer_version != 0
    {
        return None;
    }
    Some(found)
}
async fn poll(
    config: &Config,
    rpc: &VaultRpc,
    record: &PaymentRecord,
    hash: &[u8; 32],
) -> Result<Value, VaultError> {
    let start = Instant::now();
    loop {
        if let Ok(Some(receipt)) = rpc.receipt(hash).await {
            if settled(config, rpc, record, hash, &receipt).await.is_some() {
                return Ok(json!({"status":"ok","state":"settled","tx_hash":hex(hash)}));
            }
            if receipt_succeeded(&receipt) == Some(false)
                && receipt_tx_hash(&receipt) == Some(*hash)
                && receipt_block(&receipt).is_some()
            {
                return Ok(json!({"status":"ok","state":"reverted","tx_hash":hex(hash)}));
            }
        }
        if start.elapsed() >= config.receipt_timeout {
            return Ok(json!({"status":"ok","state":"unknown","tx_hash":hex(hash)}));
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}
use sha3::Digest;
