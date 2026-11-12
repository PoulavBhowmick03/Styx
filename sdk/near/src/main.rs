//! `styx-near-vault`: the agent's client for the Styx vault on NEAR.
//!
//! It speaks the same protocol as the EVM `styx-vault` binary, so `mcp-server` drives it
//! unchanged: one JSON request on stdin, one JSON response on stdout. The agent signs every
//! transaction as the vault account with its function-call key, which the protocol limits to
//! `pay`, `pay_with_exception` and `post_record`. The binary makes no policy decision the vault
//! does not also make; it reads the rules first only to fail early with a useful message.
//!
//! Environment (never from the repo):
//!   STYX_NEAR_VAULT           the vault account id
//!   STYX_NEAR_AGENT_KEY_FILE  a NEAR key file (`private_key` or `secret_key`), owner-only
//!   STYX_NEAR_STATE_ROOT      a private directory for the payment journal
//!   STYX_NEAR_APPROVER        the approver public key asked by default (`ed25519:...`)
//!   STYX_NEAR_REVIEWER_KEY    the reviewer's X25519 public key, base64, for export_record
//!   STYX_NEAR_RPC_URL         optional, defaults to the public testnet RPC
//!   STYX_NEAR_NETWORK         optional, `testnet` by default; written into pending files
//!   STYX_NEAR_EVM_RPCS        for EVM payments: `<chain id>=<rpc url>` pairs, comma separated. A
//!                             recipient `eip155:<chain id>:0x…` (CAIP-10) pays on that chain.
//!   STYX_NEAR_EVM_CHAIN_ID    optional: the chain for a bare `0x…` recipient
//!   STYX_NEAR_EVM_RPC         optional: that chain's RPC, if it is not in STYX_NEAR_EVM_RPCS

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use near_api::types::{AccountId, NearGas, PublicKey, SecretKey};
use near_api::{Contract, Data, NetworkConfig, Signer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

mod evm;

const DEFAULT_RPC: &str = "https://test.rpc.fastnear.com";
const PENDING_SCHEMA: &str = "styx-near-pending/1";
const SIGNATURE_SCHEMA: &str = "styx-near-signature/1";
const PAY_GAS_TGAS: u64 = 100;
const RECORD_SCHEMA: &str = "styx-near-record/1";

// ---- errors, with the codes mcp-server knows -------------------------------------------------

#[derive(Debug)]
struct VaultError {
    code: &'static str,
    message: String,
}

type Result<T> = std::result::Result<T, VaultError>;

fn invalid(message: impl Into<String>) -> VaultError {
    VaultError { code: "INVALID_REQUEST", message: message.into() }
}
fn unavailable(message: impl Into<String>) -> VaultError {
    VaultError { code: "VERIFICATION_UNAVAILABLE", message: message.into() }
}
fn policy(message: impl Into<String>) -> VaultError {
    VaultError { code: "POLICY_LIMIT", message: message.into() }
}
fn approval(message: impl Into<String>) -> VaultError {
    VaultError { code: "OWNER_APPROVAL_REQUIRED", message: message.into() }
}

/// Maps the vault's named refusal to the code the agent's tools act on.
fn from_contract(name: &str) -> VaultError {
    let message = format!("the vault refused: {name}");
    let code = match name {
        "PerPaymentLimitExceeded" | "ApproverNotAllowed" | "SignerVersionMismatch"
        | "AuthorizationExpired" | "ApprovalNonceUsed" | "BadSignature" | "PaymentHashMismatch" => {
            "OWNER_APPROVAL_REQUIRED"
        }
        "DailyLimitExceeded" | "VaultDailyLimitExceeded" | "RecipientNotAllowed" | "VaultPaused"
        | "PolicyExpired" | "PaymentExpired" | "ZeroAmount" | "RecipientVersionMismatch" => {
            "POLICY_LIMIT"
        }
        "PolicyVersionMismatch" => "POLICY_VERSION_CHANGED",
        "PaymentAlreadyUsed" => "PAYMENT_ALREADY_SETTLED",
        _ => "INVALID_REQUEST",
    };
    VaultError { code, message }
}

/// Finds "Smart contract panicked: <Name>" in an error's text.
fn contract_refusal(text: &str) -> Option<String> {
    let marker = "Smart contract panicked: ";
    let start = text.find(marker)? + marker.len();
    let name: String = text[start..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    (!name.is_empty()).then_some(name)
}

// ---- request ---------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    Version,
    Propose {
        recipient: String,
        amount: String,
        invoice_file: PathBuf,
        invoice_reference: String,
        valid_until: u64,
    },
    RequestApproval {
        payment_id: String,
        authorization_expiry: u64,
        pending_file: PathBuf,
        signer: Option<String>,
    },
    Submit {
        payment_id: String,
        signature_file: Option<PathBuf>,
    },
    Status {
        payment_id: String,
    },
    ExportRecord {
        payment_id: String,
        record_file: PathBuf,
    },
}

// ---- contract types, as JSON -----------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Payment {
    payment_id: String,
    agent: String,
    token: String,
    recipient: String,
    amount: String,
    evidence_commitment: String,
    policy_version: u64,
    recipient_version: u64,
    valid_until: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Authorization {
    payment_hash: String,
    signer: String,
    signer_version: u64,
    approval_nonce: String,
    authorization_expiry: String,
    callback_url: Option<String>,
}

#[derive(Deserialize)]
struct AgentPolicy {
    version: u64,
    per_payment_limit: String,
    daily_limit: String,
    valid_until: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct RecipientState {
    version: u64,
    allowed: bool,
}

#[derive(Deserialize)]
struct ApproverState {
    version: u64,
    enabled: bool,
}

#[derive(Deserialize)]
struct VaultInfo {
    token: String,
    paused: bool,
    vault_daily_limit: String,
    contract_version: u32,
    #[serde(default)]
    mpc_signer: Option<String>,
    #[serde(default)]
    evm_key_path: Option<String>,
}

#[derive(Deserialize)]
struct EvmChain {
    token: String,
    enabled: bool,
}

#[derive(Deserialize, Serialize, Clone)]
struct SignedEvmTx {
    chain_id: u64,
    nonce: u64,
    raw_tx: String,
    tx_hash: String,
}

#[derive(Deserialize)]
struct SignatureFile {
    schema: String,
    #[serde(rename = "paymentId")]
    payment_id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    signature: String,
    nonce: String,
    #[serde(rename = "callbackUrl")]
    callback_url: Option<String>,
}

// ---- journal: one owner-only JSON file per payment -------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
struct Record {
    version: u32,
    vault: String,
    payment: Payment,
    payment_hash: String,
    invoice_reference: String,
    salt: String,
    per_payment_limit: String,
    exception_required: bool,
    authorization: Option<Authorization>,
    /// Transactions sent for this payment, in order.
    attempts: Vec<String>,
    /// Set once a transaction's final outcome showed the transfer settled.
    settled_tx: Option<String>,
    /// The invoice bytes, base64, so a sealed record can carry them to a reviewer.
    #[serde(default)]
    invoice: Option<String>,
    /// The approver's base64 signature, once an exception was submitted with it.
    #[serde(default)]
    signature: Option<String>,
    /// The `post_record` transaction, once a sealed record was posted.
    #[serde(default)]
    record_tx: Option<String>,
    /// Set for a payment on an EVM chain; `payment.recipient` is then a `0x…` address.
    #[serde(default)]
    chain_id: Option<u64>,
    /// The transaction the vault signed for an EVM payment, once it exists.
    #[serde(default)]
    evm_tx: Option<SignedEvmTx>,
}

impl Record {
    /// The payment as the contract takes it: `Payment` on NEAR, `EvmPayment` on an EVM chain.
    fn contract_payment(&self) -> Value {
        match self.chain_id {
            None => json!(self.payment),
            Some(chain_id) => json!({
                "payment_id": self.payment.payment_id,
                "agent": self.payment.agent,
                "chain_id": chain_id,
                "recipient": self.payment.recipient,
                "amount": self.payment.amount,
                "evidence_commitment": self.payment.evidence_commitment,
                "policy_version": self.payment.policy_version,
                "recipient_version": self.payment.recipient_version,
                "valid_until": self.payment.valid_until,
            }),
        }
    }
}

struct Journal {
    root: PathBuf,
}

impl Journal {
    fn open(root: &Path) -> Result<Self> {
        let meta = std::fs::metadata(root).map_err(|_| invalid("STYX_NEAR_STATE_ROOT must be an existing directory"))?;
        if !meta.is_dir() {
            return Err(invalid("STYX_NEAR_STATE_ROOT must be a directory"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                return Err(invalid("STYX_NEAR_STATE_ROOT must be owner-only (chmod 700)"));
            }
        }
        Ok(Self { root: root.to_path_buf() })
    }

    fn path(&self, payment_id: &str) -> Result<PathBuf> {
        let id = payment_id.strip_prefix("0x").unwrap_or(payment_id);
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid("payment_id must be 0x and 64 hex digits"));
        }
        Ok(self.root.join(format!("near-payment-{}.json", id.to_ascii_lowercase())))
    }

    fn load(&self, payment_id: &str) -> Result<Record> {
        let bytes = std::fs::read(self.path(payment_id)?).map_err(|_| invalid("unknown payment_id; propose it first"))?;
        serde_json::from_slice(&bytes).map_err(|_| invalid("journal entry is damaged"))
    }

    fn write(&self, record: &Record) -> Result<()> {
        let path = self.path(&record.payment.payment_id)?;
        let tmp = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(record).map_err(|_| invalid("cannot encode journal entry"))?;
        write_private(&tmp, &bytes, true)?;
        std::fs::rename(&tmp, &path).map_err(|_| unavailable("cannot save journal entry"))
    }
}

fn write_private(path: &Path, bytes: &[u8], overwrite: bool) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if overwrite {
        options.create(true).truncate(true);
    } else {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| invalid(format!("cannot create {}", path.display())))?;
    file.write_all(bytes).map_err(|_| unavailable("cannot write file"))
}

