# Erebus at ETHGlobal Mumbai: build plan

Payment controls with verifiable evidence, built on existing Erebus code (Continuity track).

Written 6 November 2026. This plan starts from GPT's `Erebus_Implementation_Roadmap.docx` and makes six changes to it:

1. The demo shows real contract attacks instead of an inbox prop.
2. The payment event records the enforced policy.
3. The reviewer uses the existing disclosure CLI and MCP tools.
4. Arkiv comes before World.
5. The demo uses small amounts.
6. Arc Studio's CLI handles the existing-repo workflow.

## 0. Ground rules

- **Track.** Continuity. ETHGlobal allows work on existing code only for an approved Continuity entry. Confirm it on the dashboard before G1, and keep the confirmation.
- **Provenance.** The first commit imports Erebus `origin/main` at `d56c777036701138b535c22fb32f320e5c351979`, labelled as pre-existing. `PROVENANCE.md` lists every imported path. Every later commit is Mumbai work. Commit small and often.
- **Secrets.** No key material, `.env` files or keystores in the repo, test keys included. Use testnet funds only.
- **Review.** Poulav reviews every line of contract and signing code before it is trusted.
- **Claims.** Claim only what a test or the live demo shows (section 13).
- **AI use.** Record which files AI tools wrote or helped with in `docs/mumbai/ai-usage.md`, and keep the prompts there.

## 1. What we build

A funded vault on Arc does three things:

- It pays an agent's routine invoices within the owner's rules.
- It needs the owner's signature over the exact payment before allowing an exception.
- It gives a reviewer one record they can check against the chain.

| Role | Holds | Can | Cannot |
| --- | --- | --- | --- |
| Owner | Owner key, in a separate wallet and browser profile | Set policy, allow vendors, sign exceptions, pause, withdraw | Nothing withheld |
| Agent | Agent key (gas only) and the MCP tools | Propose and submit payments the vault allows | Change policy, sign exceptions, withdraw |
| Reviewer | A disclosure key and their own Arc RPC | Open one disclosed record and verify it against Arc | Read any other record |

**In scope:**
- One vault per owner and one agent.
- USDC only, through its ERC-20 interface, on Arc testnet.
- One reviewer record format.
- MCP tools and a minimal owner signing page.

**Out of scope:**
- Shielding, stealth addresses, cross-chain settlement.
- A negotiation engine, delivery escrow, AP2 integration.
- Budgets shared across several agents, an attack detector, production key management.

## 2. Gates, in order

| Gate | Passes when |
| --- | --- |
| G0 | The Continuity entry is confirmed, the repo is imported with provenance, and the Arc Studio project exists |
| G1 | The vault is deployed on Arc testnet and funded. A 0.25 USDC ordinary payment settles. Attacks A1 and A2 revert |
| G2 | An owner-signed 6 USDC exception settles. Attacks A3 and A4 revert |
| G3 | A reviewer on a second machine verifies the record against Arc with their own RPC. A tampered copy fails. A second record does not open |
| G4 | Arkiv: the encrypted record is published. The reviewer fetches it with every Erebus process stopped, then verifies it as in G3 |
| G5 | World Agent Pass: fresh authentication gates the owner signing page, and a denied or expired attempt never reaches signing |

The core is G0 to G3. Arkiv (G4) comes before World (G5) for four reasons:

- Arkiv's existing-project prize is $3,000 / $1,000; World's Continuity prize is $1,500 / $1,000.
- Arkiv needs no server; World needs backend token validation.
- Arkiv strengthens the evidence story.
- World's Mumbai proofs are mocked.

Select a partner prize at submission only if its gate passed.

## 3. Demo amounts

Use small amounts from the start, so funding never blocks anything.

| Setting | Value |
| --- | --- |
| Per-payment limit | 1 USDC |
| Daily limit | 10 USDC |
| Ordinary payment | 0.25 USDC to vendor A |
| Exception | 6 USDC to vendor A |
| Vault funding | 8 USDC, ERC-20 balance |
| Agent gas | A separate small native USDC balance |

The USDC ERC-20 interface uses 6 decimals, so 1 USDC is `1_000_000`. The native gas balance uses 18 decimals. Never mix the two, and never pass amounts through JavaScript floating point.

