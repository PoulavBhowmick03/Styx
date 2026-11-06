# Vault setup page

A static page where an owner, in their own wallet, deploys or connects a vault, sets limits, manages vendors, funds it, pauses and withdraws. Built with viem and Vite. It never asks for or holds a private key: the wallet signs every transaction.

```bash
npm install --legacy-peer-deps         # needs Foundry: the page builds the vault itself, see below
npm run dev                            # http://127.0.0.1:5173
npm run typecheck && npm test && npm run e2e
```

`npm run e2e` needs `anvil`, `forge`, `cast` and Chrome. `forge build` in `contracts/evm` is not needed. Anvil answers the page's wallet requests, so it covers the page and not a real wallet extension. No real wallet (MetaMask or otherwise) has been tested with this page.

## What it does

- **Connect or deploy.** Deploys `ErebusPolicyVault(owner, token)`. `scripts/prepare-artifact.mjs` builds it with the settings of the Arc testnet deployment recorded in `docs/mumbai/STATUS.md` (optimizer 200 runs, EVM cancun) into `public/vault-artifact.json`, which is never committed. The repo's own `forge build` has the optimizer off and gives different bytecode. Connecting to an existing vault compares its code with that build, ignoring the owner and token addresses and the compiler's metadata trailer. A vault that differs is flagged, not blocked. Checked read-only against the Arc vault on 6 November 2026: it matches. This is a convenience check, not a proof: the contract still needs a human review.
- **Limits.** Agent, per-payment limit, daily limit, validity in whole days. Shows the policy version and warns that saving moves it, which invalidates every unused approval.
- **Vendors.** Allow, remove, check an address. The list is read from the vault's `RecipientSet` events, and Arc's public RPC allows only 10,000 blocks per `eth_getLogs` call and rate-limits bursts (its docs give the first; the second was observed on the live endpoint on 6 November 2026). So the page finds the vault's creation block (remembered, or from a hint checked on-chain with two lookups, or by searching old state), then reads in chunks of at most 9,999 blocks, newest first. Reads wait and retry on `-32014` and on rate limits, and say so. Later refreshes read only new blocks. If the RPC cannot say when the vault was created, the page reads only the most recent ~120,000 blocks and says the list is partial. A build can narrow that window with `VITE_LOG_FALLBACK_PAGES` (default 12 pages of 9,999 blocks); the browser test builds with 2 so it only has to mine about 25,000 blocks. Open the page with `?created=<block>` to give it the creation block. Check address always works. Labels stay in this browser and go into a downloadable `owner-config.json` for the approval page. Keep that file outside the repository.
- **Fund.** USDC `transfer` into the vault, the only way it can receive money.
- **Protection panel.** Says the vault protects only what is inside it, and checks that the vault is funded, the agent is not the owner, the agent's address holds gas only, and the vault is not paused.
- **Pause, unpause, withdraw.** Withdraw has a review step.

## Limits to know

- Arc testnet only. On any other chain it is a rehearsal mode and you paste the token address.
- It handles 6-decimal USDC only and refuses any other token. Amounts are parsed from text to bigints and never pass through a JavaScript number. Input finer than 6 decimals is refused, not rounded.
- Gas thresholds in `src/protection.ts` (0.05 minimum, 0.5 ceiling for the agent) are guidance based on `RUNBOOK.md`'s figures, not contract rules.
- The page cannot move money out of the agent's address, since it never holds that key. It tells the owner how much to move.
- The owner must be a plain account. Smart-contract wallets are not supported by the vault.
- Not audited.
