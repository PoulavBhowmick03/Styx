import { describe, expect, it } from "vitest";

import { AmountError, formatNative, formatUsdc, parseUsdc } from "../src/amounts";
import { matchesBuild, type Artifact } from "../src/build";
import { MAX_AGENT_GAS, assessProtection, isProtected, type Snapshot } from "../src/protection";

describe("amounts never use floats", () => {
  it("parses decimals exactly", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("0.25")).toBe(250_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    // 0.1 + 0.2 style traps: the digits are handled as text.
    expect(parseUsdc("0.3")).toBe(300_000n);
    expect(parseUsdc("9007199254740993")).toBe(9_007_199_254_740_993_000_000n); // beyond 2^53
  });
  it("refuses anything finer than 6 decimals, and anything that is not plain decimal", () => {
    for (const bad of ["0.0000001", "", "-1", "1e3", "1,5", "0x10", " ", "1.", ".5", "01", "NaN", "Infinity"]) {
      expect(() => parseUsdc(bad), bad).toThrow(AmountError);
    }
  });
  it("formats both scales without rounding", () => {
    expect(formatUsdc(8_000_000n)).toBe("8");
    expect(formatUsdc(250_000n)).toBe("0.25");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatNative(10_000_000_000_000_000n)).toBe("0.01");
    expect(formatNative(1n)).toBe("0.000000000000000001");
  });
  it("round-trips every 6-decimal amount it prints", () => {
    for (const v of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n, 2n ** 70n]) expect(parseUsdc(formatUsdc(v))).toBe(v);
  });
});

const base: Snapshot = {
  owner: "0x00000000000000000000000000000000000000a0",
  agent: "0x00000000000000000000000000000000000000b0",
  vaultTokens: 8_000_000n,
  agentTokens: 300_000n,
  agentNative: 300_000n * 10n ** 12n,
  sameMoney: true,
  paused: false,
};
const state = (s: Snapshot, id: string) => assessProtection(s).find((c) => c.id === id)?.state;

describe("protection checks", () => {
  it("passes when funded, with a separate gas-only agent", () => {
    expect(isProtected(assessProtection(base))).toBe(true);
  });
  it("says an empty vault protects nothing", () => {
    expect(state({ ...base, vaultTokens: 0n }, "funded")).toBe("todo");
    expect(isProtected(assessProtection({ ...base, vaultTokens: 0n }))).toBe(false);
  });
  it("warns, with the amount to move, when the agent holds more than gas", () => {
    const s = { ...base, agentTokens: 5_000_000n, agentNative: 5_000_000n * 10n ** 12n };
    const funds = assessProtection(s).find((c) => c.id === "agent-funds");
    expect(funds?.state).toBe("warn");
    expect(funds?.text).toContain("4.5 USDC");
    expect(funds?.text).toContain("not cover");
    expect(isProtected(assessProtection(s))).toBe(false);
  });
  it("allows exactly the gas ceiling and warns one unit over", () => {
    expect(state({ ...base, agentTokens: MAX_AGENT_GAS, agentNative: MAX_AGENT_GAS * 10n ** 12n }, "agent-funds")).toBe("ok");
    expect(state({ ...base, agentTokens: MAX_AGENT_GAS + 1n, agentNative: (MAX_AGENT_GAS + 1n) * 10n ** 12n }, "agent-funds")).toBe("warn");
  });
  it("asks for gas when the agent has none", () => {
    expect(state({ ...base, agentTokens: 0n, agentNative: 0n }, "agent-gas")).toBe("todo");
  });
  it("refuses an agent that is the owner, regardless of case", () => {
    const s = { ...base, agent: base.owner.toUpperCase().replace("0X", "0x") };
    expect(state(s, "agent")).toBe("warn");
    expect(isProtected(assessProtection(s))).toBe(false);
  });
  it("asks for a policy when no agent is set", () => {
    expect(state({ ...base, agent: "0x0000000000000000000000000000000000000000" }, "agent")).toBe("todo");
  });
  it("is not protected while paused", () => {
    expect(isProtected(assessProtection({ ...base, paused: true }))).toBe(false);
  });
  it("on a chain where native and token differ, reads gas from the native balance", () => {
    const s = { ...base, sameMoney: false, agentTokens: 0n, agentNative: 10n ** 18n };
    expect(state(s, "agent-gas")).toBe("ok");
  });
});

describe("code check", () => {
  const artifact: Artifact = {
    abi: [],
    bytecode: "0x",
    deployedBytecode: `0xaabb${"00".repeat(4)}ccdd`,
    immutableReferences: { "1": [{ start: 2, length: 4 }] },
  };
  it("ignores the immutable ranges only", () => {
    expect(matchesBuild("0xaabb" + "11223344" + "ccdd", artifact)).toBe(true);
    expect(matchesBuild("0xAABB" + "11223344" + "CCDD", artifact)).toBe(true);
    expect(matchesBuild("0xaabb" + "11223344" + "ccde", artifact)).toBe(false);
    expect(matchesBuild("0xaabc" + "11223344" + "ccdd", artifact)).toBe(false);
  });
  it("ignores the metadata trailer, which changes with tooling, but not the code before it", () => {
    // Two bytes of code, a 5-byte CBOR trailer starting with a map byte (0xa2), then its length (0x0005).
    const artifact: Artifact = { abi: [], bytecode: "0x", deployedBytecode: "0x6001a2aabbccdd0005", immutableReferences: {} };
    expect(matchesBuild("0x6001a2112233440005", artifact)).toBe(true); // different trailer content
    expect(matchesBuild("0x6002a2aabbccdd0005", artifact)).toBe(false); // different code
  });
  it("does not strip a trailer that does not look like one", () => {
    const artifact: Artifact = { abi: [], bytecode: "0x", deployedBytecode: "0x60016002600360040005", immutableReferences: {} };
    expect(matchesBuild("0x60016002600360050005", artifact)).toBe(false); // last bytes are code, not a trailer
  });
  it("rejects an address with no code", () => {
    expect(matchesBuild("0x", artifact)).toBe(false);
  });
});