## 4. Contract: `ErebusPolicyVault`

`contracts/evm/src/ErebusPolicyVault.sol`, with tests in `contracts/evm/test/ErebusPolicyVault.t.sol`. Use Foundry with solc 0.8.24, the repo's pin. The vault is not upgradeable.

- **Immutable:** `owner`, and `token` (the USDC ERC-20 interface, `0x3600000000000000000000000000000000000000` on Arc testnet).
- **State:**
  - `agent`, `policyVersion`, `perPaymentLimit`, `dailyLimit`, `policyValidUntil`, `paused`
  - `allowedRecipient[address]`
  - `spentByDay[uint256]`
  - `consumedPayment[bytes32]`, `consumedApprovalNonce[uint256]`, `paymentHashById[bytes32]`
- **Owner only:** `configurePolicy(agent, perPaymentLimit, dailyLimit, validUntil)`, `setRecipient(recipient, allowed)`, `pause()`, `unpause()`, `withdraw(to, amount)`. Every policy, allowlist or agent change increments `policyVersion`. No change ever resets `spentByDay`.
- **Agent only** (`msg.sender == agent`): `pay(Payment p)` and `payWithException(Payment p, ExceptionAuthorization a, bytes ownerSignature)`.

EIP-712 domain: `{ name: "ErebusPolicyVault", version: "1", chainId, verifyingContract }`.

```
Payment(bytes32 paymentId,address agent,address token,address recipient,uint256 amount,bytes32 evidenceCommitment,uint256 policyVersion,uint64 validUntil)
ExceptionAuthorization(bytes32 paymentHash,uint256 approvalNonce,uint64 authorizationExpiry)
```

`paymentHash` is the EIP-712 struct hash of `Payment`. The owner signs the typed `ExceptionAuthorization`.

The vault runs these checks in order, then applies effects before the transfer:

1. The caller is `agent`, the vault is not paused, and `now <= policyValidUntil`.
2. The payment fields match:
   - `p.agent == agent`, `p.token == token`, `p.policyVersion == policyVersion`;
   - `now <= p.validUntil` and the amount is above zero;
   - the recipient is nonzero and allowed.
3. `paymentId` has not been used.
4. With `day = block.timestamp / 86400`, `spentByDay[day] + amount <= dailyLimit`.
5. The limit check depends on the path:
   - **Ordinary:** `amount <= perPaymentLimit`.
   - **Exception:** the signature recovers to `owner` over the typed authorization for this exact payment, the nonce is unused, and `now <= authorizationExpiry`. An exception lifts only the per-payment limit.
6. Effects, in this order:
   - Mark `paymentId` consumed, store the payment hash, consume the nonce, and add to `spentByDay`.
   - Then transfer with a safe ERC-20 transfer that reverts on failure.
   - A reentrancy guard covers both entry points.

**Change 2: the event records the policy it enforced.**

```solidity
event PaymentExecuted(
    bytes32 indexed paymentId,
    address indexed recipient,
    uint256 amount,
    bytes32 paymentHash,
    bytes32 evidenceCommitment,
    uint256 policyVersion,
    uint256 perPaymentLimit,
    uint256 dailyLimit,
    uint256 day,
    uint256 daySpentAfter,
    bool exception,
    bytes32 approvalDigest // zero for ordinary payments
);
```

The vault emits `PaymentExecuted` only after its checks pass. A reviewer who pins the vault's code hash can therefore read the enforced limits straight from the log, with no historical state queries. Also emit `PolicyConfigured`, `RecipientSet`, `Paused`, `Unpaused` and `OwnerWithdrawal`.

**Signature check.** By default, reuse the reviewed ECDSA routine in `ErebusSettlement.sol` (65-byte signatures, low-s, nonzero signer), so the vault needs no new dependency. `foundry.toml` currently has `libs = []`. The owner is a plain account (EOA) for the MVP. If Arc Studio's output pins OpenZeppelin, using its ECDSA and EIP712 helpers is fine instead. Decide once, in the first hour.

