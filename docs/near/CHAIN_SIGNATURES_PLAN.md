# Chain Signatures: one policy, payments on another chain

Goal: the same vault, the same limits, the same agent key, but the payment lands as USDC on an EVM
chain. The vault contract checks the rules, builds the EVM transaction itself, and asks NEAR's MPC
signer to sign it for the vault's own derived address. The agent never holds an EVM key and cannot
choose what gets signed beyond the fields the vault checks.

## Facts established (12 Nov 2026)

- Testnet MPC signer `v1.signer-prod.testnet`, version 3.18.0. `sign` takes
  `{"request":{"path":"<string>","payload_v2":{"Ecdsa":"<hex 32 bytes>"},"domain_id":0}}` with a
  1 yoctoNEAR deposit and at least 15 Tgas attached, and returns to the caller through yield/resume:
  `{"scheme":"Secp256k1","big_r":{"affine_point":"<hex 33>"},"s":{"scalar":"<hex 32>"},"recovery_id":0}`.
  A probe from the owner account returned exactly this shape in one transaction
  (`8EeH9Lr793mGP5brG7iFwSDipPRKCrgckPVkpTD1ufJR`).
- The key is derived from (caller account, path). For `vault-v2.styx-owner-c87a.testnet` and path
  `styx-evm`, the signer's `derived_public_key` view gives EVM address
  `0xb0241fcBD5A1D9D79a37C927559186eD08563CAd`.
- Target chain: Arc testnet, chain id 5042002, RPC `https://rpc.testnet.arc.network`. USDC is the
  gas token and has an ERC-20 interface at `0x3600000000000000000000000000000000000000` with 6
  decimals, so the derived address needs only USDC. Gas price was 25 gwei.

## Design

- New owner state: per EVM chain the token address and gas caps (max fee, priority fee, gas limit);
  an EVM recipient allowlist with versions; the next EVM nonce per chain, tracked by the vault.
- `pay_evm(payment)` and `pay_evm_with_exception(payment, authorization, signature)`, agent key only,
  with every check `pay` makes and the same daily counters. The vault builds an EIP-1559
  `transfer(recipient, amount)` on the token, hashes it, calls the signer, and in the callback
  assembles the signed raw transaction (low-s normalized), stores it by (chain, nonce) and emits it.
  Anyone can broadcast it. One request per chain in flight, so nonces stay sequential.
- If the signer fails, the callback rolls back the counters, the payment id and the approval nonce.
- Counters charge on signing, not on EVM inclusion, which over-counts if a signed transaction is
  never broadcast or reverts (seen on testnet: a 6 USDC transfer reverted for lack of funds and still
  counted); `set_evm_nonce` lets the owner resync. Gas is paid by the derived address in
  USDC, outside the payment limits, bounded by the owner's gas caps.
- The signer account is a constructor argument, so the sandbox test can use a mock signer.

## First signature from the vault (12 Nov 2026)

The agent's key called `pay_evm` on vault-v2 for 25 USDC to vendor A
([DwK2BQJD…](https://testnet.nearblocks.io/txns/DwK2BQJD3C6HfEtWnRFZF7BkRgQ272VCtTotXx978L32)). In
the same transaction the vault asked the MPC signer, got the signature back through the
callback, and emitted `evm_payment_signed` with the raw Arc transaction (nonce 0, EVM hash
`0x01475462…40ba`). `cast decode-transaction` recovers its signer as
`0xb0241fcbd5a1d9d79a37c927559186ed08563cad`, the vault's derived address. Not broadcast yet: the
address holds no USDC on Arc.

## Steps

- [x] Probe the testnet signer and record its interface
- [x] Choose the chain and compute the vault-v2 EVM address
- [x] Contract: EVM state, owner methods, views, RLP and EIP-1559 hashing, unit tests with a vector
      produced by `cast`
- [x] Contract: `pay_evm`, `pay_evm_with_exception`, signer call and callback with rollback, unit tests
- [x] ~~Mock signer in the sandbox~~ replaced: unit tests cover the callback with a k256 stand-in signer
      and the rollback; the real signer is exercised on testnet below
- [x] Deploy vault-v2 on testnet; configure Arc, an EVM recipient, the agent and the approver
- [x] Fund `0xb0241fcB…3CAd` with Arc testnet USDC (user: faucet.circle.com, Arc testnet)
- [x] Agent CLI: EVM recipients (`0x…`), submit via `pay_evm`, broadcast to Arc, status from the receipt
- [x] Testnet run: within limits, exception with signature, refusals (over limit, recipient not allowed,
      agent key on owner methods), each with NEAR and Arc transaction ids
- [x] Docs: TESTNET_RUN, README, submission draft, demo script
- [ ] Approval page: show EVM payments (chain, address) and check them with `evm_payment_hash`
      (Codex, once the run works)
