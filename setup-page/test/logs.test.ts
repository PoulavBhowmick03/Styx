import { describe, expect, it } from "vitest";

import { findFirstBlockWithCode, isRateLimitError, isRetryableRpcError, MAX_LOG_RANGE, pageLogs, retryRpc, verifyCreationBlock } from "../src/logs";

const noSleep = async () => undefined;

/** An RPC that behaves like Arc's: it refuses any range wider than 10,000 blocks with -32012. */
function limitedRpc(events: bigint[]) {
  const calls: [bigint, bigint][] = [];
  const fetchRange = async (from: bigint, to: bigint) => {
    calls.push([from, to]);
    if (to - from + 1n > 10_000n) throw Object.assign(new Error("-32012 block range too large"), { code: -32012 });
    return events.filter((b) => b >= from && b <= to);
  };
  return { calls, fetchRange };
}

describe("finding the creation block", () => {
  it("finds it exactly, in few calls", async () => {
    for (const created of [0n, 1n, 71_050_472n, 71_055_598n]) {
      let calls = 0;
      const found = await findFirstBlockWithCode(async (b) => { calls++; return b >= created; }, 71_055_598n);
      expect(found).toBe(created);
      expect(calls).toBeLessThanOrEqual(34); // bisecting from genesis is about 27; outward search adds a few jumps
    }
  });
  it("finds a young vault in far fewer calls than bisecting from genesis", async () => {
    let calls = 0;
    const head = 71_055_598n;
    const created = head - 5_126n;
    expect(await findFirstBlockWithCode(async (b) => { calls++; return b >= created; }, head)).toBe(created);
    expect(calls).toBeLessThanOrEqual(18); // head, one jump back, then bisect a 10,000-block gap
  });
  it("returns nothing when there is no code at the head", async () => {
    expect(await findFirstBlockWithCode(async () => false, 100n)).toBeUndefined();
  });
  it("lets a node that cannot answer old state surface its error", async () => {
    await expect(findFirstBlockWithCode(async (b) => { if (b < 90n) throw new Error("missing trie node"); return true; }, 100n)).rejects.toThrow("missing trie node");
  });
});

describe("paging logs under a range limit", () => {
  it("never asks for more than 9,999 blocks and covers the range with no gap or overlap", async () => {
    const events = [71_050_480n, 71_060_000n, 71_075_123n, 71_099_999n];
    const rpc = limitedRpc(events);
    const result = await pageLogs(rpc.fetchRange, 71_050_472n, 71_100_000n, { sleep: noSleep });
    expect(result.complete).toBe(true);
    expect(result.scannedFrom).toBe(71_050_472n);
    expect([...result.items].sort()).toEqual([...events].sort());
    for (const [from, to] of rpc.calls) expect(to - from + 1n).toBeLessThanOrEqual(MAX_LOG_RANGE);
    const ordered = [...rpc.calls].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    expect(ordered[0]![0]).toBe(71_050_472n);
    expect(ordered.at(-1)![1]).toBe(71_100_000n);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i]![0]).toBe(ordered[i - 1]![1] + 1n);
  });
  it("splits exactly 10,000 blocks in two, because the limit is on 10,000", async () => {
    const rpc = limitedRpc([]);
    const result = await pageLogs(rpc.fetchRange, 1n, 10_000n, { sleep: noSleep });
    expect(result.complete).toBe(true);
    expect(rpc.calls.length).toBe(2);
  });
  it("handles a one-block range and an empty range", async () => {
    const rpc = limitedRpc([5n]);
    expect((await pageLogs(rpc.fetchRange, 5n, 5n)).items).toEqual([5n]);
    expect(await pageLogs(rpc.fetchRange, 9n, 5n)).toEqual({ items: [], scannedFrom: 9n, complete: true });
  });
  it("retries the load balancer's -32014 and then succeeds", async () => {
    let failures = 2;
    const waits: number[] = [];
    const result = await pageLogs(async () => {
      if (failures-- > 0) throw Object.assign(new Error("block not imported"), { code: -32014 });
      return [1];
    }, 1n, 100n, { sleep: async (ms) => void waits.push(ms) });
    expect(result).toEqual({ items: [1], scannedFrom: 1n, complete: true });
    expect(waits).toEqual([400, 800]);
  });
  it("recognises -32014 by its text too, since an error can lose its code", () => {
    expect(isRetryableRpcError(new Error("RPC error -32014: not imported"))).toBe(true);
    expect(isRetryableRpcError({ cause: { cause: { code: -32014 } } })).toBe(true);
    expect(isRetryableRpcError(new Error("-32012 range"))).toBe(false);
  });
  it("gives a partial result with a reason when retries run out, keeping what it read", async () => {
    let call = 0;
    const result = await pageLogs(async (from) => {
      if (call++ === 0) return [from]; // the newest chunk works
      throw Object.assign(new Error("block not imported"), { code: -32014 });
    }, 1n, 30_000n, { sleep: noSleep });
    expect(result.complete).toBe(false);
    expect(result.items.length).toBe(1);
    expect(result.scannedFrom).toBe(30_000n - 9_999n + 1n);
    expect(result.reason).toMatch(/refused blocks/);
  });
  it("stops at once on an error that is not retryable", async () => {
    let calls = 0;
    const result = await pageLogs(async () => { calls++; throw new Error("-32012 too wide"); }, 1n, 50_000n, { sleep: noSleep });
    expect(calls).toBe(1);
    expect(result.complete).toBe(false);
  });
  it("stops at the page cap and says how far it got", async () => {
    const rpc = limitedRpc([]);
    const result = await pageLogs(rpc.fetchRange, 1n, 1_000_000n, { maxPages: 3, sleep: noSleep });
    expect(result.complete).toBe(false);
    expect(rpc.calls.length).toBe(3);
    expect(result.scannedFrom).toBe(1_000_000n - 3n * MAX_LOG_RANGE + 1n);
    expect(result.reason).toMatch(/after 3 requests/);
  });
});

