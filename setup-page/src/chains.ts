import { defineChain } from "viem";

// Source: https://docs.arc.io/arc/references/connect-to-arc.md and contract-addresses.md (read 6 Nov 2026).
export const ARC_TESTNET_ID = 5042002;
export const ARC_USDC = "0x3600000000000000000000000000000000000000" as const;

export const arcTestnet = defineChain({
  id: ARC_TESTNET_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" } },
});

/** Any chain the wallet reports that is not Arc testnet. Only for rehearsal on a local chain. */
export function chainFor(id: number) {
  if (id === ARC_TESTNET_ID) return arcTestnet;
  return defineChain({
    id,
    name: `Chain ${id}`,
    nativeCurrency: { name: "Native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [] } },
  });
}

export function explorerTx(chainId: number, hash: string): string | undefined {
  return chainId === ARC_TESTNET_ID ? `${arcTestnet.blockExplorers.default.url}/tx/${hash}` : undefined;
}

/**
 * Creation blocks the page may try first, so a vault whose history is long does not cost a search against a
 * rate-limited RPC. Source: the deployment table in docs/mumbai/STATUS.md. A hint is only a guess: the page
 * checks it on-chain (code at that block and none one block earlier) before using it.
 */
export const KNOWN_CREATION_BLOCKS: Record<string, bigint> = {
  [`${ARC_TESTNET_ID}:0xb3bc2a8216b9065bf9013e22a6a17068cd6b3fb1`]: 71_050_472n,
};

/**
 * Runtime code hashes (keccak256 of the deployed code, owner and token included) that a vault is expected to have.
 * Source: the brief for the v2 vault, not the repository. A vault listed here that answers with another hash is
 * reported as different and funding is switched off.
 */
export const KNOWN_CODE_HASHES: Record<string, string> = {
  [`${ARC_TESTNET_ID}:0xd596e0fca7b12dc7f92c6beb3c4537fe2794aba8`]: "0x4ed8c17d810632423c99decd2c130a16b4c3ff3bea5c4717d1b36fd0ea8512d5",
};