**Gotcha: `v`.** That routine rejects any `v` other than 0 or 1, the raw recovery id the Rust SDK produces. Wallets such as MetaMask return `v` = 27 or 28 from `eth_signTypedData_v4`. The vault must accept 27 and 28 by subtracting 27, or the owner's real signature will revert with `BadSignature`. Test this with a signature in wallet format, not only one from the Rust SDK.

**Tests, at minimum:**
- **Basic paths:**
  - an ordinary payment succeeds;
  - a wrong caller, a disallowed recipient and a zero amount all fail;
  - a payment over the per-payment limit fails (A1);
  - a payment over the daily limit fails, even with an exception;
  - an expired policy fails;
  - pausing blocks both paths;
  - only the owner can call admin functions.
- **Bad exception signatures:**
  - signed by the agent key (A2) or any other non-owner;
  - signed for the wrong chain, vault, agent, token, recipient (A3), amount, commitment, policy version or expiry.
- **Replay and policy changes:**
  - a payment ID reused across both paths fails;
  - a reused nonce fails (A4);
  - a policy change invalidates pending signatures without resetting the day's spend.
- **Edges and rollback:**
  - exactly at the limit and one unit over;
  - the UTC day boundary;
  - a failed transfer rolls back all state.
- **Event and cross-language checks:**
  - the event fields equal the enforced values;
  - the TypeScript (viem `hashTypedData`) and Rust digests equal the Solidity digest for one fixed vector.

**Arc facts:**
- Chain ID `5042002`.
- RPC `https://rpc.testnet.arc.io`; Blockdaemon, dRPC and QuickNode endpoints also exist.
- Explorer `https://explorer.testnet.arc.io`. Test USDC from `https://faucet.circle.com`.
- The mempool enforces a 20 gwei `maxFeePerGas` floor.
- Transfers to `address(0)` revert.
- A USDC blocklist revert consumes gas without producing a receipt, so the client treats "no receipt" as unknown, never as failed.

## 5. Arc Studio (change 6)

First, ask the Arc booth one question. For the Continuity track, does it qualify to clone our public repo into Studio, extend it there and deploy from Studio?

Commands from Arc's CLI docs. The install steps are at `https://docs.arc.io/ai/arc-studio-cli-install.md`; read that page rather than guessing.

- `arc-studio login`
- `arc-studio clone <owner>/<repo>` clones a public GitHub repo into the Studio workspace.
- `arc-studio run "<prompt>" --output json` runs a prompt and returns the workspace `webUrl`.
- `arc-studio deployments` lists deployed addresses.
- `arc-studio pull --out ./contracts --paths "contracts/**"` brings Studio's files back.
- `arc-studio open` opens the workspace.

Flow:

1. Push the repo publicly and clone it into Studio. Studio is then the starting point for the Arc work.
2. Write the vault inside that Studio workspace from section 4, either by prompting Studio with section 4 or in its editor.
3. Test there and deploy to Arc testnet. Record the address, deploy transaction and block.
4. Pull the result back as one commit marked "from Arc Studio". Poulav reviews that commit line by line.
5. If the booth confirms local edits are fine afterwards, iterate locally and redeploy through Studio, recording each deployment.

Don't build the vault elsewhere and paste it into Studio afterwards. Keep the shareable Studio URL for the submission, and show Studio in the video.

## 6. Agent side: Rust module, CLI and MCP tools

**Rust, in `sdk/evm`:**
- A new module, `sdk/evm/src/arc_vault/`, containing:
  - configuration: chain, RPC list with failover, vault address, token;
  - ABI bindings, and the `Payment` and `ExceptionAuthorization` types;
  - EIP-712 digests that must equal Solidity's (test vector);
  - transaction builders for `pay` and `payWithException`;
  - event decoding;
  - status reads (`consumedPayment`, `paymentHashById`);
  - receipt waiting that returns "unknown" when no receipt appears.
- A new binary, `erebus-vault` (`sdk/evm/src/bin/erebus_vault.rs`), with JSON in and out. Commands: `propose`, `request-approval` (writes a pending-approval JSON file), `submit`, `status`, `export-record`.
- Durability:
  - Persist the payment ID and digest in the existing journal (`sdk/journal`) before submitting.
  - After a timeout, reconcile by payment ID.
  - Never mint a new ID to retry.

