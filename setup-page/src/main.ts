import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { erc20Abi, vaultAbi } from "./abi";
import { AmountError, formatNative, formatUsdc, parseUsdc, TOKEN_DECIMALS } from "./amounts";
import { matchesBuild, type Artifact } from "./build";
import { ARC_TESTNET_ID, ARC_USDC, arcTestnet, chainFor, explorerTx, KNOWN_CODE_HASHES, KNOWN_CREATION_BLOCKS } from "./chains";
import { findFirstBlockWithCode, MAX_LOG_RANGE, pageLogs, retryRpc, verifyCreationBlock } from "./logs";
import { assessProtection, isProtected } from "./protection";
import { initV2 } from "./v2ui";
import { vaultV2Abi } from "./v2";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: () => void): void;
}
declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element ${id}`);
  return found as T;
};
const setText = (id: string, text: string) => void ($(id).textContent = text);

// What the owner keeps for gas on their own address (assumption, see protection.ts).
const OWNER_RESERVE = 200_000n;

/**
 * Reads go through this wrapper so a rate-limited or briefly lagging RPC is waited out, as Arc's public one
 * needs. Anything that signs or sends is never retried here: a retried send could pay twice.
 */
const isRead = (method: string) => /^eth_(get|call$|blockNumber$|chainId$|feeHistory$|gasPrice$)/.test(method);
function readProvider(provider: Eip1193): Eip1193 {
  return {
    request: (args) =>
      isRead(args.method)
        ? retryRpc(() => provider.request(args), { onWait: (ms, why) => status(`The RPC is ${why === "rate limit" ? "rate-limiting requests" : "not ready yet"}. Waiting ${Math.ceil(ms / 1000)}s, then trying again...`) })
        : provider.request(args),
  };
}

let account: Address | undefined;
let chainId = 0;
let pub: PublicClient | undefined;
let wallet: WalletClient | undefined;
let vault: Address | undefined;
let artifact: Artifact | undefined;
let artifactV2: Artifact | undefined;
let busy = false;
/** 2 once the vault answers contractVersion(); 1 for the vaults deployed before it existed. */
let vaultVersion: 1 | 2 = 1;
let pendingWithdrawal: { to: Address; amount: bigint } | undefined;
let pendingFund: { amount: bigint } | undefined;
let balances = { vault: 0n, owner: 0n };
let vaultOwner: Address | undefined;
/** The token the connected vault holds, read from the vault itself. Funding always uses this one. */
let vaultToken: Address | undefined;
/** False when the vault's code differs from this page's build. Funding then needs a deliberate unlock. */
let codeMatches: boolean | undefined;
let fundingUnlocked = false;
/** What the vendor scan has read for the connected vault, so later refreshes read only new blocks. */
let vendorScan: { vault: Address; seen: Set<Address>; scannedTo: bigint } | undefined;
// A vault named in the page's address (?vault=0x...). It is opened only after the wallet connects.
let linkedVault: Address | undefined;

function status(message: string, isError = false): void {
  const line = $("status");
  line.textContent = message;
  line.classList.toggle("error", isError);
}

// localStorage is a per-browser convenience only. It can be empty or throw, and nothing depends on it.
function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
const lastVaultKey = () => `vault-setup:last:${chainId}:${account?.toLowerCase()}`;
const labelsKey = () => `vault-setup:labels:${chainId}:${vault?.toLowerCase()}`;
function labels(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(remembered(labelsKey()) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;
/** Names the vault in every action's status line, so the owner sees which one they are changing. */
const vaultTag = () => (vault ? ` on vault ${short(vault)}` : "");

const recentKey = () => `vault-setup:recent:${chainId}:${account?.toLowerCase()}`;
function recents(): Address[] {
  try {
    const parsed: unknown = JSON.parse(remembered(recentKey()) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string" && isAddress(a, { strict: false })).map((a) => getAddress(a)) : [];
  } catch {
    return [];
  }
}
function addRecent(address: Address): void {
  const list = [address, ...recents().filter((a) => a !== address)].slice(0, 5);
  remember(recentKey(), JSON.stringify(list));
}
function renderRecent(): void {
  const box = $("recent");
  box.replaceChildren(
    ...recents().map((address) => {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = address;
      button.disabled = busy;
      button.addEventListener("click", () => void openVault(address));
      return button;
    }),
  );
}

/** The always-visible banner: which vault every button on the page acts on, and whether you own it. */
function renderBanner(): void {
  const banner = $("vault-banner");
  banner.replaceChildren();
  const line = (className: string, text: string) => {
    const div = document.createElement("div");
    div.className = className;
    div.textContent = text;
    banner.append(div);
    return div;
  };
  if (!vault) {
    banner.className = "none";
    line("label", "VAULT");
    line("meta", account ? "No vault connected yet. Everything below acts on the vault you connect in step 2." : "Connect your wallet to begin.");
    return;
  }
  const mine = vaultOwner !== undefined && account !== undefined && vaultOwner === account;
  banner.className = vaultOwner === undefined || mine ? "" : "notowner";
  line("label", "CONNECTED VAULT: every change on this page acts on this one");
  line("addr", vault);
  const meta = line("meta", `Owner ${vaultOwner ?? "(reading...)"} on ${chainId === ARC_TESTNET_ID ? "Arc Testnet" : `chain ${chainId}`}. `);
  if (vaultOwner !== undefined) {
    const who = document.createElement("span");
    who.className = mine ? "" : "bad";
    who.textContent = mine ? "You are the owner." : "You are NOT the owner: changes are disabled.";
    meta.append(who);
  }
}

/** Forgets everything typed or computed for the previous vault, so nothing from it can be saved on another. */
function resetForVault(): void {
  vaultVersion = 1;
  document.body.dataset.version = "1";
  v2?.reset();
  vaultOwner = undefined;
  vendorScan = undefined;
  codeMatches = undefined;
  fundingUnlocked = false;
  pendingWithdrawal = undefined;
  pendingFund = undefined;
  for (const id of ["policy-agent", "vendor-address", "vendor-label", "fund-amount", "withdraw-amount"]) $<HTMLInputElement>(id).value = "";
  $<HTMLInputElement>("policy-per").value = "1";
  $<HTMLInputElement>("policy-daily").value = "10";
  $<HTMLInputElement>("policy-days").value = "7";
  for (const id of ["withdraw-review", "withdraw-confirm", "fund-review", "fund-confirm", "code-warning", "unlock-funding", "agent-sweep"]) $(id).hidden = true;
  $("vendors").replaceChildren();
  setText("vendors-note", "");
}

function errorText(error: unknown): string {
  // viem wraps wallet errors several levels deep, so walk the whole cause chain for a rejection.
  for (let e = error as { code?: number; name?: string; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return "You rejected the request in your wallet. Nothing was sent.";
  }
  const e = error as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? "Something went wrong.";
}

/** One action at a time. Reports a missing receipt as unknown, never as failed (Arc can drop receipts). */
async function run(label: string, action: () => Promise<Hex | void>, tagged = true): Promise<boolean> {
  const tag = () => (tagged ? vaultTag() : "");
  if (busy) return false;
  busy = true;
  setControls();
  try {
    status(`${label}${tag()}: confirm in your wallet...`);
    const hash = await action();
    if (hash && pub) {
      status(`${label}${tag()}: sent ${hash}. Waiting for it to confirm...`);
      let receipt;
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      } catch {
        status(`${label}${tag()}: no receipt yet, so the outcome is unknown, not failed. Check the transaction ${hash}${explorerTx(chainId, hash) ? ` at ${explorerTx(chainId, hash)}` : ""} before sending anything again.`, true);
        return false;
      }
      if (receipt.status !== "success") {
        status(`${label}${tag()}: the transaction reverted (${hash}).`, true);
        return false;
      }
      status(`${label}${tag()}: confirmed in block ${receipt.blockNumber}.`);
    } else {
      status(`${label}${tag()}: done.`);
    }
    return true;
  } catch (error) {
    status(`${label}${tag()}: ${errorText(error)}`, true);
    return false;
  } finally {
    busy = false;
    await refresh().catch(() => undefined);
    setControls();
  }
}

async function loadArtifactV2(): Promise<Artifact> {
  if (artifactV2) return artifactV2;
  const response = await fetch("/vault-artifact-v2.json");
  if (!response.ok) throw new Error("vault-artifact-v2.json is missing. Run `npm run prepare-artifact` (it needs Foundry).");
  artifactV2 = (await response.json()) as Artifact;
  return artifactV2;
}

async function loadArtifact(): Promise<Artifact> {
  if (artifact) return artifact;
  const response = await fetch(`${import.meta.env.BASE_URL}vault-artifact.json`);
  if (!response.ok) throw new Error("vault-artifact.json is missing. Run `npm run prepare-artifact` (it needs Foundry).");
  artifact = (await response.json()) as Artifact;
  return artifact;
}

async function connect(): Promise<void> {
  if (!window.ethereum) return status("No wallet found. Install a browser wallet and reload.", true);
  try {
    const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
    const first = accounts[0];
    if (!first || !isAddress(first, { strict: false })) return status("The wallet returned no account.", true);
    account = getAddress(first);
    chainId = Number(BigInt((await window.ethereum.request({ method: "eth_chainId" })) as string));
  } catch (error) {
    return status(errorText(error), true);
  }
  const chain = chainFor(chainId);
  pub = createPublicClient({ chain, transport: custom(readProvider(window.ethereum)) });
  wallet = createWalletClient({ account, chain, transport: custom(window.ethereum) });
  setText("account", account);
  setText("chain", chainId === ARC_TESTNET_ID ? "Arc Testnet" : `Chain ${chainId}: not Arc Testnet. Rehearsal only; set the token address yourself.`);
  $("switch-arc").hidden = chainId === ARC_TESTNET_ID;
  $("s-vault").hidden = false;
  const token = $<HTMLInputElement>("token-input");
  token.value = chainId === ARC_TESTNET_ID ? ARC_USDC : token.value;
  token.readOnly = chainId === ARC_TESTNET_ID;
  setText("token-note", chainId === ARC_TESTNET_ID ? "Arc's USDC ERC-20 interface. The same balance is your native gas balance, shown with 18 decimals instead of 6." : "Not Arc Testnet. Paste the 6-decimal test token for this chain.");
  status("Wallet connected.");
  renderBanner();
  renderRecent();
  setControls();
  if (linkedVault) {
    const address = linkedVault;
    linkedVault = undefined;
    await openVault(address, true);
  }
}

async function switchToArc(): Promise<void> {
  if (!window.ethereum) return;
  const hexId = `0x${ARC_TESTNET_ID.toString(16)}`;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) return status(errorText(error), true);
    try {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: arcTestnet.name,
          nativeCurrency: arcTestnet.nativeCurrency,
          rpcUrls: arcTestnet.rpcUrls.default.http,
          blockExplorerUrls: [arcTestnet.blockExplorers.default.url],
        }],
      });
    } catch (addError) {
      return status(errorText(addError), true);
    }
  }
  await connect();
}

function tokenAddress(): Address | undefined {
  const value = $<HTMLInputElement>("token-input").value.trim();
  return isAddress(value, { strict: false }) ? getAddress(value) : undefined;
}

/** The page handles 6-decimal USDC only. Anything else would make every amount on it wrong. */
async function checkToken(token: Address): Promise<string | undefined> {
  if (!pub) return "Connect a wallet first.";
  const code = await pub.getCode({ address: token });
  if (!code || code === "0x") return "There is no contract at the token address on this chain.";
  try {
    const decimals = await pub.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    if (decimals !== TOKEN_DECIMALS) return `That token has ${decimals} decimals. This page handles 6-decimal USDC only.`;
  } catch {
    return "That address did not answer like an ERC-20 token.";
  }
  return undefined;
}

/** Step one: say what deploying does, and warn loudly if a vault is already known. Nothing is sent yet. */
async function reviewDeploy(): Promise<void> {
  const token = tokenAddress();
  if (!token || !wallet || !pub || !account) return status("Enter the USDC token address first.", true);
  const problem = await checkToken(token);
  if (problem) return status(problem, true);
  const known = [...new Set([...(vault ? [vault] : []), ...recents()])];
  setText(
    "deploy-confirm-text",
    known.length
      ? `You already have a vault: ${known.join(", ")}. This creates a SECOND, separate vault with a new address. Money and settings in your existing vault do not move to it, and nothing you set up there applies to the new one. Most people should cancel and connect to the vault they have.`
      : `This creates a new vault owned by ${account}, with token ${token}. If your team already has a vault, cancel and connect to it instead: a new vault starts empty and unconfigured.`,
  );
  $("deploy-confirm").hidden = false;
  status("Check what deploying does, then confirm or cancel.");
}

async function deploy(): Promise<void> {
  $("deploy-confirm").hidden = true;
  const token = tokenAddress();
  if (!token || !wallet || !pub || !account) return status("Enter the USDC token address first.", true);
  const problem = await checkToken(token);
  if (problem) return status(problem, true);
  const built = await loadArtifact().catch((e) => void status(errorText(e), true));
  if (!built) return;
  let deployedAt: Address | undefined;
  const ok = await run("Deploy vault", async () => {
    const hash = await wallet!.deployContract({ abi: built.abi, bytecode: built.bytecode, args: [account, token], account: account!, chain: wallet!.chain });
    const receipt = await pub!.waitForTransactionReceipt({ hash, timeout: 90_000 });
    deployedAt = receipt.contractAddress ?? undefined;
    if (deployedAt) remember(`vault-setup:created:${chainId}:${deployedAt.toLowerCase()}`, receipt.blockNumber.toString());
    setText("deploy-note", `Deploy transaction ${hash}, block ${receipt.blockNumber}. Keep these for your records.`);
  }, false);
  if (ok && deployedAt) await openVault(deployedAt);
}

// ---- Approving from alerts, with no config file ----

/** The relay this build was made for. A copy of the page built without one cannot set up approvals. */
const BUILT_IN_RELAY: string | undefined = (() => {
  const raw = import.meta.env.VITE_RELAY_URL;
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
})();
const TRUST_PREFIX = "vault-trust/";
const trustKeyFor = (chain: number, address: Address) => `${TRUST_PREFIX}${chain}/${address.toLowerCase()}`;

/** Vaults this browser has been told to trust for approvals. The approval page, on the same site, reads these. */
function trustedVaults(): string[] {
  const found: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(TRUST_PREFIX)) continue;
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "");
        const vaultField = (parsed as { vault?: unknown })?.vault;
        if (typeof vaultField === "string" && isAddress(vaultField, { strict: false })) found.push(getAddress(vaultField));
      } catch {
        /* a damaged record counts as none */
      }
    }
  } catch {
    /* storage can be blocked */
  }
  return found;
}

function isTrustedHere(address: Address): boolean {
  return trustedVaults().includes(address);
}

/** Writes the record the approval page reads, then reads it back, since storage can silently refuse. */
function trustForApprovals(address: Address): boolean {
  if (!BUILT_IN_RELAY) return false;
  const key = trustKeyFor(chainId, address);
  remember(key, JSON.stringify({ chainId: String(chainId), vault: address, relay: BUILT_IN_RELAY }));
  return isTrustedHere(address);
}

function forgetForApprovals(address: Address): void {
  try {
    localStorage.removeItem(trustKeyFor(chainId, address));
  } catch {
    /* nothing to undo if storage is blocked */
  }
}

/**
 * Says what will happen when an alert arrives, and sets this browser up for it when it is safe to. It is safe
 * only for a vault the connected wallet owns and whose code matches the build: a look-alike contract can report
 * any owner it likes, so ownership alone is not enough.
 */
function renderApprovals(setUp: boolean): void {
  if (!vault || !account) return;
  const text = (message: string) => setText("approvals-state", message);
  const show = (id: string, visible: boolean) => void ($(id).hidden = !visible);
  const owns = vaultOwner !== undefined && vaultOwner === account;
  let ready = false;
  show("approvals-use", false);
  show("approvals-forget", false);

  if (!BUILT_IN_RELAY) {
    text("This copy of the page is not connected to an alert relay, so an alert cannot reach the approval page by itself. To approve here, download the config in section 4 and load it, with the request file, in the approval page. The hosted copy of this page is connected, and sets approvals up without a file.");
  } else if (!owns) {
    text("You are not this vault's owner, so approvals are not set up from here. Connect the owner's wallet to set them up.");
  } else if (codeMatches !== true) {
    text(codeMatches === false
      ? "This vault's code does not match the build this page knows, so this page will not set up approvals for it. A look-alike contract can claim any owner. Ask someone you trust to review the vault first."
      : "This page could not compare this vault's code with its build, so it will not set up approvals for it.");
  } else if (isTrustedHere(vault)) {
    ready = true;
  } else if (setUp && trustForApprovals(vault)) {
    ready = true;
  } else if (setUp) {
    text("This browser would not save the setting (storage may be blocked). Alerts will still work: the approval page asks you to confirm this vault once, with your owner wallet.");
  } else {
    text("Approvals are not set up for this vault in this browser. Alerts will still work: the approval page asks you to confirm the vault once, with your owner wallet.");
    show("approvals-use", true);
  }

  if (ready) {
    text(`Ready in this browser. The approval page trusts vault ${vault} and sends your signature only to ${BUILT_IN_RELAY}.`);
    show("approvals-forget", true);
  }
  show("approvals-steps", ready);
  show("approvals-note", ready);
  const trusted = trustedVaults();
  setText(
    "approvals-trusted",
    BUILT_IN_RELAY
      ? trusted.length
        ? `This browser trusts ${trusted.length === 1 ? "this vault" : `${trusted.length} vaults`} for approvals: ${trusted.join(", ")}. An alert for any other vault always asks you first.`
        : "This browser trusts no vault for approvals yet."
      : "",
  );
}

async function openVault(address: Address, fromLink = false): Promise<void> {
  if (!pub || !account) return;
  try {
    const code = await pub.getCode({ address });
    if (!code || code === "0x") return status("There is no contract at that address on this chain.", true);
    const [owner, token] = await Promise.all([
      pub.readContract({ address, abi: vaultAbi, functionName: "owner" }),
      pub.readContract({ address, abi: vaultAbi, functionName: "token" }),
    ]);
    const problem = await checkToken(token);
    if (problem) return status(`The vault's token: ${problem}`, true);
    let version: 1 | 2 = 1;
    try {
      if ((await pub.readContract({ address, abi: vaultV2Abi, functionName: "contractVersion" })) === 2n) version = 2;
    } catch {
      /* a version 1 vault has no such function */
    }
    resetForVault();
    vaultVersion = version;
    document.body.dataset.version = String(version);
    vault = address;
    vaultOwner = getAddress(owner);
    vaultToken = token;
    $<HTMLInputElement>("token-input").value = token;
    addRecent(address);
    renderRecent();
    const built = await (version === 2 ? loadArtifactV2() : loadArtifact()).catch(() => undefined);
    codeMatches = built ? matchesBuild(code, built) : undefined;
    if (version === 2) {
      const hash = keccak256(code);
      const pinned = KNOWN_CODE_HASHES[`${chainId}:${address.toLowerCase()}`];
      if (pinned && hash !== pinned) codeMatches = false;
      setText(
        "v2-code",
        `${built ? (matchesBuild(code, built) ? "Matches this repository's build (owner and token addresses and the compiler's metadata trailer ignored). " : "DIFFERS from this repository's version 2 build. ") : "Build not compared: artifact missing. "}Code hash ${hash}${pinned ? (hash === pinned ? ", the pinned hash for this vault." : `, which is NOT the pinned hash ${pinned}. Do not fund this vault.`) : ", with no pinned hash for this vault."}`,
      );
    }
    setText(
      "v-code",
      !built
        ? "Not compared: build artifact missing."
        : codeMatches
          ? "Matches this repository's compiled vault (owner and token addresses and the compiler's metadata trailer ignored)."
          : "DIFFERS from this repository's compiled vault. Do not fund it until someone has reviewed that code.",
    );
    $("dashboard").hidden = false;
    setText("v-owner", owner);
    $<HTMLInputElement>("withdraw-to").value = account;
    setText("vault-summary", `Connected: ${address}`);
    setText("link-note", fromLink ? `Opened from the vault in this page's address. Check that ${address} is the vault you mean before changing anything.` : "");
    $<HTMLDetailsElement>("chooser").open = false;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("vault", address);
      window.history.replaceState(null, "", url);
    } catch {
      /* the address bar is a convenience only */
    }
    renderBanner();
    if (version === 1) renderApprovals(true);
    await refresh();
    status(getAddress(owner) === account ? `Vault ${address} connected.` : `Vault ${address} connected, but you are not its owner. Changes are disabled.`);
  } catch (error) {
    status(`Could not read that vault: ${errorText(error)}`, true);
  }
}

