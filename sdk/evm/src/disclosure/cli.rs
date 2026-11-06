//! One disclosure request as JSON on stdin, one JSON answer on stdout.

use std::fs::File;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::arc_vault::record::VaultPaymentRecord;
use crate::arc_vault::rpc::VaultRpc;
use crate::arc_vault::verify::{verify_record, Check, ReviewerPins, VerificationReport};
use crate::chain::ADDRESS_BYTES;
use serde::Deserialize;
use serde_json::{json, Value};
use styx_transport::disclosure::{DisclosureGrant, MAX_DISCLOSURE_BYTES, MAX_GRANT_BYTES};
use styx_transport::identity::{AuthorizationIdentity, DisclosureIdentity};
use zeroize::Zeroizing;

const MAX_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Version,
    Keygen {
        key_file: PathBuf,
    },
    KeyInfo {
        key_file: PathBuf,
    },
    ExportVaultPayment {
        record_file: PathBuf,
        issuer_key_file: PathBuf,
        recipient_public_key: String,
        grant_file: PathBuf,
        expires_at: u64,
    },
    VerifyVaultPayment {
        grant_file: PathBuf,
        key_file: PathBuf,
        expected_issuer: String,
        deployment: VaultPins,
        #[serde(default)]
        opened_file: Option<PathBuf>,
    },
}

/// What the reviewer trusts, obtained independently of any record.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultPins {
    chain_id: u64,
    rpc_urls: Vec<String>,
    vault: String,
    vault_code_hash: String,
}

/// Dispatch on the authenticated record schema; never infer a protocol from fields or environment.
enum VaultRecord {
    V1(Box<VaultPaymentRecord>),
    V2(Box<crate::arc_vault::v2::verify::PaymentRecord>),
}
impl VaultRecord {
    fn parse(bytes: &[u8]) -> Result<Self, &'static str> {
        #[derive(Deserialize)]
        struct Schema {
            schema: String,
        }
        let tag: Schema =
            serde_json::from_slice(bytes).map_err(|_| "invalid vault payment record")?;
        match tag.schema.as_str() {
            crate::arc_vault::record::RECORD_SCHEMA => serde_json::from_slice(bytes)
                .map(|record| Self::V1(Box::new(record)))
                .map_err(|_| "invalid vault payment record"),
            crate::arc_vault::v2::verify::RECORD_SCHEMA => serde_json::from_slice(bytes)
                .map(|record| Self::V2(Box::new(record)))
                .map_err(|_| "invalid vault payment record"),
            _ => Err("invalid vault payment record"),
        }
    }
    fn payment_id(&self) -> [u8; 32] {
        match self {
            Self::V1(r) => r.payment.payment_id,
            Self::V2(r) => r.payment.payment_id,
        }
    }
    fn tx_hash(&self) -> [u8; 32] {
        match self {
            Self::V1(r) => r.settlement.tx_hash,
            Self::V2(r) => r.settlement.tx_hash,
        }
    }
    fn vault(&self) -> [u8; 20] {
        match self {
            Self::V1(r) => r.vault,
            Self::V2(r) => r.vault,
        }
    }
    fn chain_id(&self) -> u64 {
        match self {
            Self::V1(r) => r.chain_id,
            Self::V2(r) => r.chain_id,
        }
    }
    async fn verify(&self, rpc: &VaultRpc, pins: &ReviewerPins) -> VerificationReport {
        match self {
            Self::V1(r) => verify_record(r, rpc, pins).await,
            Self::V2(r) => {
                crate::arc_vault::v2::verify::verify_record(r, rpc, &pins.vault_code_hash).await
            }
        }
    }
}

const HELP: &str = "styx-disclosure: one request as JSON on stdin.
Methods: version, keygen, key_info, export_vault_payment, verify_vault_payment.
Private keys are read from owner-only local files, and output never contains them.
export_vault_payment seals one payment record to one reviewer's public key.
verify_vault_payment opens it and checks it against the reviewer's own RPC.
No method submits a transaction.";

