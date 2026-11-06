import { getAddress, pad, toHex, type Address, type Hex } from "viem";

import {
  ApprovalError,
  buildSignatureFile,
  configFromChain,
  mayPostSignature,
  parseOwnerConfig,
  parsePending,
  parseRelayLink,
  parseTrust,
  POLICY_CALLS,
  relayForFirstUse,
  reviewAgainstChain,
  reviewPending,
  serializeTrust,
  TRUST_PREFIX,
  trustKey,
  typedDataRequest,
  type ChainFacts,
  type OwnerConfig,
  type Pending,
  type RelayLink,
  type VaultTrust,
} from "./approval";
import { linkMessage } from "./messages";
import {
  buildSignatureFileV2,
  callData,
  isPendingV2,
  parsePendingV2,
  reviewPendingV2,
  typedDataRequestV2,
  type ChainFactsV2,
  type PendingV2,
} from "./approval-v2";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element ${id}`);
  return found as T;
}

const configInput = element<HTMLInputElement>("config-file");
const pendingInput = element<HTMLInputElement>("pending-file");
const review = element<HTMLElement>("review");
const signButton = element<HTMLButtonElement>("sign");
const statusLine = element<HTMLElement>("status");
const output = element<HTMLElement>("output");
const outputText = element<HTMLTextAreaElement>("output-text");
const download = element<HTMLAnchorElement>("download");

let config: OwnerConfig | undefined;
let pending: Pending | undefined;
let pendingV2: PendingV2 | undefined;

// The World gate is optional and sits in front of the wallet only. The contract never checks World.
const worldGate = import.meta.env.VITE_WORLD_GATE === "1";
const worldButton = element<HTMLButtonElement>("world");
let approvedAttempt: string | undefined;
let currentDigest: Hex | undefined;

function showStatus(message: string, isError = false): void {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
  // Display only: a finished signature reads differently from a plain progress message.
  statusLine.classList.toggle("done", !isError && message.startsWith("Signed"));
}

function resetReview(): void {
  review.hidden = true;
  signButton.hidden = true;
  worldButton.hidden = true;
  output.hidden = true;
  approvedAttempt = undefined;
}

// `textContent` only: the invoice reference is agent-supplied text and must never be parsed as HTML.
function render(): void {
  resetReview();
  hideHelpers();
  if (!config || !pending) return;
  try {
    const view = reviewPending(pending, config, BigInt(Math.floor(Date.now() / 1000)));
    element("vault").textContent = view.vault;
    element("vendor").textContent = view.vendorLabel;
    element("recipient").textContent = view.recipient;
    element("amount").textContent = view.amount;
    element("invoice").textContent = view.invoiceReference;
    element("expiry").textContent = view.expiresAt;
    element("rule").textContent = view.exceededRule;
    element("digest").textContent = view.digest;
    review.hidden = false;
    currentDigest = view.digest;
    if (worldGate) {
      worldButton.hidden = false;
      showStatus("Check every field, then verify with World before signing.");
    } else {
      signButton.hidden = false;
      showStatus(
        relayLink && !mayPostSignature(relayLink, config)
          ? "This link's relay is not the one you set for this vault, so a signature would stay here as a file and not reach the agent."
          : "Check every field, then sign with the owner wallet.",
        Boolean(relayLink && !mayPostSignature(relayLink, config)),
      );
    }
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "This approval could not be read.", true);
    return;
  }
  void checkChain(config, pending);
}

let chainCheck = 0;
// Asks the owner's own wallet what the vault reports. If it cannot answer, the page keeps the agent's
// number labelled as unverified: the vault enforces the limit whatever this page shows.
async function checkChain(ownerConfig: OwnerConfig, request: Pending): Promise<void> {
  const check = ++chainCheck;
  const wallet = window.ethereum;
  if (!wallet) return;
  const read = async (data: Hex) => {
    const result = (await wallet.request({ method: "eth_call", params: [{ to: request.vault, data }, "latest"] })) as string;
    if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error("no answer");
    return BigInt(result);
  };
  let rule: string;
  try {
    const chainId = BigInt((await wallet.request({ method: "eth_chainId" })) as string);
    if (chainId !== ownerConfig.chainId) return;
    const [perPaymentLimit, policyVersion] = await Promise.all([read(POLICY_CALLS.perPaymentLimit), read(POLICY_CALLS.policyVersion)]);
    if (check !== chainCheck) return;
    try {
      rule = reviewAgainstChain(request, { perPaymentLimit, policyVersion });
    } catch (error) {
      signButton.hidden = true;
      worldButton.hidden = true;
      showStatus(error instanceof ApprovalError ? error.message : "This approval could not be checked.", true);
      return;
    }
  } catch {
    return;
  }
  element("rule").textContent = rule;
}

async function readJson(input: HTMLInputElement): Promise<unknown> {
  const file = input.files?.[0];
  if (!file) throw new ApprovalError("no file selected");
  try {
    return JSON.parse(await file.text());
  } catch {
    throw new ApprovalError("the file is not valid JSON");
  }
}

function handleLoad(input: HTMLInputElement, apply: (value: unknown) => void): void {
  input.addEventListener("change", () => {
    readJson(input)
      .then((value) => {
        apply(value);
        render();
      })
      .catch((error: unknown) => {
        resetReview();
        showStatus(error instanceof ApprovalError ? error.message : "The file could not be read.", true);
      });
  });
}

handleLoad(configInput, (value) => {
  config = parseOwnerConfig(value);
  rememberConfig(value);
  showStatus("Owner config loaded.");
});
handleLoad(pendingInput, (value) => {
  pending = parsePending(value);
  showStatus("Approval request loaded.");
});

worldButton.addEventListener("click", () => {
  void verifyWithWorld();
});

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApprovalError("The World check is unavailable.");
  return (await response.json()) as Record<string, unknown>;
}

async function verifyWithWorld(): Promise<void> {
  if (!currentDigest) return;
  worldButton.disabled = true;
  try {
    const started = await postJson("/api/step-up/start", { digest: currentDigest });
    const attemptId = String(started.attemptId);
    window.open(String(started.authorizeUrl), "world-check", "noopener");
    showStatus("Complete the World check in the new window.");
    for (let elapsed = 0; elapsed < 300; elapsed += 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const response = await fetch(`/api/step-up/status?attemptId=${encodeURIComponent(attemptId)}`);
      const state = (await response.json()) as { status: string; reason?: string; subject?: string };
      if (state.status === "approved") {
        approvedAttempt = attemptId;
        worldButton.hidden = true;
        signButton.hidden = false;
        showStatus("World check passed. Sign with the owner wallet.");
        return;
      }
      if (state.status === "denied") {
        const subject = state.subject ? ` Subject: ${state.subject}` : "";
        showStatus(`World check failed: ${state.reason ?? "denied"}.${subject}`, true);
        return;
      }
    }
    showStatus("The World check timed out. Nothing was signed.", true);
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "The World check is unavailable.", true);
  } finally {
    worldButton.disabled = false;
  }
}

signButton.addEventListener("click", () => {
  void sign();
});

async function sign(): Promise<void> {
  if (pendingV2) return signV2(pendingV2);
  if (!config || !pending) return;
  const wallet = window.ethereum;
  if (!wallet) {
    showStatus("No wallet found in this browser profile.", true);
    return;
  }
  signButton.disabled = true;
  try {
    if (worldGate) {
      // Spent here, immediately before the wallet prompt, so one check allows one signature.
      const { allowed } = await postJson("/api/step-up/consume", {
        attemptId: approvedAttempt,
        digest: currentDigest,
      });
      approvedAttempt = undefined;
      if (allowed !== true) {
        signButton.hidden = true;
        worldButton.hidden = false;
        showStatus("The World check has expired or was used. Verify again.", true);
        return;
      }
      signButton.hidden = true;
      worldButton.hidden = false;
    }
    const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
    const account = accounts[0] ? getAddress(accounts[0]) : undefined;
    if (account !== config.owner) {
      showStatus("Connect the owner account in your wallet, then try again.", true);
      return;
    }
    const chainId = BigInt((await wallet.request({ method: "eth_chainId" })) as string);
    if (chainId !== config.chainId) {
      showStatus(`Switch your wallet to chain ${config.chainId}, then try again.`, true);
      return;
    }
    const signature = (await wallet.request({
      method: "eth_signTypedData_v4",
      params: [account, typedDataRequest(pending)],
    })) as Hex;
    const file = await buildSignatureFile(pending, config, signature);
    outputText.value = file;
    download.href = URL.createObjectURL(new Blob([file], { type: "application/json" }));
    download.download = `signature-${pending.payment.paymentId.slice(2, 14)}.json`;
    output.hidden = false;
    signButton.hidden = true;
    worldButton.hidden = true;
    if (relayLink && !mayPostSignature(relayLink, config)) {
      showStatus("Signed, but not sent: this link's relay is not the one you set for this vault. Give the agent this file instead.", true);
    } else if (relayLink) {
      const sent = await sendToRelay(relayLink, file);
      if (sent === "accepted") showStatus("Signed, and the relay accepted it. The agent still has to collect and submit it.");
      else if (sent === "refused") showStatus("Signed, but the relay refused the signature. Check the request and your vault settings.", true);
      else showStatus("Signed, but the relay could not be reached. Give the agent this file instead.", true);
    } else {
      showStatus("Signed. Give this file to the agent's styx_submit_payment tool.");
    }
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "The wallet did not sign.", true);
  } finally {
    signButton.disabled = false;
  }
}

// ---- Opening a request from an alert's link ----

const CONFIG_KEY = "vault-owner-config";

// A convenience so the owner picks their config once per browser. Everything still works without it.
function rememberConfig(value: unknown): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(value));
  } catch {
    // Storage can be blocked. The owner just picks the file again next time.
  }
}
function restoreConfig(): void {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) config = parseOwnerConfig(JSON.parse(stored));
  } catch {
    config = undefined;
  }
}
async function sendToRelay(link: RelayLink, file: string): Promise<"accepted" | "refused" | "unreachable"> {
  try {
    const response = await fetch(`${link.relay}/requests/${encodeURIComponent(link.request)}/signature`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: file,
    });
    return response.ok ? "accepted" : "refused";
  } catch {
    return "unreachable";
  }
}
async function openFromLink(link: RelayLink): Promise<void> {
  element("pending-label").hidden = true;
  element("config-details").hidden = true;
  showStatus("Loading the approval request.");
  try {
    const response = await fetch(`${link.relay}/requests/${encodeURIComponent(link.request)}`);
    if (!response.ok) throw new ApprovalError(response.status === 410 ? "this approval has expired" : "this approval request was not found");
    const body = (await response.json()) as { pending?: unknown };
    if (isPendingV2(body.pending)) {
      pendingV2 = parsePendingV2(body.pending);
      await prepareReviewV2();
      return;
    }
    pending = parsePending(body.pending);
    await prepareReview(link);
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "The relay could not be reached.", true);
  }
}

// ---- Approving with no config file ----

// Source for Arc's values: https://docs.arc.io/arc/references/connect-to-arc
const ARC_CHAIN_ID = 5042002n;
const ARC_CHAIN = {
  chainId: `0x${ARC_CHAIN_ID.toString(16)}`,
  chainName: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.testnet.arc.io"],
  blockExplorerUrls: ["https://explorer.testnet.arc.io"],
};
const BUILT_IN_RELAY: string | undefined = import.meta.env.VITE_RELAY_URL || undefined;

// Kept for this page load too, so blocked storage only means the owner is asked again next time.
const confirmedVaults = new Map<string, VaultTrust>();

function loadTrust(chainId: bigint, vault: Address): VaultTrust | undefined {
  const key = trustKey(chainId, vault);
  const held = confirmedVaults.get(key);
  if (held) return held;
  try {
    const stored = localStorage.getItem(key);
    const trust = stored ? parseTrust(stored) : undefined;
    return trust && trust.chainId === chainId && trust.vault === vault ? trust : undefined;
  } catch {
    return undefined;
  }
}

function saveTrust(trust: VaultTrust): void {
  const key = trustKey(trust.chainId, trust.vault);
  confirmedVaults.set(key, trust);
  try {
    localStorage.setItem(key, serializeTrust(trust));
  } catch {
    // Storage can be blocked. The owner just confirms again next time.
  }
}

function otherKnownVault(vault: Address): string | undefined {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(TRUST_PREFIX)) continue;
      const known = parseTrust(localStorage.getItem(key) ?? "");
      if (known && known.vault !== vault) return known.vault;
    }
  } catch {
    // Without storage there is nothing to compare against.
  }
  return undefined;
}

/** Labels the owner typed on the setup page, on this same site. They only ever name a vendor. */
function savedLabels(chainId: bigint, vault: Address): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`vault-setup:labels:${chainId}:${vault.toLowerCase()}`) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

async function readFacts(wallet: Eip1193, request: Pending): Promise<ChainFacts> {
  const read = async (data: Hex) => {
    const result = (await wallet.request({ method: "eth_call", params: [{ to: request.vault, data }, "latest"] })) as string;
    if (!/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error("no answer");
    return result as Hex;
  };
  const wordToAddress = (word: Hex) => getAddress(`0x${word.slice(-40)}`);
  const [owner, token, allowed] = await Promise.all([
    read(POLICY_CALLS.owner),
    read(POLICY_CALLS.token),
    read(`${POLICY_CALLS.allowedRecipient}${pad(request.payment.recipient).slice(2)}` as Hex),
  ]);
  return { owner: wordToAddress(owner), token: wordToAddress(token), recipientAllowed: BigInt(allowed) === 1n };
}

function hideHelpers(): void {
  element("first-use").hidden = true;
  element("wallet-help").hidden = true;
  element("switch-chain").hidden = true;
  element("connect-wallet").hidden = true;
}

/**
 * Reaches the review step from a link. A config file that names a relay keeps working as before.
 * Otherwise the vault's own answers fill the config. If they cannot be read there is nothing to check
 * the request against, so the sign button stays hidden.
 */
async function prepareReview(link: RelayLink): Promise<void> {
  hideHelpers();
  if (!pending) return;
  if (config?.relay && config.vault === pending.vault) {
    render();
    return;
  }
  const wallet = window.ethereum;
  if (!wallet) {
    const { host, pathname, search } = window.location;
    element<HTMLAnchorElement>("open-wallet").href = `https://link.metamask.io/dapp/${host}${pathname}${search}`;
    element("wallet-help").hidden = false;
    showStatus("Open this request in your wallet's browser to review and sign it.");
    return;
  }
  const chainId = BigInt((await wallet.request({ method: "eth_chainId" })) as string);
  if (chainId !== pending.chainId) {
    element("switch-chain").hidden = pending.chainId !== ARC_CHAIN_ID;
    showStatus(`Switch your wallet to chain ${pending.chainId}, then try again.`, true);
    return;
  }
  let facts: ChainFacts;
  try {
    facts = await readFacts(wallet, pending);
  } catch {
    showStatus("This vault could not be read through your wallet, so there is nothing to check this request against.", true);
    return;
  }
  let trust = loadTrust(pending.chainId, pending.vault);
  if (!trust) {
    // A build with its own relay needs no question. A signature is bound to one vault, so one made for a
    // fake vault cannot move this owner's funds, and a link cannot choose the relay. A question is only
    // left for a browser that knows a different vault, or a build that would take the relay from the link.
    if (!BUILT_IN_RELAY || otherKnownVault(pending.vault)) {
      askToConfirmVault(link, facts);
      return;
    }
    let isOwner: boolean;
    try {
      isOwner = await connectedAsOwner(wallet, facts);
    } catch {
      element("connect-wallet").hidden = false;
      showStatus("Connect the owner wallet to review this request.", true);
      return;
    }
    if (!isOwner) {
      showStatus(`This wallet is not the vault's owner. Connect ${facts.owner}, then try again.`, true);
      return;
    }
    trust = { chainId: pending.chainId, vault: pending.vault, relay: relayForFirstUse(link, BUILT_IN_RELAY) };
    saveTrust(trust);
  }
  config = configFromChain(pending, facts, trust, savedLabels(pending.chainId, pending.vault));
  render();
}

