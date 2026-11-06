import type { Abi, Hex } from "viem";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
}

function mask(code: string, refs: Artifact["immutableReferences"]): string {
  const body = code.toLowerCase().replace(/^0x/, "").split("");
  for (const spans of Object.values(refs)) {
    for (const { start, length } of spans) {
      for (let i = start * 2; i < (start + length) * 2; i++) body[i] = "0";
    }
  }
  return body.join("");
}

/**
 * Whether the code at an address is this checkout's compiled vault. Immutable values (owner, token) are
 * baked into deployed code, so those byte ranges are blanked on both sides before comparing.
 */
export function matchesBuild(onchain: string, artifact: Artifact): boolean {
  if (!onchain || onchain === "0x") return false;
  return mask(onchain, artifact.immutableReferences) === mask(artifact.deployedBytecode, artifact.immutableReferences);
}