async function refresh(): Promise<void> {
  if (vaultVersion === 2) return v2.refresh();
  if (!pub || !vault || !account) return;
  const mine = vault;
  const read = <T extends (typeof vaultAbi)[number]["name"]>(functionName: T, args?: unknown[]) =>
    pub!.readContract({ address: vault!, abi: vaultAbi, functionName, args } as never) as Promise<never>;
  const [owner, token, agent, version, per, daily, until, paused] = (await Promise.all([
    read("owner"), read("token"), read("agent"), read("policyVersion"), read("perPaymentLimit"), read("dailyLimit"), read("policyValidUntil"), read("paused"),
  ])) as [Address, Address, Address, bigint, bigint, bigint, bigint, boolean];
  const balanceOf = (who: Address) => pub!.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const hasAgent = agent !== zeroAddress;
  const [vaultTokens, ownerTokens, agentTokens, agentNative] = await Promise.all([
    balanceOf(vault),
    balanceOf(account),
    hasAgent ? balanceOf(agent) : Promise.resolve(0n),
    hasAgent ? pub.getBalance({ address: agent }) : Promise.resolve(0n),
  ]);
  // The owner may have switched vaults while these reads were in flight. Draw nothing from a stale answer.
  if (vault !== mine) return;
  balances = { vault: vaultTokens, owner: ownerTokens };
  vaultOwner = getAddress(owner);
  renderBanner();
  const isOwner = vaultOwner === account;
  const sameMoney = chainId === ARC_TESTNET_ID;

  setText("v-address", vault);
  setText("v-owner", owner);
  setText("v-version", version.toString());
  setText("v-agent", hasAgent ? agent : "not set");
  setText("v-per", `${formatUsdc(per)} USDC`);
  setText("v-daily", `${formatUsdc(daily)} USDC`);
  setText("v-valid", until === 0n ? "never set" : `${new Date(Number(until) * 1000).toISOString()} (${until} seconds since 1970)`);
  setText("v-paused", paused ? "PAUSED: the agent cannot pay" : "Active");
  setText("v-balance", `${formatUsdc(vaultTokens)} USDC`);
  setText("o-balance", `${formatUsdc(ownerTokens)} USDC`);
  setText("a-tokens", hasAgent ? `${formatUsdc(agentTokens)} USDC (ERC-20 view)` : "no agent set");
  setText("a-native", hasAgent ? `${formatNative(agentNative)} native (18 decimals)` : "no agent set");
  setText("same-money", sameMoney ? "On Arc the ERC-20 and native figures are the same money at two scales: 6 decimals and 18 decimals. Gas is paid from it." : "Rehearsal chain: the token and the native coin are different assets here.");
  $("not-owner").hidden = isOwner;
  setText("toggle-pause", paused ? "Unpause" : "Pause");
  const next = `${version + 1n}`;
  const warning = `Saving moves the policy from version ${version} to ${next}. Every approval you have signed but the agent has not yet used becomes invalid, and the agent must ask again. Spending already counted today is not reset.`;
  setText("policy-warning", warning);
  setText("vendor-warning", `Allowing or removing a vendor also moves the policy to version ${next} and invalidates unused approvals.`);
  $("code-warning").hidden = codeMatches !== false;
  $("unlock-funding").hidden = codeMatches !== false || fundingUnlocked;
  const agentInput = $<HTMLInputElement>("policy-agent");
  if (!agentInput.value && hasAgent) agentInput.value = agent;

  const checks = assessProtection({ owner, agent, vaultTokens, agentTokens, agentNative, sameMoney, paused });
  const list = $("checks");
  list.replaceChildren(
    ...checks.map((c) => {
      const li = document.createElement("li");
      const tag = document.createElement("span");
      tag.className = `tag ${c.state}`;
      tag.textContent = c.state === "ok" ? "OK" : c.state === "warn" ? "FIX" : "TO DO";
      li.append(tag, document.createTextNode(c.text));
      return li;
    }),
  );
  setText("verdict", isProtected(checks) ? "All checks pass. These checks say the setup is sound; they do not say the contract has been audited." : "Not yet: work through the items above.");

  const sweep = $("agent-sweep");
  const excess = agentTokens > 500_000n ? agentTokens - 500_000n : 0n;
  sweep.hidden = !excess;
  if (excess) sweep.textContent = `The agent's address holds ${formatUsdc(agentTokens)} USDC. This page cannot move it, because it never holds the agent's key. From the agent's own wallet, send at least ${formatUsdc(excess)} USDC to the vault address ${vault} using the token's transfer, or to your own address first.`;

  setText("fund-note", `You hold ${formatUsdc(ownerTokens)} USDC.${sameMoney ? ` Keep about ${formatUsdc(OWNER_RESERVE)} for your own gas.` : ""}`);
  await listVendors(isOwner);
  setControls(isOwner);
}

