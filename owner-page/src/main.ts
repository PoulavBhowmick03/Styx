import { getAddress, pad, type Address, type Hex } from "viem";

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

// The World gate is optional and sits in front of the wallet only. The contract never checks World.
const worldGate = import.meta.env.VITE_WORLD_GATE === "1";
const worldButton = element<HTMLButtonElement>("world");
let approvedAttempt: string | undefined;
let currentDigest: Hex | undefined;

function showStatus(message: string, isError = false): void {
  statusLine.textContent = message;
  statusLine.classList.toggle("error", isError);
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
      showStatus("Signed. Give this file to the agent's erebus_submit_payment tool.");
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

element("trust-vault").addEventListener("click", () => {
  confirmVault?.().catch(() => showStatus("The wallet did not connect.", true));
});

element("connect-wallet").addEventListener("click", () => {
  if (relayLink) void prepareReview(relayLink);
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
    await prepareReview(relayLink);
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
