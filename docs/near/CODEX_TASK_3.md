# Codex task 3: the owner's console on NEAR

Same repo and rules as tasks 1 and 2 (`/Users/odinson/Developer/Styx-near`, `main`, small
conventional commits, pull before every push, no keys in git, do not edit `contracts/`,
`sdk/near/`, `scripts/near/`, or `docs/near/` files other than the one named below). Read
`contracts/near/styx-vault/src/lib.rs` for every method and view, and `docs/near/TESTNET_RUN.md`
for the live accounts. Reuse what you can from `approval-page-near/` (wallet-selector setup,
RPC view helpers, the NEP-413 code) by copying it, not by importing across folders.

Today the owner sets a vault up with the near CLI (`scripts/near/setup_testnet.sh`). Build the
same thing as a page the owner uses from their NEAR wallet, in a new folder `owner-console-near/`
(Vite + TypeScript, static build, `vercel.json`).

## Screens

1. **Connect.** Wallet-selector (Meteor, MyNearWallet). Ask for a vault account id, or offer
   "deploy a new vault" (below). Read `get_vault`; if the connected account is not the owner,
   show the vault read-only and say why.
2. **Overview, all read from the chain.** Owner, token, paused, vault daily limit and today's
   spend (`current_day`, `spent_by_vault`), token balance of the vault (`ft_balance_of` on the
   token). Every agent and approver the owner configured: there is no list view in the contract,
   so derive them from the vault's own events. Fetch the vault's transactions from a public
   indexer API (try `https://api.nearblocks.io/v1/account/<vault>/txns`; if it fails, say the
   list is unavailable and still allow lookups by key), parse `EVENT_JSON` logs with
   `standard: "styx"` (`agent_configured`, `approver_set`, `recipient_set`, `payment_executed`,
   `payment_failed`, `record_sealed`), and then confirm each key's current state with
   `get_agent` / `get_approver` / `get_recipient`. Show the agent's function-call key and its
   remaining gas allowance from `view_access_key_list` on the vault account.
3. **Payments.** A table from `payment_executed` events: time, agent, recipient, amount,
   exception or not, signer, link to the transaction. Today's spend per agent against its daily
   limit as a simple bar.
4. **Change rules.** Forms for `configure_agent` (key, per-payment, daily, valid until, enabled),
   `set_recipient`, `set_approver`, `set_vault_daily_limit`, `pause`, `unpause`, `withdraw`.
   Amounts entered in USDC and converted to six-decimal base units, shown both ways before
   signing. Each form shows the exact method and JSON the wallet will sign. After a transaction,
   re-read the state from the chain and show it, rather than trusting the form.
5. **Fund.** Register the vault with the token (`storage_deposit`, 0.00125 NEAR) if it is not, and
   `ft_transfer` from the owner to the vault (1 yoctoNEAR deposit). For our test token only, a
   `mint` button labelled as test-token only.
6. **Add an agent.** Generate an ed25519 keypair in the browser, show the public key, offer the
   private key once as a download in NEAR's key-file JSON format (`public_key`, `private_key`),
   then call `configure_agent` with it. Say plainly that the key only ever exists in the browser
   and the download, and that the vault turns it into a function-call key limited to the pay
   methods.
7. **Deploy a new vault (optional, last).** Create `vault.<owner>` as a sub-account and deploy
   `styx_vault.wasm` with `new {owner, token}`. Load the wasm from a URL configured at build time
   (`VITE_VAULT_WASM_URL`); do not commit wasm into the page. If wallet-selector cannot deploy
   code from your wallet of choice, skip this screen and say so in the README.

## Tests

Vitest for the event parsing, unit conversion, and form-to-arguments mapping, against canned RPC
and indexer responses taken from the real testnet vault. A headless smoke check that the
overview renders with mocked responses.

## Report back

`docs/near/OWNER_CONSOLE.md`: how to run it, what was tested, what was not (real wallet
transactions in particular). Claim only what a test shows.
