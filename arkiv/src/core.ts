// The parts of the adapter that need no network. Arkiv only ever sees the encrypted grant:
// settlement never depends on it, and the local grant file always exists.

import { bytes, defineSchema, str } from "@arkiv-network/sdk/schema";
import { eq } from "@arkiv-network/sdk/query";
import { hexToBytes, isAddress, isHex, type Address, type Hex } from "viem";

export const APP = "vault-payment-records";
export const SCHEMA_VERSION = "1";
export const EXPIRY_DAYS = 7;
/** Arkiv's limit for all `bytes` values in one create. */
export const MAX_GRANT_BYTES = 128 * 1024;

export const VaultGrants = defineSchema("vault.payment-grant", {
  app: str().indexed(),
  schemaVersion: str().indexed(),
  lookupTag: str().indexed(),
  ciphertext: bytes(),
});

export class ArkivAdapterError extends Error {}

export function assertPublishable(grant: Uint8Array): void {
  if (grant.length === 0) throw new ArkivAdapterError("the grant is empty");
  if (grant.length > MAX_GRANT_BYTES) {
    throw new ArkivAdapterError(
      `the grant is ${grant.length} bytes; Arkiv allows ${MAX_GRANT_BYTES}. Share the local grant file instead.`,
    );
  }
}

/** 128 random bits as hex, so the tag reveals nothing about the payment and cannot be guessed. */
export function newLookupTag(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return Array.from(random(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertLookupTag(tag: string): void {
  if (!/^[0-9a-f]{32}$/.test(tag)) throw new ArkivAdapterError("the lookup tag must be 32 lowercase hex digits");
}

export function assertWriter(writer: string): asserts writer is Address {
  if (!isAddress(writer)) throw new ArkivAdapterError("the writer must be an address");
}

export function grantValues(grant: Uint8Array, lookupTag: string) {
  assertPublishable(grant);
  assertLookupTag(lookupTag);
  return { app: APP, schemaVersion: SCHEMA_VERSION, lookupTag, ciphertext: grant };
}

export const lookupFilter = (lookupTag: string) => eq("lookupTag", lookupTag);

/**
 * Picks the one grant a lookup should return. The query filters by writer, since anyone can write
 * under a schema's names. More than one result is refused rather than guessed between. An empty
 * result says only that Arkiv has nothing here now: entities expire, so it never means unpaid.
 */
export function selectGrant(rows: readonly { ciphertext: { value: Hex } }[]): Uint8Array {
  if (rows.length === 0) {
    throw new ArkivAdapterError("no grant found for this tag and writer; this says nothing about the payment");
  }
  if (rows.length > 1) throw new ArkivAdapterError("more than one grant has this tag and writer");
  const value = rows[0]!.ciphertext.value;
  if (!isHex(value)) throw new ArkivAdapterError("Arkiv returned malformed ciphertext");
  return hexToBytes(value);
}
