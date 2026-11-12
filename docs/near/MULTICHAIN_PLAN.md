# One agent key, two chains: Arc and Base Sepolia

Goal: in one run, the same agent key and the same NEAR vault pay on Arc testnet and on Base Sepolia,
and are refused on both. The invoice picks the chain, not a setting: a recipient is written in
CAIP-10 form, `eip155:<chain id>:0x<address>`, and the CLI looks up that chain's RPC in a map. The
vault still refuses any chain the owner did not enable and any address the owner did not allow on
that chain.

## Facts (13 Nov 2026)

- vault-v2's derived address `0xb0241fcB…3CAd` is the same on every EVM chain: it comes from the
  MPC key, not the chain.
- Base Sepolia: chain 84532, RPC `https://sepolia.base.org`, USDC
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals), base fee 0.005 gwei, priority fee
  0.001 gwei. Gas is paid in ETH there, unlike Arc. The address holds 0.1 ETH and 20 USDC (funded
  by Poulav).
- Arc: the address holds about 4.99 USDC after earlier runs.
- Owner configured Base on vault-v2: `set_evm_chain` (`Bfkd4wzL…`, max fee 1 gwei, priority 0.01
  gwei, gas limit 100000) and both vendors allowed on 84532 (`89vpq4We…`, `8kyr1kB1…`).

## Steps

- [x] Owner configures Base Sepolia and its vendors on vault-v2, once
- [x] CLI: CAIP-10 recipients and a chain-to-RPC map (`STYX_NEAR_EVM_RPCS`), keeping plain `0x…`
      with `STYX_NEAR_EVM_CHAIN_ID` working; unit tests
- [x] One run, one key: within limits on Arc and on Base; over the limit on both, refused without
      a signature; an exception settled with the approver's signature on Base; a stranger refused on
      Base; every NEAR and EVM transaction recorded
- [x] `scripts/near/demo_multichain.sh` for the video
- [x] Docs: TESTNET_RUN, README, submission draft, demo script

Ran end to end on 13 Nov 2026: see "One key, two chains" in `TESTNET_RUN.md`.