/// Largest inference evidence file the record will carry.
const INFERENCE_EVIDENCE_LIMIT: u64 = 256 * 1024;

/// Reads `inference-<first 12 hex of the payment id>.json` from the vault directory, if there is
/// one, and returns its JSON as it is. A file that is not valid JSON is an error: the record must
/// not silently drop evidence the runner wrote.
fn read_inference_evidence(root: &Path, payment_id: &str) -> Result<Option<Value>> {
    let id = payment_id.strip_prefix("0x").unwrap_or(payment_id);
    if id.len() < 12 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("payment_id must be 0x and 64 hex digits"));
    }
    let path = root.join(format!("inference-{}.json", id[..12].to_ascii_lowercase()));
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = read_bounded(&path, INFERENCE_EVIDENCE_LIMIT)?;
    serde_json::from_slice(&bytes).map(Some).map_err(|_| invalid(format!("{} is not valid JSON", path.display())))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = std::fs::File::open(path).map_err(|_| invalid(format!("cannot read {}", path.display())))?;
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|_| invalid("cannot read file"))?;
    if bytes.len() as u64 > limit {
        return Err(invalid("file too large"));
    }
    Ok(bytes)
}

// ---- configuration ---------------------------------------------------------------------------

struct Config {
    network_name: String,
    rpc_url: String,
    network: NetworkConfig,
    vault: AccountId,
    key_file: Option<PathBuf>,
    state_root: PathBuf,
    approver: Option<String>,
    reviewer: Option<String>,
    evm_chain_id: Option<u64>,
    /// chain id -> RPC URL.
    evm_rpcs: std::collections::BTreeMap<u64, String>,
}