let ownerFlag = false;
function setControls(isOwner = ownerFlag): void {
  ownerFlag = isOwner;
  const off = busy || !isOwner;
  const fundBlocked = codeMatches === false && !fundingUnlocked;
  for (const id of ["save-policy", "add-vendor", "toggle-pause", "withdraw", "withdraw-confirm", "v2-cap-save", "v2-agent-save", "v2-agent-off", "v2-agent-clear", "v2-approver-add", "v2-confirm-yes", "v2-confirm-no"]) $<HTMLButtonElement>(id).disabled = off;
  for (const button of document.querySelectorAll<HTMLButtonElement>("#v2-agent-list button, #v2-approver-list button")) button.disabled = off;
  for (const id of ["fund", "fund-confirm", "fund-max"]) $<HTMLButtonElement>(id).disabled = off || fundBlocked;
  for (const id of ["deploy", "deploy-yes", "load-vault"]) $<HTMLButtonElement>(id).disabled = busy || !account;
  for (const button of document.querySelectorAll<HTMLButtonElement>("#vendors button, #recent button")) button.disabled = button.closest("#recent") ? busy : off;
}

/**
 * Pages read when the vault's creation block cannot be found: 12 pages is roughly the last 120,000 blocks.
 * A build can lower it with VITE_LOG_FALLBACK_PAGES, which the browser test does so it does not have to mine
 * 120,000 blocks to leave a vendor outside the window. A bad value falls back to 12.
 */