async function connectedAsOwner(wallet: Eip1193, facts: ChainFacts): Promise<boolean> {
  const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
  return Boolean(accounts[0]) && getAddress(accounts[0]!) === facts.owner;
}

let confirmVault: (() => Promise<void>) | undefined;

function askToConfirmVault(link: RelayLink, facts: ChainFacts): void {
  if (!pending) return;
  const request = pending;
  const relay = relayForFirstUse(link, BUILT_IN_RELAY);
  const other = otherKnownVault(request.vault);
  element("first-use-vault").textContent = request.vault;
  element("first-use-owner").textContent = facts.owner;
  element("first-use-relay").textContent = relay;
  element("first-use-warning").textContent = other
    ? `Careful: this browser already knows a different vault, ${other}. Do not continue unless you also own this one.`
    : "";
  element("first-use").hidden = false;
  showStatus("First approval for this vault in this browser. Check that this is your vault.");
  confirmVault = async () => {
    const wallet = window.ethereum;
    if (!wallet) return;
    if (!(await connectedAsOwner(wallet, facts))) {
      showStatus(`This wallet is not the vault's owner. Connect ${facts.owner}, then try again.`, true);
      return;
    }
    saveTrust({ chainId: request.chainId, vault: request.vault, relay });
    await prepareReview(link);
  };
}

