// Money never touches a JavaScript number. Amounts are decimal strings in, bigints out.
// The ERC-20 side of USDC has 6 decimals and the native side on Arc has 18. Same balance, two scales.

export const TOKEN_DECIMALS = 6;
export const NATIVE_DECIMALS = 18;
/** 10^12: the factor between the native (18) and ERC-20 (6) views of one Arc USDC balance. */
export const NATIVE_PER_TOKEN_UNIT = 10n ** BigInt(NATIVE_DECIMALS - TOKEN_DECIMALS);

export class AmountError extends Error {}

/** Parses "1", "0.25" or "12.345678" to base units. Refuses anything finer than the token can hold. */
export function parseUsdc(text: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(text.trim());
  if (!match) throw new AmountError("Enter a plain decimal amount with at most 6 decimals, like 0.25");
  const whole = BigInt(match[1] ?? "0");
  const fraction = BigInt((match[2] ?? "").padEnd(TOKEN_DECIMALS, "0") || "0");
  return whole * 10n ** BigInt(TOKEN_DECIMALS) + fraction;
}

function format(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Base units (6 decimals) to a decimal string. */
export function formatUsdc(value: bigint): string {
  return format(value, TOKEN_DECIMALS);
}

/** Native wei-style units (18 decimals) to a decimal string. */
export function formatNative(value: bigint): string {
  return format(value, NATIVE_DECIMALS);
}