const FALLBACK_PAGES = (() => {
  const raw = Number(import.meta.env.VITE_LOG_FALLBACK_PAGES ?? 12);
  return Number.isInteger(raw) && raw >= 1 && raw <= 400 ? raw : 12;
})();

/**
 * The block the vault was created in: remembered, else a hint checked on-chain (the page's address ?created=
 * or a known vault), else found by searching old state. Undefined if the RPC cannot say.
 */
async function creationBlock(address: Address, head: bigint): Promise<bigint | undefined> {
  const key = `vault-setup:created:${chainId}:${address.toLowerCase()}`;
  const saved = remembered(key);
  if (saved && /^[0-9]+$/.test(saved) && BigInt(saved) <= head) return BigInt(saved);
  const hasCode = async (block: bigint) => {
    const code = await pub!.getCode({ address, blockNumber: block });
    return !!code && code !== "0x";
  };
  try {
    const hints: bigint[] = [];
    const known = KNOWN_CREATION_BLOCKS[`${chainId}:${address.toLowerCase()}`];
    if (known !== undefined) hints.push(known);
    const param = new URLSearchParams(window.location.search).get("created");
    if (param && /^[0-9]{1,12}$/.test(param)) hints.push(BigInt(param));
    for (const hint of hints) {
      if (hint > head) continue;
      const verified = await verifyCreationBlock(hasCode, hint);
      if (verified !== undefined) {
        remember(key, verified.toString());
        return verified;
      }
    }
    const found = await findFirstBlockWithCode(hasCode, head);
    if (found !== undefined) remember(key, found.toString());
    return found;
  } catch {
    return undefined;
  }
}