/// Builds the chain-to-RPC map from `STYX_NEAR_EVM_RPCS`, plus the single-chain pair if set.
fn parse_rpcs(list: Option<&str>, chain: Option<&str>, rpc: Option<&str>) -> Result<std::collections::BTreeMap<u64, String>> {
    let mut map = std::collections::BTreeMap::new();
    for pair in list.unwrap_or("").split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (id, url) = pair.split_once('=').ok_or_else(|| invalid("STYX_NEAR_EVM_RPCS entries look like 84532=https://…"))?;
        let id: u64 = id.trim().parse().map_err(|_| invalid("STYX_NEAR_EVM_RPCS chain ids must be numbers"))?;
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err(invalid("STYX_NEAR_EVM_RPCS URLs must be http or https"));
        }
        map.insert(id, url.trim().to_string());
    }
    if let (Some(chain), Some(rpc)) = (chain, rpc) {
        let id: u64 = chain.parse().map_err(|_| invalid("STYX_NEAR_EVM_CHAIN_ID must be a number"))?;
        map.entry(id).or_insert_with(|| rpc.to_string());
    }
    Ok(map)
}

/// Splits a recipient into (EVM chain, address) or a NEAR account. `eip155:<chain>:0x…` names its
/// chain; a bare `0x…` uses the default chain; anything else is a NEAR account id.
fn parse_recipient(recipient: &str, default_chain: Option<u64>) -> Result<(Option<u64>, String)> {
    let (chain, address) = if let Some(rest) = recipient.strip_prefix("eip155:") {
        let (id, address) = rest.split_once(':').ok_or_else(|| invalid("CAIP-10 recipients look like eip155:<chain id>:0x…"))?;
        let id: u64 = id.parse().map_err(|_| invalid("CAIP-10 chain id must be a number"))?;
        (Some(id), address)
    } else if recipient.starts_with("0x") {
        (Some(default_chain.ok_or_else(|| invalid("write the recipient as eip155:<chain id>:0x… or set STYX_NEAR_EVM_CHAIN_ID"))?), recipient)
    } else {
        let account: AccountId = recipient.parse().map_err(|_| invalid("recipient is not a NEAR account id"))?;
        return Ok((None, account.to_string()));
    };
    let lower = address.to_ascii_lowercase();
    if lower.len() != 42 || !lower.starts_with("0x") || !lower[2..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid("recipient is not an EVM address"));
    }
    Ok((chain, lower))
}

impl Config {
    fn from_env() -> Result<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        let rpc_url = var("STYX_NEAR_RPC_URL").unwrap_or_else(|| DEFAULT_RPC.to_string());
        let network_name = var("STYX_NEAR_NETWORK").unwrap_or_else(|| "testnet".to_string());
        let url = rpc_url.parse().map_err(|_| invalid("STYX_NEAR_RPC_URL is not a URL"))?;
        Ok(Self {
            network: NetworkConfig::from_rpc_url(&network_name, url),
            network_name,
            rpc_url,
            vault: var("STYX_NEAR_VAULT")
                .ok_or_else(|| invalid("STYX_NEAR_VAULT must be set"))?
                .parse()
                .map_err(|_| invalid("STYX_NEAR_VAULT is not an account id"))?,
            key_file: var("STYX_NEAR_AGENT_KEY_FILE").map(PathBuf::from),
            state_root: var("STYX_NEAR_STATE_ROOT")
                .map(PathBuf::from)
                .ok_or_else(|| invalid("STYX_NEAR_STATE_ROOT must be set"))?,
            approver: var("STYX_NEAR_APPROVER"),
            reviewer: var("STYX_NEAR_REVIEWER_KEY"),
            evm_chain_id: var("STYX_NEAR_EVM_CHAIN_ID").map(|v| v.parse().map_err(|_| invalid("STYX_NEAR_EVM_CHAIN_ID must be a number"))).transpose()?,
            evm_rpcs: parse_rpcs(var("STYX_NEAR_EVM_RPCS").as_deref(), var("STYX_NEAR_EVM_CHAIN_ID").as_deref(), var("STYX_NEAR_EVM_RPC").as_deref())?,
        })
    }

    fn agent_key(&self) -> Result<SecretKey> {
        let path = self.key_file.as_ref().ok_or_else(|| invalid("STYX_NEAR_AGENT_KEY_FILE must be set"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path).map_err(|_| invalid("agent key file is unavailable"))?.permissions().mode();
            if mode & 0o077 != 0 {
                return Err(invalid("agent key file must be owner-only (chmod 600)"));
            }
        }
        let value: Value = serde_json::from_slice(&read_bounded(path, 4096)?).map_err(|_| invalid("agent key file is not JSON"))?;
        let text = value
            .get("private_key")
            .or_else(|| value.get("secret_key"))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("agent key file has no private_key"))?;
        text.parse().map_err(|_| invalid("agent key file holds an invalid key"))
    }
}

// ---- chain access ----------------------------------------------------------------------------

struct Chain<'a> {
    config: &'a Config,
}

