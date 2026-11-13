//! Styx vault factory. One call from the owner's wallet creates a vault:
//!
//! `create_vault({name, token})` with an attached deposit creates `<name>.<factory>`, funds it with
//! the deposit, deploys the Styx vault code and calls its `new` with the caller as owner. Those
//! four actions travel in one receipt, so they succeed or fail together: there is never a half-made
//! vault. If the receipt fails (the name is taken, the deposit cannot cover the code), the callback
//! sends the deposit back to the caller.
//!
//! The vault gets no access keys. Nobody, the factory included, can later replace its code or take
//! its funds; the vault adds only the restricted agent keys its owner configures.
//!
//! The vault code is embedded at build time from `../styx-vault/target/near/styx_vault.wasm`, so
//! build the vault first (`contracts/near/build.sh contracts/near/styx-vault`).

use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

/// The Styx vault contract this factory deploys.
pub const VAULT_CODE: &[u8] = include_bytes!("../../styx-vault/target/near/styx_vault.wasm");

/// Kept on the vault beyond its code's storage: its first state, and gas for the agent's key.
pub const VAULT_EXTRA: NearToken = NearToken::from_millinear(500);

const GAS_FOR_NEW: Gas = Gas::from_tgas(30);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(10);

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// Vaults created so far. Informational only.
    created: u64,
}

#[near]
impl Factory {
    #[init]
    pub fn new() -> Self {
        Self { created: 0 }
    }

    /// The smallest deposit `create_vault` accepts, in yoctoNEAR: the code's storage plus
    /// `VAULT_EXTRA`. Wallets should attach a little more for a vault that will pay often.
    pub fn min_deposit(&self) -> U128 {
        U128(required_deposit().as_yoctonear())
    }

    /// The vault account a name maps to, or a panic naming why the name is refused.
    pub fn vault_account(&self, name: String) -> AccountId {
        account_for(&name)
    }

    pub fn vaults_created(&self) -> u64 {
        self.created
    }

    pub fn vault_code_hash(&self) -> String {
        near_sdk::bs58::encode(env::sha256(VAULT_CODE)).into_string()
    }

    /// Creates `<name>.<factory>` as a Styx vault owned by the caller, paying for it with the
    /// attached deposit. Returns the vault account on success; on failure the deposit is refunded.
    #[payable]
    pub fn create_vault(&mut self, name: String, token: AccountId) -> Promise {
        let vault = account_for(&name);
        let deposit = env::attached_deposit();
        require!(deposit >= required_deposit(), format!("DepositTooSmall: attach at least {} yoctoNEAR", required_deposit().as_yoctonear()));
        let owner = env::predecessor_account_id();
        let args = near_sdk::serde_json::json!({ "owner": owner, "token": token, "mpc_signer": null });
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit)
            .deploy_contract(VAULT_CODE.to_vec())
            .function_call("new".to_string(), near_sdk::serde_json::to_vec(&args).expect("json"), NearToken::from_yoctonear(0), GAS_FOR_NEW)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_vault_created(vault, owner, token, U128(deposit.as_yoctonear())),
            )
    }

    /// Records a created vault, or refunds the deposit when the creating receipt failed.
    #[private]
    pub fn on_vault_created(
        &mut self,
        vault: AccountId,
        owner: AccountId,
        token: AccountId,
        deposit: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> Option<AccountId> {
        match result {
            Ok(()) => {
                self.created += 1;
                log_event("vault_created", near_sdk::serde_json::json!({ "vault": vault, "owner": owner, "token": token, "deposit": deposit }));
                Some(vault)
            }
            Err(_) => {
                // A failed receipt returns its attached deposit to this factory; pass it back.
                // near-sdk schedules a promise when it is dropped.
                drop(Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(deposit.0)));
                log_event("vault_creation_failed", near_sdk::serde_json::json!({ "vault": vault, "owner": owner, "refunded": deposit }));
                None
            }
        }
    }
}

fn required_deposit() -> NearToken {
    env::storage_byte_cost()
        .saturating_mul(VAULT_CODE.len() as u128)
        .saturating_add(VAULT_EXTRA)
}

/// `name` must be one lowercase NEAR account label: 2 to 32 characters of a-z, 0-9, `-` or `_`,
/// starting and ending with a letter or digit, with no two separators in a row. No dots, so a
/// vault is always a direct sub-account of this factory.
fn account_for(name: &str) -> AccountId {
    let bytes = name.as_bytes();
    let ok_char = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_';
    let separator = |c: &u8| *c == b'-' || *c == b'_';
    require!(
        (2..=32).contains(&bytes.len())
            && bytes.iter().all(ok_char)
            && !separator(&bytes[0])
            && !separator(&bytes[bytes.len() - 1])
            && !bytes.windows(2).any(|w| separator(&w[0]) && separator(&w[1])),
        "InvalidName: use 2 to 32 of a-z, 0-9, - or _, starting and ending with a letter or digit"
    );
    format!("{}.{}", name, env::current_account_id())
        .parse()
        .unwrap_or_else(|_| env::panic_str("InvalidName: the vault account would be too long"))
}

fn log_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({ "standard": "styx-factory", "version": "1.0.0", "event": event, "data": [data] })
    ));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn context(deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("styx-factory.testnet".parse().unwrap())
            .predecessor_account_id("alice.testnet".parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    #[test]
    fn names_map_to_direct_sub_accounts() {
        context(NearToken::from_near(0));
        let f = Factory::new();
        assert_eq!(f.vault_account("acme-pay".into()).as_str(), "acme-pay.styx-factory.testnet");
        assert_eq!(f.vault_account("a1".into()).as_str(), "a1.styx-factory.testnet");
    }

    #[test]
    fn refuses_bad_names() {
        for bad in ["a", "Acme", "acme.pay", "-acme", "acme-", "ac--me", "acme pay", "", &"x".repeat(33)] {
            context(NearToken::from_near(0));
            let f = Factory::new();
            let r = std::panic::catch_unwind(|| f.vault_account(bad.to_string()));
            assert!(r.is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn min_deposit_covers_the_code() {
        context(NearToken::from_near(0));
        let f = Factory::new();
        let code_cost = env::storage_byte_cost().as_yoctonear() * VAULT_CODE.len() as u128;
        assert!(f.min_deposit().0 > code_cost);
        assert_eq!(f.min_deposit().0, code_cost + VAULT_EXTRA.as_yoctonear());
    }

    #[test]
    #[should_panic(expected = "DepositTooSmall")]
    fn refuses_a_small_deposit() {
        context(NearToken::from_near(1));
        let mut f = Factory::new();
        drop(f.create_vault("acme".into(), "usdc.testnet".parse().unwrap()));
    }

    #[test]
    fn refunds_the_caller_when_creation_fails_and_counts_successes() {
        context(NearToken::from_near(0));
        let mut f = Factory::new();
        let vault: AccountId = "acme.styx-factory.testnet".parse().unwrap();
        let owner: AccountId = "alice.testnet".parse().unwrap();
        let token: AccountId = "usdc.testnet".parse().unwrap();
        assert_eq!(f.on_vault_created(vault.clone(), owner.clone(), token.clone(), U128(4), Err(PromiseError::Failed)), None);
        assert!(get_logs()[0].contains("vault_creation_failed"));
        assert_eq!(f.vaults_created(), 0);
        assert_eq!(f.on_vault_created(vault.clone(), owner, token, U128(4), Ok(())), Some(vault));
        assert_eq!(f.vaults_created(), 1);
    }
}