/// Runs the disclosure JSON interface without submitting transactions.
pub async fn run() {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if matches!(arguments.as_slice(), [argument] if argument == "--help") {
        println!("{HELP}");
        return;
    }
    if !arguments.is_empty() {
        finish(Err("invalid arguments"));
    }
    let mut input = Zeroizing::new(Vec::new());
    if std::io::stdin()
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
    {
        finish(Err("cannot read request"));
    }
    if input.len() > MAX_REQUEST_BYTES {
        finish(Err("request exceeds size limit"));
    }
    let request = match serde_json::from_slice(&input) {
        Ok(request) => request,
        Err(_) => finish(Err("invalid request")),
    };
    finish(handle(request).await);
}

fn finish(result: Result<Value, &'static str>) -> ! {
    let failed = result.is_err();
    let response = result.unwrap_or_else(|error| json!({"status": "error", "error": error}));
    println!("{response}");
    if std::io::stdout().flush().is_err() {
        std::process::exit(1);
    }
    std::process::exit(i32::from(failed));
}

async fn handle(request: Request) -> Result<Value, &'static str> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock unavailable")?
        .as_secs();
    match request {
        Request::Version => Ok(json!({
            "status": "ok",
            "protocol": 1,
            "methods": ["version", "keygen", "key_info", "export_vault_payment", "verify_vault_payment"],
        })),
        Request::Keygen { key_file } => {
            let recipient = DisclosureIdentity::generate_and_store(&key_file)
                .map_err(|_| "cannot create disclosure key")?;
            let parent = key_file
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "cannot persist disclosure key directory")?;
            Ok(json!({"status": "ok", "recipient_public_key": hex::encode(recipient.public_key())}))
        }
        Request::KeyInfo { key_file } => {
            let recipient = load_recipient(&key_file)?;
            Ok(json!({"status": "ok", "recipient_public_key": hex::encode(recipient.public_key())}))
        }
        Request::ExportVaultPayment {
            record_file,
            issuer_key_file,
            recipient_public_key,
            grant_file,
            expires_at,
        } => {
            let bytes = read_private_file(&record_file, MAX_DISCLOSURE_BYTES)?;
            let record = VaultRecord::parse(&bytes)?;
            let key = read_private_file(&issuer_key_file, 32)?;
            let issuer =
                AuthorizationIdentity::from_bytes(&key).map_err(|_| "invalid issuer key")?;
            let grant = DisclosureGrant::seal_record(
                &bytes,
                record_id(&record.payment_id()),
                &issuer,
                public_key(&recipient_public_key)?,
                expires_at,
                now,
            )
            .map_err(|_| "cannot create vault payment grant")?;
            grant
                .write_backup(&grant_file)
                .map_err(|_| "cannot save disclosure grant")?;
            Ok(json!({
                "status": "ok",
                "grant_saved": true,
                "payment_id": format!("0x{}", hex::encode(record.payment_id())),
                "issuer": format!("0x{}", hex::encode(&grant.issuer)),
            }))
        }
        Request::VerifyVaultPayment {
            grant_file,
            key_file,
            expected_issuer,
            deployment,
            opened_file,
        } => {
            let (grant, recipient, issuer) = load_grant(&grant_file, &key_file, &expected_issuer)?;
            let bytes = grant
                .open_record(&recipient, &issuer, now)
                .map_err(|_| "cannot open vault payment grant")?;
            let record = VaultRecord::parse(&bytes)?;
            if record_id(&record.payment_id()) != grant.deal_id {
                return Err("the grant names a different payment");
            }
            let vault =
                parse_lowercase_address(&deployment.vault).ok_or("invalid pinned vault address")?;
            if record.vault() != vault || record.chain_id() != deployment.chain_id {
                return Err("the record is for a different vault or chain");
            }
            let pins = ReviewerPins {
                vault_code_hash: lowercase_hash(
                    &deployment.vault_code_hash,
                    "invalid pinned vault code hash",
                )?,
            };
            let rpc = VaultRpc::new(
                &deployment.rpc_urls,
                Duration::from_secs(15),
                deployment.chain_id,
            )
            .map_err(|_| "invalid reviewer RPC configuration")?;
            let report = record.verify(&rpc, &pins).await;
            if let Some(path) = opened_file {
                write_owner_only_new(&path, &bytes)?;
            }
            let label = |check: Check| match check {
                Check::Verified => "verified",
                Check::Failed => "failed",
                Check::Unavailable => "unavailable",
                Check::NotApplicable => "not_applicable",
            };
            Ok(json!({
                "status": "ok",
                "payment_id": format!("0x{}", hex::encode(record.payment_id())),
                "tx_hash": format!("0x{}", hex::encode(record.tx_hash())),
                "record_integrity": label(report.record_integrity),
                "authorization": label(report.authorization),
                "settlement": label(report.settlement),
                "policy_at_execution": label(report.policy_at_execution),
                "reasons": report.reasons.join("; "),
                "delivery_verified": false,
            }))
        }
    }
}