// ---- Linking Telegram to a wallet, so alerts reach the right person ----

function showLinkView(): void {
  element("link-view").hidden = false;
  element("config-details").hidden = true;
  element("pending-label").hidden = true;
  if (!BUILT_IN_RELAY) showStatus("This build has no relay to link with.", true);
}

async function linkTelegram(): Promise<void> {
  const wallet = window.ethereum;
  if (!wallet) {
    const { host, pathname, search } = window.location;
    element<HTMLAnchorElement>("open-wallet").href = `https://link.metamask.io/dapp/${host}${pathname}${search}`;
    element("wallet-help").hidden = false;
    showStatus("Open this page in your wallet's browser to connect.");
    return;
  }
  if (!BUILT_IN_RELAY) return;
  const relay = new URL(BUILT_IN_RELAY).origin;
  const button = element<HTMLButtonElement>("link-connect");
  button.disabled = true;
  try {
    const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts[0]) throw new ApprovalError("Connect a wallet, then try again.");
    const account = getAddress(accounts[0]);
    element("link-wallet").textContent = account;
    element("link-wallet-row").hidden = false;
    const issuedAt = Math.floor(Date.now() / 1000);
    const message = linkMessage(account, issuedAt);
    const signature = (await wallet.request({ method: "personal_sign", params: [toHex(message), account] })) as Hex;
    const response = await fetch(`${relay}/links/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: account, issuedAt, signature }),
    });
    const body = (await response.json()) as { botUrl?: string; error?: string };
    if (!response.ok || !body.botUrl?.startsWith("https://t.me/")) throw new ApprovalError(body.error ?? "The relay did not answer. Try again.");
    const bot = element<HTMLAnchorElement>("link-bot");
    bot.href = body.botUrl;
    bot.hidden = false;
    button.hidden = true;
    showStatus("Now open Telegram and press Start. This link works once, for 10 minutes.");
    void watchLink(relay, account);
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "The wallet did not sign. Nothing was linked.", true);
  } finally {
    button.disabled = false;
  }
}

async function watchLink(relay: string, account: Address): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const reply = (await (await fetch(`${relay}/links/${account}`)).json()) as { linked?: boolean };
      if (reply.linked) {
        element("link-bot").hidden = true;
        element("link-done").hidden = false;
        showStatus("Signed. Your wallet is linked to Telegram.");
        return;
      }
    } catch {
      // Asked again on the next pass.
    }
  }
}

element("link-connect").addEventListener("click", () => {
  void linkTelegram();
});

// ---- A v2 request: the signer may be an approver with their own wallet ----

// Arc's own public endpoints, from https://docs.arc.io/arc/references/connect-to-arc. Used only if the
// wallet's RPC cannot answer, because wallets often sit on a rate-limited endpoint. The page is already
// what the owner trusts to show a request, and the vault checks every signature whatever this reads.
const ARC_READ_RPCS = ["https://arc-testnet.drpc.org", "https://rpc.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"];

async function readThroughArc(to: Address, data: Hex): Promise<string> {
  for (const url of ARC_READ_RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
      });
      const reply = (await response.json()) as { result?: unknown };
      if (typeof reply.result === "string") return reply.result;
    } catch {
      // The next endpoint may answer.
    }
  }
  throw new Error("no answer");
}

/** One read at a time, retried, because a burst is what rate-limited wallet endpoints refuse. */
async function readVault(wallet: Eip1193, request: PendingV2, data: Hex, words: number): Promise<bigint[]> {
  const shape = new RegExp(`^0x[0-9a-fA-F]{${64 * words}}$`);
  let result: string | undefined;
  for (let attempt = 0; attempt < 3 && result === undefined; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    try {
      const answer = await wallet.request({ method: "eth_call", params: [{ to: request.vault, data }, "latest"] });
      if (typeof answer === "string" && shape.test(answer)) result = answer;
    } catch {
      // Retried below.
    }
  }
  if (result === undefined && request.chainId === ARC_CHAIN_ID) result = await readThroughArc(request.vault, data);
  if (result === undefined || !shape.test(result)) throw new Error("no answer");
  const answer = result;
  return Array.from({ length: words }, (_, index) => BigInt(`0x${answer.slice(2 + index * 64, 66 + index * 64)}`));
}

async function readFactsV2(wallet: Eip1193, request: PendingV2): Promise<ChainFactsV2> {
  const read = (data: Hex, words = 1) => readVault(wallet, request, data, words);
  const toAddress = (word: bigint) => getAddress(`0x${word.toString(16).padStart(40, "0")}`);
  const { agent, recipient } = request.payment;
  const { signer } = request.authorization;
  const [version] = await read(callData("contractVersion"));
  const [owner] = await read(callData("owner"));
  const [token] = await read(callData("token"));
  const [paused] = await read(callData("paused"));
  const [allowed] = await read(callData("allowedRecipient", [recipient]));
  const [recipientVersion] = await read(callData("recipientVersion", [recipient]));
  const policy = await read(callData("agentPolicy", [agent]), 5);
  const approver = await read(callData("approverState", [signer]), 2);
  return {
    contractVersion: version!,
    owner: toAddress(owner!),
    token: toAddress(token!),
    paused: paused === 1n,
    recipientAllowed: allowed === 1n,
    recipientVersion: recipientVersion!,
    agentVersion: policy[0]!,
    agentPerPaymentLimit: policy[1]!,
    agentValidUntil: policy[3]!,
    agentEnabled: policy[4] === 1n,
    signerVersion: approver[0]!,
    signerEnabled: approver[1] === 1n,
  };
}

let connectedV2: Address | undefined;

/** The vault's answers fill the review. If they cannot be read, the sign button stays hidden. */
async function prepareReviewV2(): Promise<void> {
  hideHelpers();
  resetReview();
  const request = pendingV2;
  if (!request) return;
  const wallet = window.ethereum;
  if (!wallet) {
    const { host, pathname, search } = window.location;
    element<HTMLAnchorElement>("open-wallet").href = `https://link.metamask.io/dapp/${host}${pathname}${search}`;
    element("wallet-help").hidden = false;
    showStatus("Open this request in your wallet's browser to review and sign it.");
    return;
  }
  const chainId = BigInt((await wallet.request({ method: "eth_chainId" })) as string);
  if (chainId !== request.chainId) {
    element("switch-chain").hidden = request.chainId !== ARC_CHAIN_ID;
    showStatus(`Switch your wallet to chain ${request.chainId}, then try again.`, true);
    return;
  }
  let facts: ChainFactsV2;
  try {
    facts = await readFactsV2(wallet, request);
  } catch {
    showStatus("This vault could not be read through your wallet, so there is nothing to check this request against.", true);
    return;
  }
  let accounts: string[];
  try {
    accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
  } catch {
    element("connect-wallet").hidden = false;
    showStatus("Connect your wallet to review this request.", true);
    return;
  }
  if (!accounts[0]) {
    element("connect-wallet").hidden = false;
    showStatus("Connect your wallet to review this request.", true);
    return;
  }
  connectedV2 = getAddress(accounts[0]);
  try {
    const view = reviewPendingV2(request, facts, connectedV2, BigInt(Math.floor(Date.now() / 1000)));
    element("vault").textContent = view.vault;
    element("vendor").textContent = view.agent;
    element("vendor-label").textContent = "Requested by agent";
    element("vendor-note").hidden = true;
    element("signer-row").hidden = false;
    element("signer").textContent = `${view.signer} (${view.signerRole})`;
    element("recipient").textContent = view.recipient;
    element("amount").textContent = view.amount;
    element("invoice").textContent = view.invoiceReference;
    element("expiry").textContent = view.expiresAt;
    element("rule").textContent = view.exceededRule;
    element("digest").textContent = view.digest;
    review.hidden = false;
    signButton.hidden = false;
    showStatus("Check every field, then sign with your wallet.");
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "This approval could not be read.", true);
  }
}