**MCP, in `mcp-server`:**
- A new module, `mcp-server/src/erebus_mcp/vault.py`. It is enabled only by explicit config and exposes:
  - `erebus_propose_payment`, `erebus_submit_payment`, `erebus_payment_status`, `erebus_request_owner_approval`.
- Each tool calls `erebus-vault` through the existing subprocess pattern.
- Errors come back structured: `POLICY_LIMIT`, `OWNER_APPROVAL_REQUIRED`, `POLICY_VERSION_CHANGED`, `PAYMENT_ALREADY_SETTLED`, `VERIFICATION_UNAVAILABLE`.
- The agent's environment holds only the agent key: no owner key, no policy or withdraw tools, no arbitrary signing.
- The existing Starknet and Monad tools keep their current behaviour.

## 7. Owner approval page

A single static page (Vite and viem, or plain HTML and viem), served locally. Open it in the owner's own browser profile with the owner wallet.

- It loads one pending-approval JSON file, through a file picker or a local URL.
- It shows:
  - the vault;
  - the vendor label, taken from the owner's allowlist config and never from the agent's text;
  - the full recipient address, the amount and the invoice reference;
  - the expiry, and which rule the payment exceeds.
- It signs `ExceptionAuthorization` with `eth_signTypedData_v4` and outputs the signature JSON for `erebus_submit_payment`.
- The core needs no server, and the page never sees the agent key. World adds a backend later (section 11).

## 8. Reviewer: the existing disclosure path (change 3)

No new reviewer web console. Extend what already exists.

- **Encryption:**
  - Reuse `DisclosureGrant` (`sdk/transport/src/disclosure.rs`) with a new payload namespace for vault payment records.
  - Do not invent a new encryption format.
- **Record v1:**
  - schema version, chain ID, vault address, vault code hash;
  - the `Payment`, and the policy snapshot as emitted;
  - `ExceptionAuthorization` and the owner signature, when present;
  - the evidence opening: canonical invoice bytes plus a 32-byte salt;
  - transaction hash, block number, log index.
- **Verification** (extend `sdk/evm/src/disclosure.rs` and the `erebus-disclosure` CLI):
  1. Open the grant with the reviewer key.
  2. Recompute the evidence commitment and the payment hash.
  3. For an exception, verify the owner signature.
  4. Using the reviewer's own RPC, fetch the receipt and the `PaymentExecuted` log, check the vault's code hash, and compare every field.
  5. Report four results separately: record integrity, authorization, settlement, and policy at execution (from the event). An unknown RPC state reads "unavailable", never "unpaid".