fn parse_lowercase_address(value: &str) -> Option<[u8; ADDRESS_BYTES]> {
    let digits = value.strip_prefix("0x")?;
    if digits.len() != 40
        || !digits
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    hex::decode(digits).ok()?.try_into().ok()
}

fn lowercase_hash(text: &str, label: &'static str) -> Result<[u8; 32], &'static str> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    if digits.len() != 64
        || !digits
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(label);
    }
    hex::decode(digits)
        .map_err(|_| label)?
        .try_into()
        .map_err(|_| label)
}

/// A record grant's header holds the first 16 bytes of the payment ID.
fn record_id(payment_id: &[u8; 32]) -> [u8; 16] {
    let mut id = [0u8; 16];
    id.copy_from_slice(&payment_id[..16]);
    id
}

fn load_grant(
    grant_file: &Path,
    key_file: &Path,
    issuer: &str,
) -> Result<(DisclosureGrant, DisclosureIdentity, Vec<u8>), &'static str> {
    let digits = issuer.strip_prefix("0x").ok_or("invalid expected issuer")?;
    if !matches!(digits.len(), 40 | 128)
        || !digits
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid expected issuer");
    }
    let issuer = hex::decode(digits).map_err(|_| "invalid expected issuer")?;
    let recipient = load_recipient(key_file)?;
    let bytes = read_private_file(grant_file, MAX_GRANT_BYTES)?;
    let grant = DisclosureGrant::decode(&bytes).map_err(|_| "cannot load disclosure grant")?;
    Ok((grant, recipient, issuer))
}

fn load_recipient(path: &Path) -> Result<DisclosureIdentity, &'static str> {
    let bytes = read_private_file(path, 32)?;
    let private: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| "cannot load disclosure key")?;
    let private = Zeroizing::new(private);
    DisclosureIdentity::from_private_key(*private).map_err(|_| "cannot load disclosure key")
}

/// Writes a new owner-only file, refusing to overwrite an existing one.
fn write_owner_only_new(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(path)
        .map_err(|_| "cannot create evidence file")?;
    file.write_all(bytes)
        .map_err(|_| "cannot write evidence file")?;
    file.sync_all()
        .map_err(|_| "cannot persist evidence file")?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "cannot persist evidence directory")
}

fn public_key(text: &str) -> Result<[u8; 32], &'static str> {
    if text.len() != 64
        || !text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("invalid recipient public key");
    }
    hex::decode(text)
        .map_err(|_| "invalid recipient public key")?
        .try_into()
        .map_err(|_| "invalid recipient public key")
}

fn read_private_file(path: &Path, maximum: usize) -> Result<Zeroizing<Vec<u8>>, &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "private input unavailable")?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err("invalid private input");
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("private input permissions are not owner-only");
    }
    let file = File::open(path).map_err(|_| "private input unavailable")?;
    let metadata = file.metadata().map_err(|_| "private input unavailable")?;
    if !metadata.is_file() {
        return Err("invalid private input");
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("private input permissions are not owner-only");
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "private input unavailable")?;
    if bytes.len() > maximum {
        return Err("invalid private input");
    }
    Ok(bytes)
}