async function listVendors(isOwner: boolean): Promise<void> {
  if (!pub || !vault) return;
  const mine = vault;
  const list = $("vendors");
  const names = labels();
  let candidates: Address[] = [];
  try {
    const event = vaultAbi.find((x) => x.type === "event" && x.name === "RecipientSet");
    // viem caches the block number for a few seconds, which would hide a vendor allowed a moment ago.
    const head = await pub.getBlockNumber({ cacheTime: 0 });
    const fetchRange = async (fromBlock: bigint, toBlock: bigint) =>
      (await pub!.getLogs({ address: mine, event: event as never, fromBlock, toBlock })) as unknown as { args: { recipient: Address } }[];
    const previous = vendorScan?.vault === mine ? vendorScan : undefined;
    if (previous) {
      // Already read everything up to `scannedTo`: read only what is new.
      const fresh = await pageLogs(fetchRange, previous.scannedTo + 1n, head, { retry: false });
      if (fresh.complete) {
        for (const log of fresh.items) previous.seen.add(getAddress(log.args.recipient));
        previous.scannedTo = head;
        candidates = [...previous.seen];
        if (vault !== mine) return;
        setText("vendors-note", candidates.length ? "" : "No vendors yet. Payments to any other address are refused.");
      } else {
        vendorScan = undefined; // something went wrong: next refresh starts over
        throw new Error(fresh.reason ?? "the RPC stopped answering");
      }
    } else {
      setText("vendors-note", "Looking up your vendors...");
      const created = await creationBlock(mine, head);
      const start = created ?? (head >= MAX_LOG_RANGE * BigInt(FALLBACK_PAGES) ? head - MAX_LOG_RANGE * BigInt(FALLBACK_PAGES) + 1n : 0n);
      const result = await pageLogs(fetchRange, start, head, { maxPages: created === undefined ? FALLBACK_PAGES : 400, retry: false });
      if (vault !== mine) return; // the owner switched vaults while this was loading
      const seen = new Set<Address>();
      for (const log of result.items) seen.add(getAddress(log.args.recipient));
      candidates = [...seen];
      if (result.complete && created !== undefined) {
        vendorScan = { vault: mine, seen, scannedTo: head };
        setText("vendors-note", candidates.length ? "" : "No vendors yet. Payments to any other address are refused.");
      } else {
        const scope = created === undefined ? `the most recent blocks, from ${result.scannedFrom}, because this RPC could not say when the vault was created` : `block ${result.scannedFrom} to ${head}`;
        setText(
          "vendors-note",
          `Partial list: this page read ${scope}${result.reason ? `, then ${result.reason}` : ""}. A vendor allowed earlier may be missing. Use Check address to look one up.`,
        );
      }
    }
  } catch (error) {
    setText("vendors-note", `Could not list vendors (${errorText(error).slice(0, 120)}). Use Check address to look one up.`);
  }
  const allowed = await Promise.all(candidates.map((a) => pub!.readContract({ address: vault!, abi: vaultAbi, functionName: "allowedRecipient", args: [a] })));
  const items = candidates.filter((_, i) => allowed[i]).map((address) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.className = "mono";
    text.textContent = `${names[address.toLowerCase()] ? `${names[address.toLowerCase()]}: ` : ""}${address}`;
    const remove = document.createElement("button");
    remove.className = "secondary remove";
    remove.textContent = "Remove";
    remove.disabled = !isOwner;
    remove.addEventListener("click", () => void setVendor(address, false));
    li.append(text, remove);
    return li;
  });
  list.replaceChildren(...items);
}

