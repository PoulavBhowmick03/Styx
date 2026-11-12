# Styx on NEAR: build plan for the NEAR Hackathon

Deadline: **14 Nov 2026, 23:59 UTC**. Judging 16 to 18 Nov. Track: **06 AI Security & Defense**
(spending limits, policy engines, sandboxed wallets; tags: agent security, function call keys,
TEE attestation). Secondary track: 07 Agent Economy.

Submission needs: a public repo, a demo post on X (tag `@NEARProtocol`, `#NEARHackathon`,
video or screenshots), the form (name, lead, email, team size, tracks, a NEAR wallet address,
repo link, post link, "what did you build", website). One submission per project.

## What we build

The same thing as Styx on Arc, native to NEAR:

- `styx-vault` NEAR contract (Rust, near-sdk 5). Owner sets policy; agents pay within it;
  an approver's signature is needed over the exact payment to go over the per-payment limit.
- **Agents are function-call access keys on the vault account**, not separate accounts. The
  key is restricted to the `pay` and `pay_with_exception` methods with a gas allowance. The
  contract keys an agent's policy by `env::signer_account_pk()`. The protocol itself
  rejects a call from that key to `configure_agent`, before the contract runs. This is the
  mechanism Track 06 names.
- USDC is a NEP-141 token. `pay` checks the rules, commits counters, calls `ft_transfer`
  and rolls the counters back in the callback if the transfer fails.
- Exceptions: the approver signs a NEP-413 message (wallet `signMessage`) over the exact
  payment. The contract rebuilds the NEP-413 payload, hashes it, and verifies ed25519 against
  the approver's registered public key. Nonce is single-use; authorization expires.
- MCP tools (Python) that propose, request approval and submit payments through a NEAR
  signer. Same tool names and flow as the Arc build.
- Approval page: NEAR wallet-selector, shows the payment read back from the chain, signs
  NEP-413, posts the signature to the relay.
- Attacks A1 to A6 as real testnet transactions, all must fail for the named reason.
- Disclosure: the sealed record is posted as an event log; the reviewer verifies it against
  NEAR RPC with their own key.

Not on NEAR for this build: Telegram bot (reuse if time allows), setup page beyond a CLI.

## Steps

Check a step only after its verification ran. Keep commits small and conventional.
Contract and signing commits need Poulav's review before they are trusted; mark them.

### 0. Setup
- [x] Branch `near-hackathon`, plan written
- [ ] near-cli-rs installed, testnet owner account created (`styx-owner.testnet` or similar)
- [ ] USDC-like NEP-141 on testnet chosen: deploy our own mock FT (`contracts/near/styx-usdc`)
      and say so honestly

### 1. Contract `contracts/near/styx-vault`
- [ ] Scaffold with cargo-near, builds to wasm
- [ ] State: owner, token, paused, vault daily limit, agents by public key (version,
      per-payment limit, daily limit, valid_until, enabled), approvers by public key
      (version, enabled), recipients (allowed, version), spent by agent-day, spent by day,
      consumed payment ids, consumed approval nonces
- [ ] Owner methods: `configure_agent`, `set_approver`, `set_recipient`,
      `set_vault_daily_limit`, `pause`, `unpause`, `withdraw` (ft_transfer to owner)
- [ ] `pay(payment)`: predecessor is the vault, signer pk is an enabled agent, every check
      from `_checkShared`, per-payment limit, commit counters, `ft_transfer`, callback with
      rollback on failure. Emits `payment_executed` event (NEP-297 style JSON log)
- [ ] `pay_with_exception(payment, authorization, signature)`: NEP-413 reconstruction
      and ed25519 verification, nonce consumed, expiry checked, only the per-payment limit lifted
- [ ] Views: `get_agent`, `get_approver`, `get_recipient`, `get_vault`, `payment_hash`,
      `exception_message` (the exact NEP-413 message the approver signs)
- [ ] Unit tests (near-sdk test env) for every refusal path
- [ ] near-workspaces integration test on sandbox: fund, pay, exception, A1 to A6, rollback
      when the recipient is not registered with the token
- [ ] Deploy to testnet, record account id and tx in `docs/near/DEPLOYMENTS.md`

### 2. Agent side
- [ ] `sdk/near` Rust CLI `styx-near`: build payment, sign and send `pay` with the
      function-call key, fetch approval, send `pay_with_exception`, read vault views,
      write the journal record (reuse `sdk/journal`)
- [ ] MCP server: `mcp-server/src/styx_near_mcp` with `styx_propose_payment`,
      `styx_request_owner_approval`, `styx_submit_payment`, `styx_payment_status`
- [ ] Local run against sandbox: propose, submit within limit, exception flow end to end

### 3. Approval page and relay
- [ ] Relay: accept NEP-413 signatures (public key, signature, nonce) for a payment id
- [ ] Approval page: wallet-selector, read payment from chain, `signMessage`, post to relay
- [ ] Owner signs on testnet and the agent settles the exception

### 4. Attacks and trials
- [ ] `scripts/near/attacks.sh`: A1 over limit, A2 agent signs its own exception, A3 reuse
      signature for another recipient, A4 replay settled payment, A5 agent raises its own
      limit (rejected by the access key), A6 agent names itself approver. All on testnet, tx
      ids recorded
- [ ] Hostile-invoice trials on sandbox with Haiku 5.5 and Sonnet 5.5, results recorded

### 5. Disclosure
- [ ] Sealed record posted via `post_record` on the vault (event log), reviewer CLI fetches
      the log through NEAR RPC and verifies against `payment_executed`

### 6. Demo and submission
- [ ] `scripts/near/demo.sh auto`: fund, pay within limit, exception with signature, A5, A1, A4
- [ ] README for the NEAR build, `docs/near/SUBMISSION_FORM.md` draft, `docs/near/DEMO_SCRIPT.md`
- [ ] Demo video or screenshots recorded (user)
- [ ] Branch pushed to the public Styx repo
- [ ] X post and form submitted (user; needs the NEAR wallet address)

## Decisions log

- Agents as function-call keys on the vault account rather than sub-accounts: the key cannot
  call admin methods at the protocol level, which is the strongest form of "the agent cannot
  raise its own cap". Cost: an agent cannot sign NEP-413 (needs a full-access key), which is
  exactly what A2 should show.
- Approvers identified by ed25519 public key, registered by the owner, so verification does
  not need to look up the approver account's keys on chain.
- Day = block timestamp (ns) / 86400 s, UTC calendar day, same as the Arc build.