impl Chain<'_> {
    async fn view<T: serde::de::DeserializeOwned + Send + Sync>(&self, method: &str, args: Value) -> Result<T> {
        self.view_on(self.config.vault.clone(), method, args).await
    }

    async fn view_on<T: serde::de::DeserializeOwned + Send + Sync>(&self, account: AccountId, method: &str, args: Value) -> Result<T> {
        let data: Data<T> = Contract(account)
            .call_function(method, args)
            .read_only()
            .fetch_from(&self.config.network)
            .await
            .map_err(|e| unavailable(format!("view {method} failed: {}", short(&e.to_string()))))?;
        Ok(data.data)
    }

    /// Sends one agent call and waits for the final outcome, including the transfer callback.
    /// Returns the transaction hash and the method's JSON return value.
    async fn call(&self, key: &SecretKey, method: &str, args: Value) -> Result<(String, Value)> {
        let signer: Arc<Signer> = Signer::from_secret_key(key.clone()).map_err(|_| invalid("cannot build the agent signer"))?;
        let sent = Contract(self.config.vault.clone())
            .call_function(method, args)
            .transaction()
            .gas(NearGas::from_tgas(PAY_GAS_TGAS))
            .with_signer(self.config.vault.clone(), signer)
            .send_to(&self.config.network)
            .await;
        let outcome = match sent {
            Ok(result) => result,
            Err(e) => {
                let text = format!("{e:?}");
                if let Some(name) = contract_refusal(&text) {
                    return Err(from_contract(&name));
                }
                if text.contains("MethodNameMismatch") || text.contains("ReceiverMismatch") {
                    return Err(invalid("the agent key is not allowed to call this method"));
                }
                if text.contains("AccessKeyNotFound") || text.contains("InvalidAccessKey") {
                    return Err(invalid("the agent key is not installed on the vault; ask the owner to configure it"));
                }
                return Err(unavailable(format!("transaction not confirmed: {}", short(&text))));
            }
        };
        let full = outcome.into_full().ok_or_else(|| unavailable("transaction outcome not final yet"))?;
        let tx_hash = full.outcomes().first().map(|o| o.transaction_hash.to_string()).unwrap_or_default();
        match full.into_result() {
            Ok(success) => {
                let value = success.json::<Value>().unwrap_or(Value::Null);
                Ok((tx_hash, value))
            }
            Err(failure) => {
                let text = format!("{failure:?}");
                match contract_refusal(&text) {
                    Some(name) => Err(from_contract(&name)),
                    None => Err(unavailable(format!("transaction {tx_hash} failed: {}", short(&text)))),
                }
            }
        }
    }

    async fn check_vault(&self) -> Result<VaultInfo> {
        let info: VaultInfo = self.view("get_vault", json!({})).await?;
        if info.contract_version != 1 && info.contract_version != 2 {
            return Err(invalid("configured account is not a Styx NEAR vault version 1 or 2"));
        }
        Ok(info)
    }
}

fn short(text: &str) -> String {
    text.chars().take(300).collect()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random32() -> [u8; 32] {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes
}

fn parse_amount(text: &str) -> Result<u128> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) || (text.len() > 1 && text.starts_with('0')) {
        return Err(invalid("amount must be a canonical decimal string"));
    }
    text.parse().map_err(|_| invalid("amount out of range"))
}

fn u128_of(text: &str) -> Result<u128> {
    text.parse().map_err(|_| unavailable("malformed number from the vault"))
}

// ---- handlers --------------------------------------------------------------------------------

