# V2 integration review

Baseline: `origin/claude1/v2` at `2afe0edc34f6bf035ca44b1225165c6ba918e0a0`.
The remote still named that commit when checked during this review.
This is a limited adversarial review. It does not establish that every integration path is safe.
No owned integration source was changed. All reproductions use local fixtures or Anvil.

## Findings for Claude 1

### R1. Medium: cached pending files prevent approval renewal

Location: `mcp-server/src/styx_mcp/vault.py:180-196`.

With a relay configured, an existing pending file skips the SDK request entirely.
Its name includes only a payment ID prefix and an optional signer address prefix.
A later authorization expiry, or removal and restoration of the same approver, still chooses that file.
The adapter sends the obsolete authorization again. The contract correctly refuses it.
The agent cannot renew this payment through the same MCP tool call.
Two signer addresses with the same eight-character prefix also choose the same file.

Reproduction: `sdk/evm/tests/v2_mcp_review.py` calls the real registered tool with an expired cached file.
The test fails because the SDK receives no `request_approval` call.
The binary seam and HTTP response are controlled fakes. No external request occurs.
The prefix-collision variant is a source finding, not a separate executed reproduction.

Fix: refresh through the SDK and use a new private output path when a pending request expires or its signer version changes.
Use full payment IDs and signer addresses. The SDK deliberately refuses to overwrite an existing pending file.
Preserve the payment ID; do not solve this by proposing a second payment.
The passing SDK Anvil test already exercises renewal and rejection of the old signature.

### R2. Medium: the approval page and relay exclude ERC-1271 wallets

Locations: `owner-page/src/approval-v2.ts:248-250`, `owner-page/src/approval-v2.ts:286-295`, `relay/src/relay.ts:304-313`.
Contract reference: `contracts/evm/src/StyxVault.sol:324-337`.

The page requires the connected account to equal the named signer, then requires ECDSA recovery to that signer.
The relay also accepts exactly 65 bytes and uses the same recovery helper.
A contract wallet can validate a different-length signature through ERC-1271.
An owner wallet's constituent account cannot satisfy the page's address check either.
This blocks supported contract owners and approvers; it does not bypass their authority.

Reproduction: the TypeScript review test shows that a 130-byte input never passes the relay's length gate.
That synthetic input establishes the parser restriction, not signature validity.
Separately, the passing v2 Anvil tests execute valid arbitrary-length approver signatures and a threshold contract-owner signature.
The page restrictions above are source findings.

Fix: provide a contract-wallet signing path and validate its exact digest through ERC-1271.
Keep ECDSA recovery for plain accounts. Recheck membership and signer version before accepting either kind.
If that path stays out of scope, describe the page and relay as supporting plain-account signers only.

### R3. Medium: concurrent v2 requests bypass the alert budget

Locations: `relay/src/relay.ts:161-170`, `relay/src/relay.ts:276-284`.

The relay checks the available budget before awaiting delivery.
The counter changes only after delivery, so concurrent requests all see the same free slot.
An agent credential holder can flood the approver's notification channel.
This is inherited from the v1 path and also affects v2. It grants no payment authority.

Reproduction: five concurrent v2 requests deliver five notifications with `maxAlertsPerHour=1`.
The test uses the real Relay class and an asynchronous fake notifier. No Telegram request occurs.

Fix: reserve the budget synchronously before awaiting delivery and release failed reservations.
Also mark each request as in flight so concurrent retries cannot send duplicate notifications.

### R4. Low: duplicate configured credentials defeat agent isolation

Locations: `relay/src/main.ts:27-43`, `relay/src/relay.ts:202-205`, `relay/src/relay.ts:322-326`.

Configuration validates credential length but does not reject duplicate credentials across agents.
When two agents share a credential, either can submit for the other and retrieve its signature.
This requires incorrect operator configuration. It is not a bypass when the credentials are distinct.
Exact-payment signatures still prevent spending a different agent's authorization.

Reproduction: with one credential configured for two agents, agent A's credential retrieves agent B's signed request.
The same test with distinct credentials refuses agent A.

Fix: reject duplicate credentials when loading configuration, including reuse across the v1 and v2 agent sets.
Document that each agent receives a different credential.

## Checks that passed, and limits

- A signature for a different request is rejected by the real Relay class.
- A distinct agent credential cannot retrieve another agent's signature.
- A request remains usable at its exact authorization expiry second.
- Changing any payment field without changing its authorization is rejected by the page's review function.
- The displayed amount, vault, recipient, agent and digest match the tested pending request.

These tests call the actual review and relay functions. They do not exercise a real wallet extension.
The existing owner-page unit suite passes too; its browser suite was not run for this handoff.

The page uses strict `< now` comparisons at `approval-v2.ts:260-266`.
The contract rejects `block.timestamp > expiry` at `StyxVault.sol:246,271,275`.
The v2 relay retains requests through the inclusive expiry second using `expiry + 1` at `relay.ts:236`.
These boundary conventions agree in the tested case.

The page is not a complete simulation of contract execution.
It checks signer membership before several agent checks (`approval-v2.ts:251-266`), while the contract runs shared checks first (`StyxVault.sol:240-248`).
Its facts omit daily spend, daily caps, consumed payment IDs and consumed nonces (`approval-v2.ts:191-204`).
The contract checks those at `StyxVault.sol:245,280-286`.
A page-approved signature can therefore remain unexecutable. No limit bypass was demonstrated.
Both daily caps remain mandatory for exception payments in the passing contract tests.

## Reproduce the open findings

From the repository root, after installing relay, owner-page and Python dependencies:

```sh
relay/node_modules/.bin/tsx --test sdk/evm/tests/v2_integration_review.mts
uv run pytest sdk/evm/tests/v2_mcp_review.py -q
```

Expected on the reviewed baseline: four TypeScript checks pass, three fail; the MCP regression fails.
These failing reproductions are kept outside the normal CI suite because the affected paths belong to Claude 1.
Do not describe them as passing release checks.
To run only the four currently passing TypeScript checks:

```sh
STYX_REVIEW_SKIP_OPEN_FINDINGS=1 relay/node_modules/.bin/tsx --test sdk/evm/tests/v2_integration_review.mts
```

No source change in this branch fixes R1 through R4.
Poulav and Claude 1 must decide which integration fixes gate the v2 release.
