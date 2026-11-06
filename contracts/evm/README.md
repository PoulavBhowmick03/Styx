# Contracts

`src/StyxPolicyVault.sol` is the vault deployed on Arc testnet at `0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`. It keeps the EIP-712 domain name `ErebusPolicyVault`, because the deployed code hashes that exact string, and signatures must match it.

The deployed build used solc 0.8.24, the optimizer on with 200 runs, and EVM target cancun. `foundry.toml` builds with the optimizer off, so its local bytecode differs.

`script/attacks.sh` sends attacks A1 to A4 as real transactions. Every one must revert.

```bash
forge test
```

The other contracts in `src/` are test tokens.