async fn handle(request: Request) -> Result<Value> {
    if matches!(request, Request::Version) {
        return Ok(json!({"status": "ok", "protocol": 1, "contract_version": 1}));
    }
    let config = Config::from_env()?;
    let chain = Chain { config: &config };
    let vault = chain.check_vault().await?;
    let journal = Journal::open(&config.state_root)?;
    match request {
        Request::Version => unreachable!(),
        Request::Propose { recipient, amount, invoice_file, invoice_reference, valid_until } => {
            let key = config.agent_key()?;
            let agent: PublicKey = key.public_key();
            let agent = agent.to_string();
            // An EVM recipient is paid on its chain through the vault's Chain Signatures.
            let (evm_chain, recipient) = parse_recipient(&recipient, config.evm_chain_id)?;
            if let Some(chain_id) = evm_chain {
                let info: Option<EvmChain> = chain.view("get_evm_chain", json!({ "chain_id": chain_id })).await?;
                info.filter(|c| c.enabled).ok_or_else(|| policy("the vault does not pay on this chain"))?;
                if !config.evm_rpcs.contains_key(&chain_id) {
                    return Err(invalid(format!("no RPC for chain {chain_id}; add it to STYX_NEAR_EVM_RPCS")));
                }
            }
            let amount = parse_amount(&amount)?;
            if invoice_reference.len() > 4096 {
                return Err(invalid("invoice reference too long"));
            }
            let rules: Option<AgentPolicy> = chain.view("get_agent", json!({ "agent": agent })).await?;
            let rules = rules.filter(|r| r.enabled).ok_or_else(|| policy("this agent is not enabled on the vault"))?;
            let time = now();
            if time > rules.valid_until.parse::<u64>().unwrap_or(0) || time > valid_until {
                return Err(policy("agent policy or payment has expired"));
            }
            if amount == 0 {
                return Err(policy("zero amount"));
            }
            if vault.paused {
                return Err(policy("vault is paused"));
            }
            let state: Option<RecipientState> = match evm_chain {
                Some(chain_id) => chain.view("get_evm_recipient", json!({ "chain_id": chain_id, "recipient": recipient })).await?,
                None => chain.view("get_recipient", json!({ "recipient": recipient })).await?,
            };
            let state = state.filter(|s| s.allowed).ok_or_else(|| policy("recipient is not allowed"))?;
            let day: u64 = chain.view("current_day", json!({})).await?;
            let agent_spent = u128_of(&chain.view::<String>("spent_by_agent", json!({ "agent": agent, "day": day })).await?)?;
            let vault_spent = u128_of(&chain.view::<String>("spent_by_vault", json!({ "day": day })).await?)?;
            let daily = u128_of(&rules.daily_limit)?;
            let cap = u128_of(&vault.vault_daily_limit)?;
            if agent_spent > daily || amount > daily - agent_spent || vault_spent > cap || amount > cap - vault_spent {
                return Err(policy("payment exceeds a daily cap; no exception can lift it"));
            }
            let invoice = read_bounded(&invoice_file, 1024 * 1024)?;
            let salt = random32();
            let mut hasher = Sha256::new();
            hasher.update(salt);
            hasher.update(&invoice);
            let evidence: [u8; 32] = hasher.finalize().into();
            let payment = Payment {
                payment_id: format!("0x{}", hex::encode(random32())),
                agent,
                token: match evm_chain { Some(id) => format!("evm:{id}"), None => vault.token.clone() },
                recipient: recipient.clone(),
                amount: amount.to_string(),
                evidence_commitment: B64.encode(evidence),
                policy_version: rules.version,
                recipient_version: state.version,
                valid_until: valid_until.to_string(),
            };
            // The vault computes the hash, so the agent and the approver read the same value.
            let per = u128_of(&rules.per_payment_limit)?;
            let record = Record {
                version: 1,
                vault: config.vault.to_string(),
                payment: payment.clone(),
                payment_hash: String::new(),
                invoice_reference,
                salt: B64.encode(salt),
                per_payment_limit: per.to_string(),
                exception_required: amount > per,
                authorization: None,
                attempts: Vec::new(),
                settled_tx: None,
                invoice: Some(B64.encode(&invoice)),
                signature: None,
                record_tx: None,
                chain_id: evm_chain,
                evm_tx: None,
            };
            let mut record = record;
            record.payment_hash = match evm_chain {
                Some(_) => chain.view("evm_payment_hash", json!({ "payment": record.contract_payment() })).await?,
                None => chain.view("payment_hash", json!({ "payment": record.payment })).await?,
            };
            let payment_hash = record.payment_hash.clone();
            journal.write(&record)?;
            Ok(json!({
                "status": "ok",
                "payment_id": payment.payment_id,
                "payment_hash": payment_hash,
                "path": if record.exception_required { "exception_required" } else { "ordinary" },
            }))
        }
        Request::RequestApproval { payment_id, authorization_expiry, pending_file, signer } => {
            let mut record = journal.load(&payment_id)?;
            if !record.exception_required {
                return Err(invalid("this payment is within the per-payment limit"));
            }
            if !record.attempts.is_empty() {
                return Err(invalid("reconcile the retained attempt before requesting approval"));
            }
            let signer = signer
                .or_else(|| config.approver.clone())
                .ok_or_else(|| invalid("set STYX_NEAR_APPROVER to the approver's public key"))?;
            let state: Option<ApproverState> = chain.view("get_approver", json!({ "approver": signer })).await?;
            let state = state.filter(|s| s.enabled).ok_or_else(|| approval("this signer is not a current approver"))?;
            let rules: Option<AgentPolicy> = chain.view("get_agent", json!({ "agent": record.payment.agent })).await?;
            if rules.map(|r| r.version) != Some(record.payment.policy_version) {
                return Err(VaultError { code: "POLICY_VERSION_CHANGED", message: "agent policy changed".into() });
            }
            let time = now();
            if authorization_expiry < time || record.payment.valid_until.parse::<u64>().unwrap_or(0) < time {
                return Err(approval("payment or authorization expired"));
            }
            // A live request for the same signer and version is reused, so asking twice is safe.
            let authorization = match record.authorization.clone().filter(|a| {
                a.signer == signer && a.signer_version == state.version && a.authorization_expiry.parse::<u64>().unwrap_or(0) >= time
            }) {
                Some(a) => a,
                None => Authorization {
                    payment_hash: record.payment_hash.clone(),
                    signer: signer.clone(),
                    signer_version: state.version,
                    approval_nonce: B64.encode(random32()),
                    authorization_expiry: authorization_expiry.to_string(),
                    callback_url: None,
                },
            };
            let message: String = chain.view("exception_message", json!({ "authorization": authorization })).await?;
            record.authorization = Some(authorization.clone());
            journal.write(&record)?;
            let pending = json!({
                "schema": PENDING_SCHEMA,
                "network": config.network_name,
                "rpcUrl": config.rpc_url,
                "vault": config.vault,
                "token": vault.token,
                "chainId": record.chain_id,
                "payment": record.contract_payment(),
                "authorization": authorization,
                "message": message,
                "invoiceReference": record.invoice_reference,
                "perPaymentLimit": record.per_payment_limit,
                "exceededRule": "perPaymentLimit",
            });
            let bytes = serde_json::to_vec_pretty(&pending).map_err(|_| invalid("cannot encode pending approval"))?;
            write_private(&pending_file, &bytes, false)?;
            let digest = nep413_digest(&message, &authorization, config.vault.as_str())?;
            Ok(json!({
                "status": "ok",
                "pending_file": pending_file.display().to_string(),
                "approval_digest": format!("0x{}", hex::encode(digest)),
            }))
        }
        Request::Submit { payment_id, signature_file } => {
            let key = config.agent_key()?;
            let mut record = journal.load(&payment_id)?;
            if record.payment.agent != key.public_key().to_string() {
                return Err(invalid("retained payment belongs to another agent"));
            }
            if record.vault != config.vault.as_str() {
                return Err(invalid("retained payment belongs to another vault"));
            }
            if let Some(tx) = &record.settled_tx {
                return Ok(json!({"status": "ok", "state": "settled", "tx_hash": tx}));
            }
            if record.evm_tx.is_some() {
                return settle_evm(&config, &chain, &vault, &mut record, &journal).await;
            }
            // The vault marks a payment id when it sends the transfer and frees it if the transfer
            // fails, so a marked id is never safe to pay again.
            let consumed: Option<String> = chain.view("consumed_payment", json!({ "payment_id": record.payment.payment_id })).await?;
            if let Some(hash) = consumed {
                if hash != record.payment_hash {
                    return Err(invalid("payment ID was consumed by a different payment"));
                }
                if let Some(chain_id) = record.chain_id {
                    if let Some(signed) = find_signed(&chain, chain_id, &record.payment.payment_id).await? {
                        record.evm_tx = Some(signed);
                        journal.write(&record)?;
                        return settle_evm(&config, &chain, &vault, &mut record, &journal).await;
                    }
                }
                return Ok(json!({"status": "ok", "state": "unknown", "payment_hash": hash}));
            }
            let (method, args) = match (&signature_file, record.exception_required) {
                (None, true) => return Err(approval("this payment is over the per-payment limit; request approval and pass the signature")),
                (None, false) => (
                    if record.chain_id.is_some() { "pay_evm" } else { "pay" },
                    json!({ "payment": record.contract_payment() }),
                ),
                (Some(path), _) => {
                    let mut authorization = record.authorization.clone().ok_or_else(|| invalid("request approval first"))?;
                    let file: SignatureFile = serde_json::from_slice(&read_bounded(path, 16 * 1024)?)
                        .map_err(|_| invalid("invalid signature file"))?;
                    if file.schema != SIGNATURE_SCHEMA || file.payment_id != record.payment.payment_id {
                        return Err(invalid("signature file is for another payment"));
                    }
                    if file.public_key != authorization.signer || file.nonce != authorization.approval_nonce {
                        return Err(approval("signature is from another key or for another request"));
                    }
                    let signature = B64.decode(&file.signature).map_err(|_| invalid("signature is not base64"))?;
                    if signature.len() != 64 {
                        return Err(invalid("signature must be 64 bytes"));
                    }
                    authorization.callback_url = file.callback_url;
                    record.authorization = Some(authorization.clone());
                    record.signature = Some(file.signature.clone());
                    (
                        if record.chain_id.is_some() { "pay_evm_with_exception" } else { "pay_with_exception" },
                        json!({ "payment": record.contract_payment(), "authorization": authorization, "signature": file.signature }),
                    )
                }
            };
            let result = chain.call(&key, method, args).await;
            match result {
                Ok((tx, value)) if record.chain_id.is_some() => {
                    record.attempts.push(tx.clone());
                    match serde_json::from_value::<SignedEvmTx>(value) {
                        Ok(signed) => {
                            record.evm_tx = Some(signed);
                            journal.write(&record)?;
                            settle_evm(&config, &chain, &vault, &mut record, &journal).await
                        }
                        // The signer did not answer; the vault rolled the payment back.
                        Err(_) => {
                            journal.write(&record)?;
                            Ok(json!({"status": "ok", "state": "reverted", "tx_hash": tx}))
                        }
                    }
                }
                Ok((tx, value)) => {
                    record.attempts.push(tx.clone());
                    let settled = value.as_bool() == Some(true);
                    if settled {
                        record.settled_tx = Some(tx.clone());
                    }
                    journal.write(&record)?;
                    Ok(json!({"status": "ok", "state": if settled { "settled" } else { "reverted" }, "tx_hash": tx}))
                }
                Err(error) => Err(error),
            }
        }
        Request::Status { payment_id } => {
            let mut record = journal.load(&payment_id)?;
            if let Some(tx) = &record.settled_tx {
                return Ok(json!({"status": "ok", "state": "settled", "tx_hash": tx}));
            }
            if record.evm_tx.is_some() {
                return settle_evm(&config, &chain, &vault, &mut record, &journal).await;
            }
            let consumed: Option<String> = chain.view("consumed_payment", json!({ "payment_id": record.payment.payment_id })).await?;
            Ok(match consumed {
                Some(hash) if hash == record.payment_hash => json!({"status": "ok", "state": "unknown", "payment_hash": hash}),
                Some(_) => return Err(invalid("payment ID was consumed by a different payment")),
                None => json!({"status": "ok", "state": "not_settled"}),
            })
        }
        Request::ExportRecord { payment_id, record_file } => {
            let key = config.agent_key()?;
            let mut record = journal.load(&payment_id)?;
            let settlement = record.settled_tx.clone().ok_or_else(|| invalid("only a settled payment has a record"))?;
            if let Some(tx) = &record.record_tx {
                return Ok(json!({"status": "ok", "state": "posted", "tx_hash": tx}));
            }
            let invoice = record.invoice.clone().ok_or_else(|| invalid("this payment was journaled without its invoice"))?;
            let reviewer = config.reviewer.as_ref().ok_or_else(|| invalid("set STYX_NEAR_REVIEWER_KEY to the reviewer's public key"))?;
            let reviewer: [u8; 32] = B64
                .decode(reviewer)
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| invalid("STYX_NEAR_REVIEWER_KEY must be a base64 X25519 public key"))?;
            let mut plain = json!({
                "schema": RECORD_SCHEMA,
                "network": config.network_name,
                "vault": record.vault,
                "payment": record.payment,
                "payment_hash": record.payment_hash,
                "invoice": invoice,
                "salt": record.salt,
                "invoice_reference": record.invoice_reference,
                "settlement_tx": settlement,
                "authorization": if record.exception_required { json!(record.authorization) } else { Value::Null },
                "signature": if record.exception_required { json!(record.signature) } else { Value::Null },
            });
            // Optional: the agent runner's evidence about the model that decided to pay. Included
            // verbatim when its file exists; the field is absent otherwise, so records without it
            // stay valid under the same schema.
            if let Some(evidence) = read_inference_evidence(&config.state_root, &record.payment.payment_id)? {
                plain["inference_evidence"] = evidence;
            }
            let plain = serde_json::to_vec(&plain).map_err(|_| invalid("cannot encode the record"))?;
            let sealed = crypto_box::PublicKey::from(reviewer)
                .seal(&mut rand::rngs::OsRng, &plain)
                .map_err(|_| invalid("cannot seal the record"))?;
            let sealed = B64.encode(sealed);
            // The local copy holds only the sealed box: the same bytes the chain will carry.
            let local = json!({"schema": "styx-near-sealed/1", "vault": record.vault, "payment_id": record.payment.payment_id, "sealed": sealed});
            write_private(&record_file, &serde_json::to_vec_pretty(&local).map_err(|_| invalid("cannot encode"))?, false)?;
            let (tx, _) = chain.call(&key, "post_record", json!({ "payment_id": record.payment.payment_id, "sealed": sealed })).await?;
            record.record_tx = Some(tx.clone());
            journal.write(&record)?;
            Ok(json!({"status": "ok", "state": "posted", "record_file": record_file.display().to_string(), "tx_hash": tx}))
        }
    }
}