function readAddress(id: string, what: string): Address | undefined {
  const value = $<HTMLInputElement>(id).value.trim();
  if (!isAddress(value, { strict: false })) {
    status(`${what} must be an address.`, true);
    return undefined;
  }
  return getAddress(value);
}

async function setVendor(address: Address, allowed: boolean): Promise<void> {
  if (!wallet || !vault || !account) return;
  if (allowed) {
    const label = $<HTMLInputElement>("vendor-label").value.trim();
    if (label) remember(labelsKey(), JSON.stringify({ ...labels(), [address.toLowerCase()]: label }));
  }
  await run(allowed ? "Allow vendor" : "Remove vendor", () =>
    wallet!.writeContract({ address: vault!, abi: vaultAbi, functionName: "setRecipient", args: [address, allowed], account: account!, chain: wallet!.chain }),
  );
}

async function savePolicy(): Promise<void> {
  if (!wallet || !vault || !account) return;
  const agent = readAddress("policy-agent", "The agent address");
  if (!agent) return;
  if (agent === account) return status("The agent address cannot be your own address. The agent would hold your owner key and nothing could stop it.", true);
  if (agent === zeroAddress) return status("The agent address cannot be zero.", true);
  let per: bigint, daily: bigint;
  try {
    per = parseUsdc($<HTMLInputElement>("policy-per").value);
    daily = parseUsdc($<HTMLInputElement>("policy-daily").value);
  } catch (error) {
    return status(error instanceof AmountError ? error.message : errorText(error), true);
  }
  if (per === 0n || daily === 0n) return status("Limits must be above zero.", true);
  if (per > daily) return status("The per-payment limit is above the daily limit, so the daily limit would always bind first. Lower the per-payment limit.", true);
  const days = $<HTMLInputElement>("policy-days").value.trim();
  if (!/^[1-9][0-9]{0,3}$/.test(days)) return status("Days must be a whole number from 1 to 9999.", true);
  const block = await pub!.getBlock();
  const validUntil = block.timestamp + BigInt(days) * 86_400n;
  await run("Save limits", () =>
    wallet!.writeContract({ address: vault!, abi: vaultAbi, functionName: "configurePolicy", args: [agent, per, daily, validUntil], account: account!, chain: wallet!.chain }),
  );
}

