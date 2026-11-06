// Reading a vault's history from a public RPC that limits how much one call may cover, and how many calls.
// Source: https://docs.arc.io/arc/references/rpc-endpoints.md (read 6 Nov 2026). `eth_getLogs` fails with
// -32012 above 10,000 blocks, so clients page in chunks of at most 9,999. The primary endpoint sits behind a
// load balancer, so -32014 ("block not imported yet") is safe to retry after a short pause.
// Observed on the live endpoint, not in its docs: it also answers HTTP 429 / -32005 "rate limit exceeded"
// after a few dozen requests in quick succession, and the budget does not refill within seconds.

/** Blocks per `eth_getLogs` call. One under Arc's documented limit of 10,000. */
export const MAX_LOG_RANGE = 9_999n;

type Walked = { code?: number; message?: string };
const walk = (error: unknown): Walked[] => {
  const found: Walked[] = [];
  for (let e = error as (Walked & { cause?: unknown }) | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) found.push(e);
  return found;
};

/** The load-balancer error the Arc docs say to retry. Matches the code or its text, at any depth. */
export function isRetryableRpcError(error: unknown): boolean {
  return walk(error).some((e) => e.code === -32014 || /-32014/.test(e.message ?? ""));
}
/** HTTP 429 or -32005: too many requests. Worth waiting for, unlike a refused range. */
export function isRateLimitError(error: unknown): boolean {
  return walk(error).some((e) => e.code === -32005 || /-32005|rate limit|\b429\b/i.test(e.message ?? ""));
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so the page can say it is waiting rather than look stuck. */
  onWait?: (ms: number, why: "rate limit" | "block not imported") => void;
}

/**
 * Runs one RPC call, waiting and retrying when the endpoint says to: -32014 up to 3 times (0.4s, 0.8s, 1.6s)
 * and rate limits up to 5 times (0.5s doubling to 8s). Any other error is thrown at once.
 */
export async function retryRpc<T>(call: () => Promise<T>, { sleep = sleepFor, onWait }: RetryOptions = {}): Promise<T> {
  let notImported = 0;
  let limited = 0;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (isRateLimitError(error) && limited < 5) {
        const ms = 500 * 2 ** limited++;
        onWait?.(ms, "rate limit");
        await sleep(ms);
      } else if (isRetryableRpcError(error) && notImported < 3) {
        const ms = 400 * 2 ** notImported++;
        onWait?.(ms, "block not imported");
        await sleep(ms);
      } else {
        throw error;
      }
    }
  }
}

/**
 * The first block at which an address has code. Searches outward from `head` in jumps that double from
 * 10,000 blocks (at most six jumps), since most vaults are young, then bisects the last gap. Needs a node that answers
 * historical state, so it can throw: callers must handle that. Returns undefined if there is no code at `head`.
 */
export async function findFirstBlockWithCode(hasCode: (block: bigint) => Promise<boolean>, head: bigint): Promise<bigint | undefined> {
  if (!(await hasCode(head))) return undefined;
  let high = head; // invariant: code exists at `high`
  let step = 10_000n;
  let low = 0n; // invariant: no code below `low`
  // Six jumps reach back 640,000 blocks. A vault older than that is bisected from genesis instead.
  for (let jumps = 0; jumps < 6; jumps++) {
    if (high - step <= 0n) break; // the vault is older than the chain reaches back: bisect from genesis
    const probe = high - step;
    if (await hasCode(probe)) {
      high = probe;
      step *= 2n;
    } else {
      low = probe + 1n;
      break;
    }
  }
  while (low < high) {
    const middle = (low + high) / 2n;
    if (await hasCode(middle)) high = middle;
    else low = middle + 1n;
  }
  return high;
}

/**
 * Checks a claimed creation block with two lookups: code exists at it and not one block before. Returns the
 * block if it holds, otherwise undefined. A wrong hint costs two calls and is then ignored.
 */
export async function verifyCreationBlock(hasCode: (block: bigint) => Promise<boolean>, claimed: bigint): Promise<bigint | undefined> {
  if (claimed < 0n || !(await hasCode(claimed))) return undefined;
  if (claimed > 0n && (await hasCode(claimed - 1n))) return undefined;
  return claimed;
}

export interface PagedLogs<T> {
  items: T[];
  /** The oldest block that was actually scanned. */
  scannedFrom: bigint;
  /** True only if every block from `start` to `end` was scanned. */
  complete: boolean;
  /** Why it stopped early, in words fit for the owner. */
  reason?: string;
}

export interface PageOptions extends RetryOptions {
  /** Set false when the caller's transport already retries, so waits are not multiplied. */
  retry?: boolean;
  chunk?: bigint;
  /** Most calls to make before giving up with a partial result. */
  maxPages?: number;
}

/**
 * Reads `fetchRange` over [start, end], newest chunk first, so a partial result holds the latest history.
 * Never asks for more than `chunk` blocks at once. Ranges are inclusive and never overlap or leave a gap.
 */
export async function pageLogs<T>(
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>,
  start: bigint,
  end: bigint,
  { chunk = MAX_LOG_RANGE, maxPages = 400, retry = true, ...waiting }: PageOptions = {},
): Promise<PagedLogs<T>> {
  const items: T[] = [];
  if (end < start) return { items, scannedFrom: start, complete: true };
  let to = end;
  let scannedFrom = end + 1n;
  let pages = 0;
  while (to >= start) {
    if (pages >= maxPages) {
      return { items, scannedFrom, complete: false, reason: `it stopped after ${pages} requests to keep the page responsive` };
    }
    const from = to - chunk + 1n > start ? to - chunk + 1n : start;
    try {
      items.push(...(await (retry ? retryRpc(() => fetchRange(from, to), waiting) : fetchRange(from, to))));
    } catch (error) {
      const message = walk(error).map((e) => e.message).find(Boolean) ?? "an RPC error";
      return { items, scannedFrom, complete: false, reason: `the RPC refused blocks ${from} to ${to} (${message.slice(0, 120)})` };
    }
    pages++;
    scannedFrom = from;
    if (from === start) break;
    to = from - 1n;
  }
  return { items, scannedFrom, complete: true };
}
