import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { bytesToHex, http } from "viem";
import { describe, expect, it } from "vitest";

import {
  APP,
  ArkivAdapterError,
  assertLookupTag,
  exitCodeFor,
  withinTime,
  redacted,
  EXIT_MALFORMED,
  EXIT_NOTHING_FOUND,
  EXIT_UNAVAILABLE,
  sameBytes,
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

describe("telling failures apart", () => {
  it("gives nothing found, malformed data and network failure different exit codes", () => {
    const found = (() => {
      try {
        selectGrant([]);
      } catch (error) {
        return error;
      }
    })();
    const malformed = (() => {
      try {
        selectGrant([{ ciphertext: { value: "not hex" as `0x${string}` } }]);
      } catch (error) {
        return error;
      }
    })();
    const several = (() => {
      try {
        selectGrant([{ ciphertext: { value: "0x01" } }, { ciphertext: { value: "0x02" } }]);
      } catch (error) {
        return error;
      }
    })();
    expect(exitCodeFor(found)).toBe(EXIT_NOTHING_FOUND);
    expect(exitCodeFor(malformed)).toBe(EXIT_MALFORMED);
    expect(exitCodeFor(several)).toBe(EXIT_MALFORMED);
    expect(exitCodeFor(new TypeError("fetch failed"))).toBe(EXIT_UNAVAILABLE);
    expect(new Set([EXIT_NOTHING_FOUND, EXIT_MALFORMED, EXIT_UNAVAILABLE]).size).toBe(3);
  });

  it("never describes an empty result as unpaid", () => {
    expect(() => selectGrant([])).toThrow(/says nothing about the payment/);
  });

  it("compares a read-back byte for byte", () => {
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(sameBytes(new Uint8Array([1]), new Uint8Array([1, 0]))).toBe(false);
  });
});

describe("error text", () => {
  it("never carries the access key", () => {
    expect(redacted(new Error("POST https://host/rpc/abc123 failed"), "abc123")).not.toContain("abc123");
  });
});

describe("a stalled endpoint", () => {
  it("gives up as unreachable instead of hanging, and that is never read as nothing found", async () => {
    const stalled = new Promise<string>(() => {});
    const error = await withinTime(stalled, 10).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(exitCodeFor(error)).toBe(EXIT_UNAVAILABLE);
  });

  it("passes a timely answer through", async () => {
    await expect(withinTime(Promise.resolve("answer"), 1000)).resolves.toBe("answer");
  });
});