- **MCP reviewer server** (`mcp-server/src/erebus_mcp/disclosure.py`, kept separate from the agent's tools):
  - Add `export_vault_payment` and `verify_vault_payment`.
  - They sit beside the existing `create_disclosure_key`, `export_deal_disclosure` and `verify_disclosed_payment`.
- **Demo:** run the reviewer on a second laptop or a clean profile, with only the reviewer key and its own RPC. Show a tampered copy failing, and a second record that does not open.

## 9. The demo attacks (change 1)

| ID | Attempt | Expected |
| --- | --- | --- |
| A1 | The agent calls `pay()` directly for 6 USDC, skipping MCP | Reverts: over the per-payment limit |
| A2 | The agent signs the exception with its own key and calls `payWithException` | Reverts: the signer is not the owner |
| A3 | The owner signs a 6 USDC exception to vendor A; the agent submits it with vendor B, also allowed | Reverts: digest mismatch |
| A4 | The agent resubmits the settled exception | Reverts: payment ID or nonce already used |

After the attacks, the owner-approved payment settles. Script each attack, with a Foundry script or the CLI, so rehearsal and the live demo behave identically. The Cornell/Yale inbox-code study is one line of motivation only; the demo has no inbox.

## 10. Arkiv (G4, before World)

- **Publish:**
  - Write the encrypted grant bytes as an Arkiv entity on the Rabdi testnet (chain ID `7794095`) with `@arkiv-network/sdk`.
  - Index the app and schema version plus a random lookup tag; store the ciphertext as bytes; expire it after 7 days.
  - Use a separate Arkiv publisher key funded with test GLM, and get the access key as Arkiv's docs describe.
- **Fetch:**
  - The reviewer fetches by tag with every Erebus process stopped, then runs the verifier from section 8.
  - Settlement never depends on the Arkiv write, and a local export always exists.
- **Required files:** `arkiv/schema.md`, `arkiv/friction.md`, `arkiv/reach.md`, `arkiv/why-arkiv.md`, `arkiv/how-you-use-arkiv.md`. The README lists the writer address and one query judges can run.
- **Tooling:** a small TypeScript publish-and-fetch script is enough, called from the CLI or by hand.

## 11. World (G5, last)

- Behind a feature flag. Before the owner page shows the sign button, require a fresh World Agent Pass authentication:
  - use the official OIDC flow;
  - validate the token on a small backend;
  - bind it to the enrolled owner.
- A denied, cancelled or expired attempt never reaches signing.
- The contract never checks World; the owner's signature is what authorizes the payment. World's Mumbai proofs are mocked, and the README and video say so.
- World requires all of:
  - the success path and a failure path;
  - backend validation;
  - an integration debrief covering time to first success, friction, missing docs and the single biggest improvement.

## 12. Who does what

| Area | Owner |
| --- | --- |
| Contract, tests, Arc deploy, EIP-712 vectors | Poulav |
| `arc_vault` Rust module, `erebus-vault` CLI, journal integration | Poulav |
| Disclosure record and verifier | Poulav |
| Reviewer MCP tools | Ishita |
| Agent MCP tools, agent harness, attack scripts | Ishita |
| Owner signing page | Ishita |
| Arkiv adapter and files | Whoever is free after G3 |
| World | Ishita, after G4 |

One coding agent writes a given file and the other reviews it. Two agents never edit the same module at once.

The first vertical slice, which is gate G1:

1. Vault and tests on local anvil.
2. The digest vector shared with Rust and TypeScript.
3. Deploy on Arc testnet through Studio.
4. One ordinary payment through `erebus-vault`.
5. A1 and A2 revert.

## 13. Claims ledger

| Claim | Evidence required |
| --- | --- |
| The vault blocks unauthorized agent payments | A1 and A2 on Arc testnet, plus the contract tests |
| An approval binds the exact payment | A3 |
| No double payment | A4, plus a journal reconcile test |
| The reviewer verifies settlement independently | G3 on a second machine with its own RPC |
| One-record disclosure | A second record the reviewer cannot open |
| The policy was enforced at execution | Event fields checked against the pinned code hash |

Never claim any of these:
- audited, or production-ready;
- regulatory compliance;
- prompt-injection prevention;
- private payments;
- World enforced on-chain;
- exactly-once payment across all routes;
- support for all wallets.

## 14. Submission essentials

- **README:**
  - what existed before (link Erebus at `d56c777`) versus what was built in Mumbai;
  - provenance, the Studio URL, the contract address and deploy transaction;
  - roles and trust boundaries;
  - what is public (amount, recipient and timing on Arc) versus encrypted (invoice and approval record);
  - the claims ledger, AI usage and the license.
- **Partners:** Arc, plus Arkiv and World only if their gates passed.
- **Video:** 2 to 4 minutes, at least 720p.

## Sources

- ETHGlobal Mumbai [prizes](https://ethglobal.com/events/mumbai/prizes), [submission details](https://ethglobal.com/events/mumbai/info/details) and [rules](https://ethglobal.com/rules).
- Arc [connection details](https://docs.arc.io/arc/references/connect-to-arc.md), [contract addresses](https://docs.arc.io/arc/references/contract-addresses.md), [docs home](https://docs.arc.io) and [Studio CLI](https://docs.arc.io/ai/arc-studio-cli).
- Arkiv [first entity](https://docs.arkiv.network/start-here/first-entity/), [filters](https://docs.arkiv.network/querying/filter/), [expiration](https://docs.arkiv.network/writing/expiration/) and [limits](https://docs.arkiv.network/reference/limits/).
- [EIP-712](https://eips.ethereum.org/EIPS/eip-712), and the [I-HITL paper](https://arxiv.org/abs/2610.35835).
- GPT's roadmap and pitch guide (`~/Desktop/Erebus_Implementation_Roadmap.docx`, `~/Desktop/Erebus_Pitch_and_Judge_QA.docx`).
