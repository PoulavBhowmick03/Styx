// The relay's read-only view of a vault. It holds no key and sends nothing.

import { createPublicClient, fallback, getAddress, http, parseAbi, type Address } from "viem";

import type { ChainReader } from "./people";

const ABI = parseAbi([
  "function contractVersion() view returns (uint256)",
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function approverState(address) view returns (uint256 version, bool enabled)",
]);

export function chainReader(rpcUrls: string[]): ChainReader {
  const client = createPublicClient({ transport: fallback(rpcUrls.map((url) => http(url, { timeout: 8000, retryCount: 1 }))) });
  return {
    contractVersion: (vault) => client.readContract({ address: vault, abi: ABI, functionName: "contractVersion" }),
    owner: async (vault): Promise<Address> => getAddress(await client.readContract({ address: vault, abi: ABI, functionName: "owner" })),
    token: async (vault): Promise<Address> => getAddress(await client.readContract({ address: vault, abi: ABI, functionName: "token" })),
    signerEnabled: async (vault, signer) => (await client.readContract({ address: vault, abi: ABI, functionName: "approverState", args: [signer] }))[1],
  };
}
