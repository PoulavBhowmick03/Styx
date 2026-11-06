import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import { erc20Abi, vaultAbi } from "./abi";
import { AmountError, formatNative, formatUsdc, parseUsdc, TOKEN_DECIMALS } from "./amounts";
import { matchesBuild, type Artifact } from "./build";
import { ARC_TESTNET_ID, ARC_USDC, arcTestnet, chainFor, explorerTx } from "./chains";
import { assessProtection, isProtected } from "./protection";

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

let account: Address | undefined;
let chainId = 0;
let pub: PublicClient | undefined;
let wallet: WalletClient | undefined;
let vault: Address | undefined;
let artifact: Artifact | undefined;
let busy = false;
let pendingWithdrawal: { to: Address; amount: bigint } | undefined;
let balances = { vault: 0n, owner: 0n };

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

function errorText(error: unknown): string {
  // viem wraps wallet errors several levels deep, so walk the whole cause chain for a rejection.
  for (let e = error as { code?: number; name?: string; cause?: unknown } | undefined, depth = 0; e && depth < 8; e = e.cause as typeof e, depth++) {
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return "You rejected the request in your wallet. Nothing was sent.";
  }
  const e = error as { shortMessage?: string; message?: string };
  return e?.shortMessage ?? e?.message ?? "Something went wrong.";
}

/** One action at a time. Reports a missing receipt as unknown, never as failed (Arc can drop receipts). */
async function run(label: string, action: () => Promise<Hex | void>): Promise<boolean> {
  if (busy) return false;
  busy = true;
  setControls();
  try {
    status(`${label}: confirm in your wallet...`);
    const hash = await action();
    if (hash && pub) {
      status(`${label}: sent ${hash}. Waiting for it to confirm...`);
      let receipt;
      try {
        receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
      } catch {
        status(`${label}: no receipt yet, so the outcome is unknown, not failed. Check the transaction ${hash}${explorerTx(chainId, hash) ? ` at ${explorerTx(chainId, hash)}` : ""} before sending anything again.`, true);
        return false;
      }
      if (receipt.status !== "success") {
        status(`${label}: the transaction reverted (${hash}).`, true);
        return false;
      }
      status(`${label}: confirmed in block ${receipt.blockNumber}.`);
    } else {
      status(`${label}: done.`);
    }
    return true;
  } catch (error) {
    status(`${label}: ${errorText(error)}`, true);
    return false;
  } finally {
    busy = false;
    await refresh().catch(() => undefined);
    setControls();
  }
}

async function loadArtifact(): Promise<Artifact> {
  if (artifact) return artifact;
  const response = await fetch("/vault-artifact.json");
  if (!response.ok) throw new Error("vault-artifact.json is missing. Run `npm run prepare-artifact` after `forge build`.");
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
  pub = createPublicClient({ chain, transport: custom(window.ethereum) });
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
  const last = remembered(lastVaultKey());
  if (last && isAddress(last, { strict: false })) {
    $<HTMLInputElement>("vault-input").value = last;
  }
  setControls();
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

async function deploy(): Promise<void> {
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
    setText("deploy-note", `Deploy transaction ${hash}, block ${receipt.blockNumber}. Keep these for your records.`);
  });
  if (ok && deployedAt) await openVault(deployedAt);
}

async function openVault(address: Address): Promise<void> {
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
    vault = address;
    $<HTMLInputElement>("token-input").value = token;
    remember(lastVaultKey(), address);
    const built = await loadArtifact().catch(() => undefined);
    setText(
      "v-code",
      !built
        ? "Not compared: build artifact missing."
        : matchesBuild(code, built)
          ? "Matches this repository's compiled vault (owner and token addresses ignored)."
          : "DIFFERS from this repository's compiled vault. Do not fund it until someone has reviewed that code.",
    );
    $("dashboard").hidden = false;
    setText("v-owner", owner);
    $<HTMLInputElement>("withdraw-to").value = account;
    await refresh();
    status(getAddress(owner) === account ? "Vault connected." : "Vault connected, but you are not its owner. Changes are disabled.");
  } catch (error) {
    status(`Could not read that vault: ${errorText(error)}`, true);
  }
}

async function refresh(): Promise<void> {
  if (!pub || !vault || !account) return;
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
  balances = { vault: vaultTokens, owner: ownerTokens };
  const isOwner = getAddress(owner) === account;
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
  for (const id of ["save-policy", "add-vendor", "fund", "toggle-pause", "withdraw", "withdraw-confirm", "deploy"]) {
    $<HTMLButtonElement>(id).disabled = id === "deploy" ? busy || !account : off;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("#vendors button")) button.disabled = off;
}

async function listVendors(isOwner: boolean): Promise<void> {
  if (!pub || !vault) return;
  const list = $("vendors");
  const names = labels();
  let candidates: Address[] = [];
  try {
    const logs = await pub.getLogs({ address: vault, event: vaultAbi.find((x) => x.type === "event" && x.name === "RecipientSet") as never, fromBlock: "earliest", toBlock: "latest" });
    const seen = new Set<Address>();
    for (const log of logs as unknown as { args: { recipient: Address } }[]) seen.add(getAddress(log.args.recipient));
    candidates = [...seen];
    setText("vendors-note", candidates.length ? "" : "No vendors yet. Payments to any other address are refused.");
  } catch {
    setText("vendors-note", "Could not list vendors: the RPC may limit log queries. Use Check address to look one up.");
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

async function fund(): Promise<void> {
  if (!wallet || !vault || !account) return;
  const token = tokenAddress();
  if (!token) return;
  let amount: bigint;
  try {
    amount = parseUsdc($<HTMLInputElement>("fund-amount").value);
  } catch (error) {
    return status(error instanceof AmountError ? error.message : errorText(error), true);
  }
  if (amount === 0n) return status("Enter an amount above zero.", true);
  if (amount > balances.owner) return status(`You hold only ${formatUsdc(balances.owner)} USDC.`, true);
  await run(`Move ${formatUsdc(amount)} USDC into the vault`, () =>
    wallet!.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [vault!, amount], account: account!, chain: wallet!.chain }),
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
  setText("withdraw-review", `Withdraw ${formatUsdc(amount)} USDC from the vault to ${to}. After this the vault protects ${formatUsdc(balances.vault - amount)} USDC.`);
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
  const config = { chainId: String(chainId), vault, owner: account, token, vendors };
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
  link.download = "owner-config.json";
  link.click();
  URL.revokeObjectURL(link.href);
  status("Saved owner-config.json. Keep it outside the repository and load it in the approval page.");
}

$("connect").addEventListener("click", () => void connect());
$("switch-arc").addEventListener("click", () => void switchToArc());
$("deploy").addEventListener("click", () => void deploy());
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
$("fund").addEventListener("click", () => void fund());
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

// Changing account or chain invalidates everything on screen, so start over rather than guess.
window.ethereum?.on?.("accountsChanged", () => location.reload());
window.ethereum?.on?.("chainChanged", () => location.reload());
