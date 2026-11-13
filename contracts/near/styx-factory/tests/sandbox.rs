//! The factory on a NEAR sandbox, with its real wasm and the embedded vault code: a vault created
//! by one call is owned by the caller and has no access keys; a failed creation refunds the
//! deposit; a small deposit and a bad name are refused before anything is created.

use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract};
use serde_json::{json, Value};

/// Builds the factory through contracts/near/build.sh (its build.rs builds the vault it embeds
/// first if needed), so `cargo test` works from a clean checkout, like the vault's sandbox test.
fn build_wasm() -> Vec<u8> {
    let status = std::process::Command::new("../build.sh").arg("./").status().expect("run build.sh");
    assert!(status.success(), "build.sh failed for the factory");
    std::fs::read("target/near/styx_factory.wasm").expect("wasm")
}

async fn setup() -> anyhow::Result<(near_workspaces::Worker<near_workspaces::network::Sandbox>, Contract, Account)> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = build_wasm();
    let factory = worker.dev_deploy(&wasm).await?;
    factory.call("new").transact().await?.into_result()?;
    let alice = worker.root_account()?.create_subaccount("alice").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    Ok((worker, factory, alice))
}

#[tokio::test]
async fn creates_a_vault_owned_by_the_caller_and_refunds_a_failed_one() -> anyhow::Result<()> {
    let (worker, factory, alice) = setup().await?;
    let min: Value = factory.view("min_deposit").await?.json()?;
    let min: u128 = min.as_str().unwrap().parse()?;
    let deposit = NearToken::from_yoctonear(min + NearToken::from_millinear(500).as_yoctonear());

    let created = alice.call(factory.id(), "create_vault").args_json(json!({"name":"acme","token":"usdc.test.near"}))
        .deposit(deposit).max_gas().transact().await?;
    let vault: Option<String> = created.clone().into_result()?.json()?;
    let vault = vault.expect("vault created");
    assert_eq!(vault, format!("acme.{}", factory.id()));
    assert!(created.logs().iter().any(|l| l.contains("vault_created")));

    let info: Value = worker.view(&vault.parse()?, "get_vault").await?.json()?;
    assert_eq!(info["owner"], alice.id().as_str());
    assert_eq!(info["token"], "usdc.test.near");
    assert!(worker.view_access_keys(&vault.parse()?).await?.is_empty(), "a factory vault has no access keys");
    let count: u64 = factory.view("vaults_created").await?.json()?;
    assert_eq!(count, 1);

    // The same name again: the creating receipt fails (account exists) and the deposit comes back.
    // Balances are compared signed: a gas refund from the first call can land after `before`.
    let before = alice.view_account().await?.balance.as_yoctonear() as i128;
    let factory_before = factory.view_account().await?.balance.as_yoctonear() as i128;
    let again = alice.call(factory.id(), "create_vault").args_json(json!({"name":"acme","token":"usdc.test.near"}))
        .deposit(deposit).max_gas().transact().await?;
    let none: Option<String> = again.clone().into_result()?.json()?;
    assert_eq!(none, None);
    assert!(again.logs().iter().any(|l| l.contains("vault_creation_failed")));
    let after = alice.view_account().await?.balance.as_yoctonear() as i128;
    let factory_after = factory.view_account().await?.balance.as_yoctonear() as i128;
    let tenth = NearToken::from_millinear(100).as_yoctonear() as i128;
    assert!(before - after < tenth, "alice lost {} yocto: more than gas", before - after);
    assert!(factory_after - factory_before < tenth, "the factory kept {} yocto", factory_after - factory_before);
    Ok(())
}

#[tokio::test]
async fn refuses_a_small_deposit_and_a_bad_name_before_creating_anything() -> anyhow::Result<()> {
    let (worker, factory, alice) = setup().await?;
    let small = alice.call(factory.id(), "create_vault").args_json(json!({"name":"cheap","token":"usdc.test.near"}))
        .deposit(NearToken::from_near(1)).max_gas().transact().await?;
    assert!(format!("{:?}", small.into_result().unwrap_err()).contains("DepositTooSmall"));
    let bad = alice.call(factory.id(), "create_vault").args_json(json!({"name":"Bad.Name","token":"usdc.test.near"}))
        .deposit(NearToken::from_near(5)).max_gas().transact().await?;
    assert!(format!("{:?}", bad.into_result().unwrap_err()).contains("InvalidName"));
    assert!(worker.view_account(&format!("cheap.{}", factory.id()).parse()?).await.is_err());
    Ok(())
}