/** Step one: show exactly where the money goes. Nothing is sent yet. */
function reviewFund(): void {
  if (!vault || !account) return;
  let amount: bigint;
  try {
    amount = parseUsdc($<HTMLInputElement>("fund-amount").value);
  } catch (error) {
    return status(error instanceof AmountError ? error.message : errorText(error), true);
  }
  if (amount === 0n) return status("Enter an amount above zero.", true);
  if (amount > balances.owner) return status(`You hold only ${formatUsdc(balances.owner)} USDC.`, true);
  pendingFund = { amount };
  setText("fund-review", `Move ${formatUsdc(amount)} USDC from your wallet ${account} into vault ${vault}. That vault holds ${formatUsdc(balances.vault)} USDC now. Check the vault address matches the one in the banner at the top.`);
  $("fund-review").hidden = false;
  $("fund-confirm").hidden = false;
  status("Check where the money goes, then confirm.");
}

async function fund(): Promise<void> {
  const pending = pendingFund;
  if (!pending || !wallet || !vault || !vaultToken || !account) return;
  const token = vaultToken;
  pendingFund = undefined;
  $("fund-review").hidden = true;
  $("fund-confirm").hidden = true;
  await run(`Move ${formatUsdc(pending.amount)} USDC into the vault`, () =>
    wallet!.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [vault!, pending.amount], account: account!, chain: wallet!.chain }),
  );
}

function reviewWithdrawal(): void {
  const to = readAddress("withdraw-to", "The destination");
  if (!to) return;
  let amount: bigint;
  try {
    amount = parseUsdc($<HTMLInputElement>("withdraw-amount").value);
  } catch (error) {
    return status(error instanceof AmountError ? error.message : errorText(error), true);
  }
  if (amount === 0n || amount > balances.vault) return status(`Enter an amount between 0 and ${formatUsdc(balances.vault)} USDC.`, true);
  pendingWithdrawal = { to, amount };
  setText("withdraw-review", `Withdraw ${formatUsdc(amount)} USDC from vault ${vault} to ${to}. After this the vault protects ${formatUsdc(balances.vault - amount)} USDC.`);
  $("withdraw-review").hidden = false;
  $("withdraw-confirm").hidden = false;
  status("Check the withdrawal, then confirm.");
}

async function confirmWithdrawal(): Promise<void> {
  const w = pendingWithdrawal;
  if (!w || !wallet || !vault || !account) return;
  pendingWithdrawal = undefined;
  $("withdraw-review").hidden = true;
  $("withdraw-confirm").hidden = true;
  await run(`Withdraw ${formatUsdc(w.amount)} USDC`, () =>
    wallet!.writeContract({ address: vault!, abi: vaultAbi, functionName: "withdraw", args: [w.to, w.amount], account: account!, chain: wallet!.chain }),
  );
}