/// Carries the vault's signed EVM transactions to the chain and reads the payment's outcome.
/// Broadcasts every signed transaction the chain has not included yet, in nonce order, so an
/// earlier one that was never sent cannot block this one.
async fn settle_evm(config: &Config, chain: &Chain<'_>, vault: &VaultInfo, record: &mut Record, journal: &Journal) -> Result<Value> {
    let chain_id = record.chain_id.ok_or_else(|| invalid("not an EVM payment"))?;
    let tx = record.evm_tx.clone().ok_or_else(|| invalid("the vault has not signed this payment"))?;
    let url = config.evm_rpcs.get(&chain_id).ok_or_else(|| invalid(format!("no RPC for chain {chain_id}; add it to STYX_NEAR_EVM_RPCS")))?;
    let rpc = evm::EvmRpc::new(url);
    if rpc.chain_id().await.map_err(unavailable)? != chain_id {
        return Err(invalid("STYX_NEAR_EVM_RPC is for another chain"));
    }
    let signer: AccountId = vault
        .mpc_signer
        .clone()
        .ok_or_else(|| invalid("this vault has no MPC signer"))?
        .parse()
        .map_err(|_| unavailable("malformed signer id"))?;
    let path = vault.evm_key_path.clone().unwrap_or_else(|| "styx-evm".into());
    let key: String = chain
        .view_on(signer, "derived_public_key", json!({ "path": path, "predecessor": config.vault, "domain_id": 0 }))
        .await?;
    let from = evm::address_from_near_key(&key).ok_or_else(|| unavailable("malformed derived key"))?;
    let included = rpc.nonce(&from).await.map_err(unavailable)?;
    let next: u64 = chain.view("evm_nonce", json!({ "chain_id": chain_id })).await?;
    for nonce in included..next {
        let signed: Option<SignedEvmTx> = chain.view("signed_evm_tx", json!({ "chain_id": chain_id, "nonce": nonce })).await?;
        if let Some(signed) = signed {
            rpc.send_raw(&signed.raw_tx).await.map_err(|e| unavailable(format!("broadcast of nonce {nonce} failed: {e}")))?;
        }
    }
    let info: Option<EvmChain> = chain.view("get_evm_chain", json!({ "chain_id": chain_id })).await?;
    let token = info.map(|c| c.token).ok_or_else(|| unavailable("chain settings disappeared"))?;
    let amount = u128_of(&record.payment.amount)?;
    for _ in 0..30 {
        if let Some(receipt) = rpc.receipt(&tx.tx_hash).await.map_err(unavailable)? {
            return match evm::check_receipt(&receipt, &token, &from, &record.payment.recipient, amount) {
                evm::Outcome::Transferred => {
                    record.settled_tx = Some(tx.tx_hash.clone());
                    journal.write(record)?;
                    Ok(json!({"status": "ok", "state": "settled", "tx_hash": tx.tx_hash}))
                }
                evm::Outcome::Failed(_) => Ok(json!({"status": "ok", "state": "reverted", "tx_hash": tx.tx_hash})),
            };
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
    // Signed and sent but not seen yet: never treat as unpaid; retry with the same payment id.
    Ok(json!({"status": "ok", "state": "unknown", "tx_hash": tx.tx_hash}))
}

/// Finds the transaction the vault signed for a payment id among the most recent nonces.
async fn find_signed(chain: &Chain<'_>, chain_id: u64, payment_id: &str) -> Result<Option<SignedEvmTx>> {
    #[derive(Deserialize)]
    struct WithId {
        payment_id: String,
        chain_id: u64,
        nonce: u64,
        raw_tx: String,
        tx_hash: String,
    }
    let next: u64 = chain.view("evm_nonce", json!({ "chain_id": chain_id })).await?;
    for nonce in (next.saturating_sub(50)..next).rev() {
        let signed: Option<WithId> = chain.view("signed_evm_tx", json!({ "chain_id": chain_id, "nonce": nonce })).await?;
        if let Some(t) = signed.filter(|t| t.payment_id == payment_id) {
            return Ok(Some(SignedEvmTx { chain_id: t.chain_id, nonce: t.nonce, raw_tx: t.raw_tx, tx_hash: t.tx_hash }));
        }
    }
    Ok(None)
}

/// The NEP-413 digest the approver's wallet signs. Shown to the agent as `approval_digest`.
fn nep413_digest(message: &str, authorization: &Authorization, vault: &str) -> Result<[u8; 32]> {
    #[derive(borsh::BorshSerialize)]
    struct Payload<'a> {
        message: &'a str,
        nonce: [u8; 32],
        recipient: &'a str,
        callback_url: Option<String>,
    }
    let nonce: [u8; 32] = B64
        .decode(&authorization.approval_nonce)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| invalid("approval nonce must be 32 bytes"))?;
    let mut bytes = 2_147_484_061u32.to_le_bytes().to_vec();
    borsh::to_writer(&mut bytes, &Payload { message, nonce, recipient: vault, callback_url: authorization.callback_url.clone() })
        .map_err(|_| invalid("cannot encode NEP-413 payload"))?;
    Ok(Sha256::digest(&bytes).into())
}

