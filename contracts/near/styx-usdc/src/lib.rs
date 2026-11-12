//! A NEP-141 token with six decimals, the shape of USDC, for testing the Styx vault on NEAR
//! testnet. Anyone can mint to a registered account, so it is worth nothing. It is not Circle's
//! USDC and the README says so.

use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{StorageBalance, StorageBalanceBounds, StorageManagement};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&env::current_account_id());
        Self { token }
    }

    /// Mints `amount` to `account_id`, which must already be registered (`storage_deposit`).
    pub fn mint(&mut self, account_id: AccountId, amount: U128) {
        self.token.internal_deposit(&account_id, amount.0);
        near_contract_standards::fungible_token::events::FtMint {
            owner_id: &account_id,
            amount: amount,
            memo: None,
        }
        .emit();
    }
}

near_contract_standards::impl_fungible_token_core!(Contract, token);

// The `impl_fungible_token_storage!` macro in near-contract-standards 5.30.1 declares
// `storage_withdraw(Option<U128>)` while the trait wants `Option<NearToken>`, so the storage
// methods are written out here.
#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Styx test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 6,
        }
    }
}
