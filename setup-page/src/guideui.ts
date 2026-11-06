// The guided path for one person, and the "connect this agent" action both paths use. Plain DOM, textContent only.
// Every step is read from the chain (through the snapshot the vault screens take) or from the relay, not from storage.
import { getAddress, keccak256, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { formatUsdc } from "./amounts";
import {
  DEFAULTS,
  RelayError,
  agentAddressProblem,
  fetchLinked,
  isLimitsProblem,
  mcpConfig,
  parseLimits,
  registerAgent,
  registrationMessage,
  stepStates,
  type Path,
} from "./guide";
import { isLive, vaultV2Abi } from "./v2";
import type { Snapshot } from "./v2ui";

export interface GuideContext {
  path: Path;
  relay: string | undefined;
  pub(): PublicClient | undefined;
  wallet(): WalletClient | undefined;
  account(): Address | undefined;
  vault(): Address | undefined;
  chainId(): number;
  /** The wallet is connected on Arc (or a local rehearsal chain). */
  walletReady(): boolean;
  /** The vault on screen is built from this repository's code and owned by the connected wallet. */
  vaultIsMine(): boolean;
  status(message: string, isError?: boolean): void;
  run(label: string, action: () => Promise<Hex | void>): Promise<boolean>;
  ask(lines: string[], action: () => Promise<void>, header?: string): void;
  deployNew(): Promise<void>;
  /** Looks for the vault this wallet made before, and opens it if the chain says it is still theirs. */
  resume(): Promise<void>;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element ${id}`);
  return found as T;
};
const setText = (id: string, text: string) => void ($(id).textContent = text);

function safe(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    /* storage can be blocked: the page works without it */
  }
  return null;
}

export function initGuide(ctx: GuideContext) {
  let snapshot: Snapshot | undefined;
  let linked: boolean | null = null;
  let agentConnected = false;
  let alertsSkipped = false;
  let agentTyped: Address | undefined;
  let lastOwner: string | undefined;

  const agentHintKey = () => `guide-agent:${ctx.chainId()}:${(ctx.vault() ?? "").toLowerCase()}`;

  // ---- Registering an agent with the relay (both paths) ----

  function connectAgent(agent: Address, approver: Address): void {
    const vault = ctx.vault();
    const account = ctx.account();
    if (!vault || !account || !ctx.relay) return ctx.status("This copy of the page was built without a relay, so it cannot connect an agent.", true);
    const relay = ctx.relay;
    ctx.ask(
      [
        `Connect agent ${agent} to the relay at ${relay}.`,
        `Alerts for this agent's exceptions go to approver ${approver}.`,
        "Your wallet will ask you to sign a short message. It is not a transaction and costs nothing. The relay then returns a token, shown once on this page.",
        "Connecting again replaces the earlier token and the approver for this agent: the old token stops working.",
      ],
      async () => {
        const wallet = ctx.wallet();
        const pub = ctx.pub();
        if (!wallet || !pub) return;
        try {
          const issuedAt = Math.floor(Date.now() / 1000);
          const chainId = String(ctx.chainId());
          const message = registrationMessage({ chainId, vault, agent, approver, issuedAt });
          ctx.status("Sign the message in your wallet...");
          const signature = await wallet.signMessage({ account, message });
          ctx.status("Registering with the relay...");
          const registered = await registerAgent(relay, { chainId, vault: getAddress(vault), agent, approver, issuedAt, signature });
          const codeHash = keccak256((await pub.getCode({ address: vault })) ?? "0x");
          showToken(agent, approver, registered.token, registered.relay, vault, codeHash);
          agentConnected = true;
          ctx.status(`Agent ${agent} is connected. Copy the settings now: the token is not shown again.`);
          update();
        } catch (error) {
          const text = error instanceof RelayError ? error.message : (error as { shortMessage?: string }).shortMessage ?? (error instanceof Error ? error.message.slice(0, 160) : "The signature was not given.");
          ctx.status(`Could not connect the agent: ${text}`, true);
        }
      },
      `Vault ${vault}, owned by ${account}.`,
    );
  }

  /** The token is put on screen once, in a field, never in a URL or a log, and is cleared when the owner says it is stored. */
  function showToken(agent: Address, approver: Address, token: string, relay: string, vault: Address, codeHash: string): void {
    setText("token-agent", `Agent ${agent}, alerts to ${approver}, on vault ${vault}.`);
    $<HTMLTextAreaElement>("token-config").value = mcpConfig({ vault, codeHash, relayUrl: relay, relayToken: token, chainId: String(ctx.chainId()) });
    $("token-panel").hidden = false;
    $("token-config").focus();
    $("token-panel").scrollIntoView({ block: "nearest" });
  }
  $("token-done").addEventListener("click", () => {
    $<HTMLTextAreaElement>("token-config").value = "";
    $("token-panel").hidden = true;
    ctx.status("The token was cleared from this page. If you lost it, connect the agent again to get a new one.");
  });
  $("token-copy").addEventListener("click", () => {
    const area = $<HTMLTextAreaElement>("token-config");
    area.select();
    void navigator.clipboard?.writeText(area.value).then(
      () => ctx.status("Copied. Paste it into your agent's settings, then press \"I have stored it\"."),
      () => ctx.status("Select the text and copy it yourself.", true),
    );
  });

  if (ctx.path !== "me") return { connectAgent, onRefreshed: (s: Snapshot) => void (snapshot = s), update: () => undefined, onConnected: () => undefined };

  // ---- Just me: one step at a time ----

  const relayLinked = async () => {
    const owner = snapshot?.owner ?? ctx.account();
    linked = ctx.relay && owner ? await fetchLinked(ctx.relay, owner) : null;
  };

  function update(): void {
    const account = ctx.account();
    const live = snapshot?.agents.filter((a) => isLive(a, snapshot!.now) && a.perPaymentLimit > 0n && a.dailyLimit > 0n) ?? [];
    const known = snapshot?.agents.find((a) => a.enabled) ?? undefined;
    const agentAddress = known ? getAddress(known.address) : agentTyped;
    const steps = stepStates({
      walletOnArc: ctx.walletReady(),
      vaultReady: ctx.vaultIsMine() && snapshot !== undefined,
      agentKnown: agentAddress !== undefined,
      agentLimitsSet: live.length > 0,
      capSet: (snapshot?.cap ?? 0n) > 0n,
      vendorCount: snapshot?.vendors.length ?? 0,
      vaultTokens: snapshot?.vaultTokens ?? 0n,
      linked,
      alertsSkipped,
      agentConnected,
    });
    const current = steps.find((s) => s.current);
    document.body.dataset.gstep = current ? String(current.id) : "done";
    $("guide").hidden = false;
    $("g-steps").replaceChildren(
      ...steps.map((s) => {
        const li = document.createElement("li");
        li.dataset.step = String(s.id);
        li.className = s.done ? "done" : s.current ? "now" : "later";
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = s.done ? "Done" : s.current ? "Next" : "Later";
        li.append(mark, document.createTextNode(` ${s.title}`));
        return li;
      }),
    );
    for (const panel of document.querySelectorAll<HTMLElement>("[data-gpanel]")) panel.hidden = panel.dataset.gpanel !== document.body.dataset.gstep;
    $("g-finish").hidden = current !== undefined;
    if (!account) return;

    // Step 3: the agent's address.
    const input = $<HTMLInputElement>("g-agent");
    if (agentAddress && document.activeElement !== input) input.value = agentAddress;
    // Step 4: say which half is left, from the chain.
    const limitsDone = live.length > 0;
    $("g-limits-agent").hidden = limitsDone;
    $("g-limits-cap").hidden = !limitsDone || (snapshot?.cap ?? 0n) > 0n;
    const dailyText = $<HTMLInputElement>("g-daily").value;
    setText("g-cap-line", `Also set the vault's own daily cap to ${dailyText || DEFAULTS.daily} USDC, the same as the agent's daily limit. It is the most the vault will pay in a day in total.`);
    if (limitsDone && live[0]) setText("g-limits-state", `Saved on the chain: up to ${formatUsdc(live[0].perPaymentLimit)} USDC per payment and ${formatUsdc(live[0].dailyLimit)} USDC per day.`);
    // Step 7 and 8 wording.
    setText("g-alerts-state", linked === true ? "Your wallet is linked to Telegram." : linked === false ? "Your wallet is not linked to Telegram yet." : "Could not check the relay just now.");
    $("g-connect-agent").dataset.agent = agentAddress ?? "";
    ($("g-connect-agent") as HTMLButtonElement).disabled = !agentAddress || !ctx.relay;
    setText("g-connect-note", ctx.relay ? "" : "This copy of the page was built without a relay, so it cannot connect an agent.");
    // The finish.
    if (agentAddress) setText("g-finish-agent", agentAddress);
  }

  // Step 2
  $("g-deploy").addEventListener("click", () => void ctx.deployNew());
  // Step 3
  $("g-agent-use").addEventListener("click", () => {
    const owner = ctx.account();
    if (!owner) return;
    const problem = agentAddressProblem($<HTMLInputElement>("g-agent").value, owner);
    if (problem) return ctx.status(problem, true);
    agentTyped = getAddress($<HTMLInputElement>("g-agent").value.trim());
    if (ctx.vault()) safe(agentHintKey(), agentTyped);
    ctx.status(`Agent ${agentTyped} noted. Nothing was sent: the next step saves its limits on the chain.`);
    update();
  });
  // Step 4, first half
  $("g-limits-save").addEventListener("click", async () => {
    const owner = ctx.account();
    const vault = ctx.vault();
    if (!owner || !vault) return;
    const agent = agentTyped ?? (snapshot?.agents[0] ? getAddress(snapshot.agents[0].address) : undefined);
    if (!agent) return ctx.status("Name your agent first.", true);
    const parsed = parseLimits($<HTMLInputElement>("g-per").value, $<HTMLInputElement>("g-daily").value, $<HTMLInputElement>("g-days").value);
    if (isLimitsProblem(parsed)) return ctx.status(parsed.message, true);
    const block = await ctx.pub()!.getBlock();
    const validUntil = block.timestamp + BigInt(parsed.days) * 86_400n;
    ctx.ask(
      [
        `Agent ${agent}.`,
        `It may pay up to ${formatUsdc(parsed.per)} USDC in one payment and ${formatUsdc(parsed.daily)} USDC in one day, for ${parsed.days} days (until ${new Date(Number(validUntil) * 1000).toISOString()}).`,
        "Anything above the per-payment limit needs your signature over that exact payment. Next, you will confirm the vault's own daily cap.",
      ],
      async () => {
        const wallet = ctx.wallet();
        if (!wallet) return;
        await ctx.run(`Save limits for agent ${agent.slice(0, 6)}...${agent.slice(-4)}`, () =>
          wallet.writeContract({ address: vault, abi: vaultV2Abi, functionName: "configureAgent", args: [agent, parsed.per, parsed.daily, validUntil, true], account: owner, chain: wallet.chain }),
        );
      },
    );
  });
  // Step 4, second half: the cap, set to the daily figure
  $("g-cap-save").addEventListener("click", () => {
    const owner = ctx.account();
    const vault = ctx.vault();
    if (!owner || !vault) return;
    const parsed = parseLimits($<HTMLInputElement>("g-per").value, $<HTMLInputElement>("g-daily").value, $<HTMLInputElement>("g-days").value);
    if (isLimitsProblem(parsed)) return ctx.status(parsed.message, true);
    ctx.ask(
      [
        `Set the vault's own daily cap to ${formatUsdc(parsed.daily)} USDC.`,
        "Until this is set, no agent can pay anything. It is the most all agents together can pay in one UTC day, exceptions included.",
      ],
      async () => {
        const wallet = ctx.wallet();
        if (!wallet) return;
        await ctx.run(`Set the vault daily cap to ${formatUsdc(parsed.daily)} USDC`, () =>
          wallet.writeContract({ address: vault, abi: vaultV2Abi, functionName: "setVaultDailyLimit", args: [parsed.daily], account: owner, chain: wallet.chain }),
        );
      },
    );
  });
  // Step 7
  $("g-alerts-check").addEventListener("click", async () => {
    await relayLinked();
    update();
  });
  $("g-alerts-skip").addEventListener("click", () => {
    alertsSkipped = true;
    update();
  });
  // Step 8
  $("g-connect-agent").addEventListener("click", () => {
    const agent = $("g-connect-agent").dataset.agent;
    const owner = snapshot?.owner ?? ctx.account();
    if (agent && owner) connectAgent(getAddress(agent), getAddress(owner));
  });

  async function onRefreshed(s: Snapshot): Promise<void> {
    snapshot = s;
    if (s.owner !== lastOwner || linked === null) {
      lastOwner = s.owner;
      await relayLinked();
    }
    const hint = safe(agentHintKey());
    if (!agentTyped && hint) agentTyped = getAddress(hint);
    update();
  }

  async function onConnected(): Promise<void> {
    update();
    await ctx.resume();
    update();
  }

  update(); // before any wallet: step 1 is the current step and its screen is shown
  return { connectAgent, onRefreshed: (s: Snapshot) => void onRefreshed(s), update, onConnected: () => void onConnected() };
}