#[tokio::main]
async fn main() {
    let mut input = String::new();
    let response = if std::io::stdin().take(1024 * 1024).read_to_string(&mut input).is_err() {
        Err(invalid("cannot read the request"))
    } else {
        match serde_json::from_str::<Request>(&input) {
            Ok(request) => handle(request).await,
            Err(_) => Err(invalid("invalid vault request")),
        }
    };
    let (body, code) = match response {
        Ok(value) => (value, 0),
        Err(error) => (json!({"status": "error", "code": error.code, "message": error.message}), 1),
    };
    println!("{body}");
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_contract_refusal() {
        let text = r#"ExecutionError("Smart contract panicked: PerPaymentLimitExceeded")"#;
        assert_eq!(contract_refusal(text).as_deref(), Some("PerPaymentLimitExceeded"));
        assert_eq!(from_contract("PerPaymentLimitExceeded").code, "OWNER_APPROVAL_REQUIRED");
        assert_eq!(from_contract("PaymentAlreadyUsed").code, "PAYMENT_ALREADY_SETTLED");
        assert_eq!(from_contract("DailyLimitExceeded").code, "POLICY_LIMIT");
        assert_eq!(contract_refusal("no refusal here"), None);
    }

    #[test]
    fn recipients_name_their_chain() {
        let a = "0xF4D88218d13333247BF7616AFFb45F24a21E07cc";
        assert_eq!(parse_recipient(&format!("eip155:84532:{a}"), None).unwrap(), (Some(84532), a.to_ascii_lowercase()));
        assert_eq!(parse_recipient(a, Some(5042002)).unwrap().0, Some(5042002));
        assert!(parse_recipient(a, None).is_err());
        assert_eq!(parse_recipient("vendor.testnet", None).unwrap(), (None, "vendor.testnet".into()));
        assert!(parse_recipient("eip155:base:0x11", None).is_err());
        assert!(parse_recipient("eip155:84532:0x1234", None).is_err());
        let rpcs = parse_rpcs(Some("84532=https://sepolia.base.org, 5042002=https://rpc.testnet.arc.network"), Some("1"), Some("https://x.example")).unwrap();
        assert_eq!(rpcs.len(), 3);
        assert!(parse_rpcs(Some("84532:https://x"), None, None).is_err());
    }

    #[test]
    fn amounts_are_canonical() {
        assert!(parse_amount("100").is_ok());
        assert!(parse_amount("0").is_ok());
        assert!(parse_amount("010").is_err());
        assert!(parse_amount("1.5").is_err());
        assert!(parse_amount("").is_err());
    }

    #[test]
    fn inference_evidence_is_included_verbatim_or_omitted() {
        let dir = std::env::temp_dir().join(format!("styx-evidence-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let id = format!("0xABCDEF0123456789{}", "00".repeat(24));
        // No file: the field is omitted.
        assert_eq!(read_inference_evidence(&dir, &id).unwrap(), None);
        // A file named by the first 12 hex digits (lowercase) comes back unchanged.
        let evidence = json!({"schema": "styx-near-inference/1", "model": "m", "extra": {"kept": [1, 2]}});
        std::fs::write(dir.join("inference-abcdef012345.json"), serde_json::to_vec(&evidence).unwrap()).unwrap();
        assert_eq!(read_inference_evidence(&dir, &id).unwrap(), Some(evidence));
        // A different payment id does not pick it up.
        let other = format!("0x{}", "11".repeat(32));
        assert_eq!(read_inference_evidence(&dir, &other).unwrap(), None);
        // A damaged file is an error, not a silent omission.
        std::fs::write(dir.join("inference-111111111111.json"), b"not json").unwrap();
        assert!(read_inference_evidence(&dir, &other).is_err());
        // The base record is unchanged when the field is absent.
        let mut plain = json!({"schema": RECORD_SCHEMA});
        if let Some(e) = read_inference_evidence(&dir, &format!("0x{}", "22".repeat(32))).unwrap() {
            plain["inference_evidence"] = e;
        }
        assert_eq!(plain, json!({"schema": "styx-near-record/1"}));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn requests_parse_like_the_evm_binary() {
        let r: Request = serde_json::from_str(r#"{"method":"submit","payment_id":"0xab"}"#).unwrap();
        assert!(matches!(r, Request::Submit { signature_file: None, .. }));
        assert!(serde_json::from_str::<Request>(r#"{"method":"submit","payment_id":"0xab","extra":1}"#).is_err());
    }
}
