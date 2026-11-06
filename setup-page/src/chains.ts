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
