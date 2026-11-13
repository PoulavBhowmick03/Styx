# NEAR owner console

> **13 Nov 2026:** MyNearWallet shut down in October 2026, so both pages now offer only Meteor Wallet. Mentions of MyNearWallet below are historical.

## Run locally

```sh
cd owner-console-near
npm ci
npm run dev
```

Open http://127.0.0.1:5174/?vault=vault.styx-owner-c87a.testnet. Choose a network, RPC and vault,
then read it. Meteor and MyNearWallet are available through Wallet Selector. A disconnected or
non-owner account sees read-only state. Each write has a separate JSON preview and sign step.
Amounts are entered with up to six decimals and displayed in token units and base units before
signing; attached NEAR is displayed too. No secrets belong in build-time env or query parameters.

The overview reads get_vault, current_day, spent_by_vault, ft_balance_of, storage_balance_of and
view_access_key_list. For discovered or manually entered keys it reads get_agent/get_approver/
get_recipient and spent_by_agent. Agent panels show current policy, today's spend bar, gas
allowance, receiver and method restrictions. All values come from the selected RPC.

The page fetches up to three NearBlocks pages (75 transactions), then confirms successful receipt
logs with RPC and reads current key state. It recognizes agent_configured, approver_set,
recipient_set, payment_executed, payment_failed and record_sealed. The payment table contains
successful events with time, agent, recipient, amount, exception/signer and transaction link.
Lists are explicitly a window, never a complete registry. Indexer failure displays an unavailable
or partial notice; it does not mean no keys or payments exist. Manual key/account lookups work
without an indexer. During live fixture capture, the mainnet endpoint returned an empty txns list
for this testnet account; the testnet endpoint returned HTTP 403, then HTTP 410. The console uses
the network-specific endpoint and does not treat mainnet's empty list as testnet history.

## Guided setup: two approvals after creating the vault

A new vault is set up in two steps, each one wallet approval, because each step's calls go to one
contract and NEAR runs a transaction's actions in order, failing them together:

1. **Register and fund** (token contract): `storage_deposit` if not yet registered, then `mint`
   (testnet test token) or `ft_transfer`.
2. **Set the rules** (vault): any of `set_vault_daily_limit`, `set_recipient`, `set_approver`,
   `configure_agent`, from the fields filled in. Each call gets 30 Tgas; on testnet these calls burned
   1.5 to 3.2 Tgas each. Presets (Cautious, Personal agent, Team) fill the limits.

The review lists every call. Before Preview vault and before every send, the console checks the
signer's spendable NEAR (balance minus storage) covers the attached deposit plus 0.05 NEAR for gas.
The approver step and the ready screen explain linking Telegram through @Styx_pvt_bot.

When every rule is set, the ready screen offers **Download agent settings**: an env file for
`scripts/near/mcp_config.sh` with the vault, approver key, and the paths where the agent key file and
state folder will live. It holds no key material. If the key was generated in the same visit, the
screen also shows the commands that move both downloads into `$HOME/.styx-near-agent/<vault>/`
(owner-only permissions) and print the `claude mcp add` line.

Status: covered by unit tests and the mocked-wallet browser test (`test/wallet-smoke.mjs`); not yet
run with a real Meteor wallet on testnet.

Owner methods: configure_agent, set_recipient, set_approver, set_vault_daily_limit, pause, unpause,
withdraw. Funding: storage_deposit for the vault (0.00125 NEAR), ft_transfer from the owner
(1 yoctoNEAR), and mint only for the exact Styx testnet test token. Registration is read first;
the register action is hidden when already registered and rechecked before signing.

Generate & download creates an ed25519 key in the browser and downloads NEAR key-file JSON once.
Only the public key is retained in the configure_agent form. No private key is sent to RPC,
logged or saved in browser storage. Save the download outside this repo. Configure its policy
and sign to install it as a function-call key restricted to pay, pay_with_exception, pay_evm, pay_evm_with_exception and post_record.

On load and before a write, the page checks RPC status.chain_id against the selected wallet network. It also rechecks the current owner, wallet account and token. It passes the
previewed receiver, method, JSON, gas and deposit to the wallet. After a known transaction hash
returns, it checks finality and success, then re-reads state. MyNearWallet's callback keeps the
RPC/network/vault context. Unknown wallet/RPC outcomes are not automatically retried.

## Build and checks

```sh
npm test
npm run typecheck
npm run build
# With npm run dev serving:
npm run smoke
npm run smoke:wallet
```

Chrome is required for smoke checks; set CHROME_PATH if its executable is not the macOS default.
CONSOLE_URL overrides http://127.0.0.1:5174. The static output is dist, with vercel.json ready
for a project rooted at owner-console-near. No deployment was performed.

Verified locally on 12 November 2026:

- 20 Vitest cases pass: exact conversion/uint128 boundary, invalid amounts, every form's arguments
  and attached deposit, test mint restrictions, real payment-event parsing and key discovery,
  rejecting failed/foreign/malformed events, other lifecycle event shapes, indexer shape errors,
  captured overview reads indexer outage handling and RPC/wallet network mismatch rejection.
- Fresh public FastNEAR RPC responses from vault.styx-owner-c87a.testnet are committed in
  test/live-testnet.json. They include the actual 140 tUSDC exception transaction
  7esYgW17uGo4tw5Lggj9LVgCUpvXufUWnMYzezLo2LyR, views, access keys and block header.
  No key file or decrypted invoice is in the fixture. The indexer success envelope used by tests
  is synthetic around the real transaction. Configuration/lifecycle parser examples are synthetic
  events populated with the live public keys; they are not claimed as captured configuration logs.
- Headless Chrome smoke passes against both Vite dev and the built static preview: overview,
  payment row, agent gas/spend bar, disconnected write guards, indexer failure notice and manual
  approver lookup render without uncaught browser errors.
- A second dev-server Chrome smoke uses a Wallet Selector stand-in. It confirms a connected
  non-owner cannot write; a mocked owner sees the pause JSON preview, the exact wallet call is
  made, its mock finality is checked and the changed paused state is re-read. No real wallet or
  transaction is involved in this test.
- TypeScript and static builds pass. Existing wallet dependencies emit browser-externalization,
  eval and large-chunk warnings during the build.

Not tested on 12 November (since then a real wallet has created, funded and configured a vault from the
console, see `TESTNET_RUN.md`): real wallet connection/signing or MyNearWallet redirects; actual configure/fund/
withdraw/mint transactions; real browser key-download handling; a live successful indexer history
request; complete key enumeration; a mainnet vault; Vercel deployment; load, concurrent owner
changes or exhaustive malformed RPC responses. The supplied RPC is trusted; its reported chain_id is checked, not independently attested. Poulav must review signing code before it is trusted.

The console deploys no wasm itself: since 13 November "Create a vault" calls the factory
`styx-vaults.testnet`, which deploys the vault code. No contract
changes, Chain Signatures, Intents or TEE attestation were added. It makes no private-payment claim.
