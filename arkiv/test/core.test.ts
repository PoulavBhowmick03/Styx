import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { bytesToHex, http } from "viem";
import { describe, expect, it } from "vitest";

import {
  APP,
  ArkivAdapterError,
  assertLookupTag,
  assertWriter,
  grantValues,
  lookupFilter,
  MAX_GRANT_BYTES,
  newLookupTag,
  SCHEMA_VERSION,
  selectGrant,
  VaultGrants,
} from "../src/core";

const TAG = "0123456789abcdef0123456789abcdef";
const WRITER = "0x1111111111111111111111111111111111111111";

describe("grant values", () => {
  it("index only the app, version and tag, and keep the grant as bytes", () => {
    const grant = new Uint8Array([1, 2, 3]);
    expect(grantValues(grant, TAG)).toEqual({ app: APP, schemaVersion: SCHEMA_VERSION, lookupTag: TAG, ciphertext: grant });
  });

  it("accept exactly the size limit and refuse one byte over", () => {
    expect(() => grantValues(new Uint8Array(MAX_GRANT_BYTES), TAG)).not.toThrow();
    expect(() => grantValues(new Uint8Array(MAX_GRANT_BYTES + 1), TAG)).toThrow(ArkivAdapterError);
  });

  it("refuse an empty grant or malformed tag", () => {
    expect(() => grantValues(new Uint8Array(0), TAG)).toThrow(ArkivAdapterError);
    expect(() => grantValues(new Uint8Array(1), "short")).toThrow(ArkivAdapterError);
  });
});

describe("lookup tags", () => {
  it("are 128 random bits as hex", () => {
    const tag = newLookupTag();
    expect(() => assertLookupTag(tag)).not.toThrow();
    expect(newLookupTag()).not.toBe(tag);
  });

  it("refuse uppercase and wrong lengths", () => {
    expect(() => assertLookupTag(TAG.toUpperCase())).toThrow(ArkivAdapterError);
    expect(() => assertLookupTag(`${TAG}00`)).toThrow(ArkivAdapterError);
  });
});

describe("the query", () => {
  it("filters by schema, tag and writer", () => {
    const client = createPublicClient({ chain: rabdi({ accessKey: "unused" }), transport: http() });
    const query = client
      .select({ ciphertext: true })
      .from(VaultGrants)
      .where(lookupFilter(TAG))
      .ownedBy(WRITER)
      .toString()
      .toLowerCase();
    expect(query).toContain("vault.payment-grant");
    expect(query).toContain(TAG);
    expect(query).toContain(WRITER);
  });

  it("refuses a writer that is not an address", () => {
    expect(() => assertWriter("nobody")).toThrow(ArkivAdapterError);
  });
});

describe("selecting a grant", () => {
  const row = (grant: Uint8Array) => ({ ciphertext: { value: bytesToHex(grant) } });

  it("returns the exact bytes of a single result", () => {
    const grant = new Uint8Array([0, 255, 7]);
    expect(selectGrant([row(grant)])).toEqual(grant);
  });

  it("never treats an empty result as a statement about payment", () => {
    expect(() => selectGrant([])).toThrow(/says nothing about the payment/);
  });

  it("refuses to choose between several results", () => {
    expect(() => selectGrant([row(new Uint8Array([1])), row(new Uint8Array([2]))])).toThrow(/more than one/);
  });
});