async function exportConfig(): Promise<void> {
  if (!pub || !vault || !account) return;
  const token = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "token" });
  const names = labels();
  const vendors: Record<string, string> = {};
  for (const item of document.querySelectorAll("#vendors li span")) {
    const address = item.textContent?.split(": ").pop() ?? "";
    if (isAddress(address, { strict: false })) vendors[getAddress(address)] = names[address.toLowerCase()] ?? "Unlabelled vendor";
  }
  const relayText = $<HTMLInputElement>("relay-url").value.trim();
  let relay: string | undefined;
  if (relayText) {
    try {
      const url = new URL(relayText);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
      relay = url.origin;
    } catch {
      return status("The relay address must be an http or https URL, like https://relay.example.", true);
    }
  }
  const config = { chainId: String(chainId), vault, owner: account, token, ...(relay ? { relay } : {}), vendors };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
  link.download = "owner-config.json";
  link.click();
  URL.revokeObjectURL(link.href);
  status("Saved owner-config.json. Keep it outside the repository and load it in the approval page.");
}

$("connect").addEventListener("click", () => void connect());
$("switch-arc").addEventListener("click", () => void switchToArc());
$("deploy").addEventListener("click", () => void reviewDeploy());
$("deploy-yes").addEventListener("click", () => void deploy());
$("deploy-no").addEventListener("click", () => {
  $("deploy-confirm").hidden = true;
  status("Deploy cancelled. Nothing was sent.");
});
$("load-vault").addEventListener("click", () => {
  const address = readAddress("vault-input", "The vault address");
  if (address) void openVault(address);
});
$("save-policy").addEventListener("click", () => void savePolicy());
$("add-vendor").addEventListener("click", () => {
  const address = readAddress("vendor-address", "The vendor address");
  if (address && address !== zeroAddress) void setVendor(address, true);
});
$("check-vendor").addEventListener("click", async () => {
  const address = readAddress("vendor-address", "The vendor address");
  if (!address || !pub || !vault) return;
  const allowed = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "allowedRecipient", args: [address] });
  status(allowed ? `${address} is allowed.` : `${address} is not allowed.`);
});
$("export-config").addEventListener("click", () => void exportConfig());
$("fund").addEventListener("click", reviewFund);
$("fund-confirm").addEventListener("click", () => void fund());
$("unlock-funding").addEventListener("click", () => {
  fundingUnlocked = true;
  $("code-warning").hidden = true;
  $("unlock-funding").hidden = true;
  setControls();
  status("Funding unlocked for this vault. It stays unlocked only until you switch vaults or reload.");
});
$("fund-max").addEventListener("click", () => {
  const reserve = chainId === ARC_TESTNET_ID ? OWNER_RESERVE : 0n;
  if (balances.owner <= reserve) return status("Nothing to move after keeping your gas reserve.", true);
  $<HTMLInputElement>("fund-amount").value = formatUsdc(balances.owner - reserve);
});
$("toggle-pause").addEventListener("click", async () => {
  if (!wallet || !vault || !account || !pub) return;
  const paused = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "paused" });
  void run(paused ? "Unpause" : "Pause", () =>
    wallet!.writeContract({ address: vault!, abi: vaultAbi, functionName: paused ? "unpause" : "pause", account: account!, chain: wallet!.chain }),
  );
});
$("withdraw").addEventListener("click", reviewWithdrawal);
$("withdraw-all").addEventListener("click", () => void ($<HTMLInputElement>("withdraw-amount").value = formatUsdc(balances.vault)));
$("withdraw-confirm").addEventListener("click", () => void confirmWithdrawal());
$("approvals-use").addEventListener("click", () => {
  renderApprovals(true);
  status("Approvals are set up for this vault in this browser.");
});
$("approvals-forget").addEventListener("click", () => {
  if (!vault) return;
  forgetForApprovals(vault);
  renderApprovals(false);
  status("This browser no longer trusts this vault for approvals. An alert will ask you to confirm it again.");
});

// Changing account or chain invalidates everything on screen, so start over rather than guess.
window.ethereum?.on?.("accountsChanged", () => location.reload());
window.ethereum?.on?.("chainChanged", () => location.reload());

// A vault named in the page's address is opened after the wallet connects, never before.
{
  const param = new URLSearchParams(window.location.search).get("vault");
  if (param) {
    if (isAddress(param, { strict: false })) linkedVault = getAddress(param);
    else status("The vault in this page's address is not a valid address, so it was ignored.", true);
  }
}
renderBanner();

const v2 = initV2({
  pub: () => pub,
  wallet: () => wallet,
  account: () => account,
  vault: () => vault,
  isOwner: () => vaultOwner !== undefined && vaultOwner === account,
  busy: () => busy,
  status,
  run: (label, action) => run(label, action),
  creationBlock,
  labels,
  setVendor: (address, allowed) => setVendor(address, allowed),
  shared: ({ vaultTokens, ownerTokens, token, owner, paused }) => {
    balances = { vault: vaultTokens, owner: ownerTokens };
    vaultToken = token;
    vaultOwner = owner;
    renderBanner();
    setText("toggle-pause", paused ? "Unpause" : "Pause");
    setControls(vaultOwner === account);
  },
  setControls: () => setControls(),
});