async function signV2(request: PendingV2): Promise<void> {
  const wallet = window.ethereum;
  if (!wallet || !connectedV2) {
    showStatus("No wallet found in this browser profile.", true);
    return;
  }
  signButton.disabled = true;
  try {
    const signature = (await wallet.request({
      method: "eth_signTypedData_v4",
      params: [connectedV2, typedDataRequestV2(request)],
    })) as Hex;
    const file = await buildSignatureFileV2(request, signature);
    outputText.value = file;
    download.href = URL.createObjectURL(new Blob([file], { type: "application/json" }));
    download.download = `signature-${request.payment.paymentId.slice(2, 14)}.json`;
    output.hidden = false;
    signButton.hidden = true;
    // Only a build's own relay receives a v2 signature. A link cannot choose where it goes.
    if (relayLink && BUILT_IN_RELAY && new URL(BUILT_IN_RELAY).origin === relayLink.relay) {
      const sent = await sendToRelay(relayLink, file);
      if (sent === "accepted") showStatus("Signed, and the relay accepted it. The agent still has to collect and submit it.");
      else if (sent === "refused") showStatus("Signed, but the relay refused the signature. Check the request.", true);
      else showStatus("Signed, but the relay could not be reached. Give the agent this file instead.", true);
    } else {
      showStatus("Signed, but not sent: this link's relay is not the one this site uses. Give the agent this file instead.", true);
    }
  } catch (error) {
    showStatus(error instanceof ApprovalError ? error.message : "The wallet did not sign.", true);
  } finally {
    signButton.disabled = false;
  }
}