describe("waiting out a rate-limited RPC", () => {
  it("recognises 429 and -32005 however they arrive", () => {
    expect(isRateLimitError({ code: -32005, message: "rate limit exceeded" })).toBe(true);
    expect(isRateLimitError(new Error("HTTP request failed. Status: 429"))).toBe(true);
    expect(isRateLimitError({ cause: { cause: { code: -32005 } } })).toBe(true);
    expect(isRateLimitError(new Error("-32012 range too large"))).toBe(false);
  });
  it("waits 0.5s, 1s, 2s and tells the page why, then succeeds", async () => {
    let failures = 3;
    const waits: [number, string][] = [];
    const value = await retryRpc(async () => {
      if (failures-- > 0) throw Object.assign(new Error("rate limit exceeded"), { code: -32005 });
      return "ok";
    }, { sleep: async () => undefined, onWait: (ms, why) => waits.push([ms, why]) });
    expect(value).toBe("ok");
    expect(waits).toEqual([[500, "rate limit"], [1000, "rate limit"], [2000, "rate limit"]]);
  });
  it("gives up after 5 rate-limit waits and throws the error", async () => {
    let calls = 0;
    await expect(retryRpc(async () => { calls++; throw Object.assign(new Error("rate limit exceeded"), { code: -32005 }); }, { sleep: async () => undefined })).rejects.toThrow("rate limit");
    expect(calls).toBe(6);
  });
  it("does not retry an error it was not told to", async () => {
    let calls = 0;
    await expect(retryRpc(async () => { calls++; throw new Error("execution reverted"); }, { sleep: async () => undefined })).rejects.toThrow("reverted");
    expect(calls).toBe(1);
  });
  it("lets a rate-limited block search finish", async () => {
    let limited = 4;
    const found = await findFirstBlockWithCode((block) => retryRpc(async () => {
      if (limited-- > 0) throw Object.assign(new Error("rate limit exceeded"), { code: -32005 });
      return block >= 5_000n;
    }, { sleep: async () => undefined }), 20_000n);
    expect(found).toBe(5_000n);
  });
  it("pages through a rate limit without losing or repeating a chunk", async () => {
    const calls: [bigint, bigint][] = [];
    let limited = 2;
    const result = await pageLogs(async (from, to) => {
      calls.push([from, to]);
      if (limited-- > 0) throw Object.assign(new Error("rate limit exceeded"), { code: -32005 });
      return [from];
    }, 1n, 25_000n, { sleep: async () => undefined });
    expect(result.complete).toBe(true);
    expect(result.items.length).toBe(3); // three chunks, each read once successfully
    expect(calls.length).toBe(5); // two refused attempts were repeated
  });
});

describe("checking a creation-block hint", () => {
  const codeFrom = (created: bigint) => async (b: bigint) => b >= created;
  it("accepts the true block", async () => {
    expect(await verifyCreationBlock(codeFrom(71_050_472n), 71_050_472n)).toBe(71_050_472n);
    expect(await verifyCreationBlock(codeFrom(0n), 0n)).toBe(0n);
  });
  it("rejects a block that is too early, too late, or negative, at a cost of two lookups", async () => {
    expect(await verifyCreationBlock(codeFrom(100n), 99n)).toBeUndefined(); // no code there yet
    expect(await verifyCreationBlock(codeFrom(100n), 101n)).toBeUndefined(); // code was already there a block earlier
    expect(await verifyCreationBlock(codeFrom(100n), -1n)).toBeUndefined();
    let calls = 0;
    await verifyCreationBlock(async (b) => { calls++; return b >= 100n; }, 100n);
    expect(calls).toBe(2);
  });
});
