import type { Abi, Hex } from "viem";

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: Record<string, { start: number; length: number }[]>;
}

/**
 * Blanks the immutable byte ranges and drops the compiler's metadata trailer. The trailer is a hash that
 * changes with source paths and tooling, such as Arc Studio's, and is never executed.
 */
function normalise(code: string, refs: Artifact["immutableReferences"]): string {
  const body = code.toLowerCase().replace(/^0x/, "").split("");
  for (const spans of Object.values(refs)) {
    for (const { start, length } of spans) {
      for (let i = start * 2; i < (start + length) * 2; i++) body[i] = "0";
    }
  }
  const hex = body.join("");
  // The last two bytes give the length of the CBOR trailer before them, which starts with a CBOR map byte.
  const trailer = hex.length >= 4 ? parseInt(hex.slice(-4), 16) : 0;
  const cut = hex.length - (trailer + 2) * 2;
  const mapByte = cut >= 0 ? parseInt(hex.slice(cut, cut + 2), 16) : 0;
  return trailer > 0 && trailer <= 100 && mapByte >= 0xa0 && mapByte <= 0xb7 ? hex.slice(0, cut) : hex;
}

/**
 * Whether the code at an address is this checkout's compiled vault. Immutable values (owner, token) are
 * baked into deployed code and the metadata trailer varies by tooling, so both are ignored on each side.
 * A convenience check for the owner, not a proof: review the source.
 */
export function matchesBuild(onchain: string, artifact: Artifact): boolean {
  if (!onchain || onchain === "0x") return false;
  return normalise(onchain, artifact.immutableReferences) === normalise(artifact.deployedBytecode, artifact.immutableReferences);
}
