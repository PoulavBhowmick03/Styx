# Friction

Observations from building this adapter. Times are not measured.

1. **The docs do not show how to read a `bytes` column back.** The Select Fields and Filter pages cover other types. The Column Types page says "read hex back" but gives no example. **Expected:** one read example. **What happened:** we found `BytesValue = Value<"bytes", Hex>` in the SDK's type definitions, so the value is at `.value`.
2. **The SDK changed shape recently.** Version 0.8.1 has no `./schema` export and no `rabdi` chain, while the current docs need both, and 1.0.0 came out on 30 October 2026. **Expected:** a stated minimum version in the guide. **To reproduce:** `npm install @arkiv-network/sdk@0.8.1`, then import `@arkiv-network/sdk/schema`.
3. **The RPC URL is not listed in the first-entity guide.** The `rabdi` helper hides it, which is convenient, but we had to read it off the chain object to confirm it.

4. **The faucet funds the connected wallet, not an address you type.** We wanted test GLM on a separate publisher key. It arrived in the owner's MetaMask account, and the publisher read a balance of 0. **Expected:** the faucet page says which address it will pay, and a guide explains funding a key that has no browser wallet. **What happened:** we found it by reading both balances, then sent 5 tGLM across, which meant adding Rabdi to MetaMask by hand.
5. **An empty account gives an unhelpful error.** `createEntity` from an account with no funds first reported `EntityMutationError: Transaction failed: Execution error without revert data`. The cause only appeared on a second attempt, as viem's "exceeds the balance of the account". **Expected:** the SDK says the account has no funds.
6. **RPC errors can carry the access key.** The key is part of the RPC URL, so we strip it from any error text before printing. **Expected:** a note in the access-key docs.
7. **The public endpoint can stall with no answer.** Fetches with no access key hung for over 11 minutes once, and took over 45 seconds on repeated attempts, while `eth_blockNumber` on the same endpoint answered in under a second and a fetch with an access key took one second. **Expected:** a quick rate-limit error. **What we did:** added a 45-second limit that exits with its own code, so a stall is never read as nothing found.