element("trust-vault").addEventListener("click", () => {
  confirmVault?.().catch(() => showStatus("The wallet did not connect.", true));
});

element("connect-wallet").addEventListener("click", () => {
  if (pendingV2) void prepareReviewV2();
  else if (relayLink) void prepareReview(relayLink);
});

element("switch-chain").addEventListener("click", () => {
  void switchToArc();
});

async function switchToArc(): Promise<void> {
  const wallet = window.ethereum;
  if (!wallet || !relayLink) return;
  try {
    try {
      await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_CHAIN.chainId }] });
    } catch (error) {
      if ((error as { code?: number }).code !== 4902) throw error;
      await wallet.request({ method: "wallet_addEthereumChain", params: [ARC_CHAIN] });
    }
    if (pendingV2) await prepareReviewV2();
    else await prepareReview(relayLink);
  } catch {
    showStatus("The wallet did not switch networks.", true);
  }
}

restoreConfig();
let relayLink: RelayLink | undefined;
try {
  relayLink = parseRelayLink(window.location.search);
} catch (error) {
  showStatus(error instanceof ApprovalError ? error.message : "This approval link is malformed.", true);
}
if (relayLink) void openFromLink(relayLink);
// The landing text shows only when the URL carries no approval link at all.
{
  const params = new URLSearchParams(window.location.search);
  const asking = params.has("relay") || params.has("request");
  if (params.has("link") && !asking) showLinkView();
  else if (!asking) element("landing").hidden = false;
}
