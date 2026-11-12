# Styx NEAR owner console

A static Vite/TypeScript page for an existing Styx vault. No deployment or contract changes.

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5174/?vault=vault.styx-owner-c87a.testnet (the default example vault).
Select testnet or mainnet, enter the RPC and vault account, then read the vault. Connect Meteor
or MyNearWallet for owner actions. A different or disconnected account remains read-only.
Amounts are token units at six decimals, with base units and attached NEAR shown before signing.
Do not assume an arbitrary token is Circle USDC; the canned vault uses worthless test tUSDC.

The page reads owner, token, pause, limits, current day/spend, token balance, token registration
and access keys from RPC. Event lists use the network's NearBlocks API, then fetch each transaction
and its receipt logs from RPC. Up to three pages (75 transactions) are read. The list is a window,
not a complete registry. Indexer outage is displayed; manual agent, approver and recipient lookups
still work. Current state is re-read for every discovered key. Gas allowance is shown in yoctoNEAR
and NEAR alongside receiver/method restrictions. Only historical successful payment events are
shown in the payment table; failed-payment and record events are listed separately.

The rule forms cover configure_agent, set_recipient, set_approver, set_vault_daily_limit,
pause, unpause and withdraw. Funding supports vault token registration (0.00125 NEAR), ft_transfer
(1 yoctoNEAR) and a test-token-only mint button restricted to testnet and the exact deployed test
contract. On load and before sending, RPC status.chain_id must match the selected wallet network. The send action also rechecks the connected owner and token. After the wallet returns, the
page waits for a known transaction's finality and re-reads chain state. Browser-wallet redirects
return to the same RPC/network/vault. An unavailable result is not a confirmed failure; inspect
state and transaction status before retrying. There is no automatic transaction retry.

Generating an agent key uses tweetnacl's browser randomness and downloads NEAR key-file JSON
(account_id, public_key, private_key). The private key is not put in DOM text, storage, logs or
RPC calls. It is not recoverable by the page after the download. Save it outside this repo.
The public key is copied into configure_agent; configure its limits/expiry and sign to install it.

Optional vault creation is skipped. This page neither fetches wasm nor calls deploy_code, and
VITE_VAULT_WASM_URL is unused. Use an existing vault. Real wallet transactions remain untested;
all signing code needs Poulav's review before it is trusted.

## Checks and static build

```sh
npm test
npm run typecheck
npm run build
npm run smoke
npm run smoke:wallet
```

For smoke, first run npm run dev. Install Chrome or set CHROME_PATH to its executable. CONSOLE_URL
overrides the local page URL. Playwright intercepts RPC/indexer calls using the captured public
vault fixture. No wallet is connected and no transaction is sent. `smoke:wallet` replaces Wallet Selector with a browser-only stand-in to test non-owner guards and an owner pause preview/send/readback. Run that check against the Vite dev server, not the static preview.

For Vercel, select owner-console-near as the project root. vercel.json builds npm run build and
serves dist. There are no browser secrets or required build-time env variables.

Fixture test/live-testnet.json contains public FastNEAR RPC responses captured on 12 November
2026: finalized views, access keys, one actual 140 tUSDC payment transaction and its block header.
The smoke's indexer envelope is synthetic around that real transaction; the actual testnet indexer
returned errors. Configuration/lifecycle parser cases use synthetic events with real public keys.
See ../docs/near/OWNER_CONSOLE.md for validation and limitations.
