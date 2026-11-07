// The setup screens for a version 2 vault: the vault's daily cap, agents, approvers and vendors.
// Plain DOM, textContent only, so the markup is easy to restyle. Every write goes through one confirmation
// panel that names the vault and, where it applies, the agent.
import { getAddress, isAddress, zeroAddress, type Address, type Hex, type PublicClient, type WalletClient } from "viem";

import { erc20Abi } from "./abi";
import { AmountError, formatUsdc, parseUsdc } from "./amounts";
import { MAX_LOG_RANGE, pageLogs } from "./logs";
import {
  agentProblem,
  approverProblem,
  assessV2,
  dayOf,
  isLive,
  isReady,
  limitsProblem,
  vaultV2Abi,
  type AgentView,
  type ApproverView,
} from "./v2";

export interface V2Context {
  pub(): PublicClient | undefined;
  wallet(): WalletClient | undefined;
  account(): Address | undefined;
  vault(): Address | undefined;
  isOwner(): boolean;
  busy(): boolean;
  status(message: string, isError?: boolean): void;
  run(label: string, action: () => Promise<Hex | void>): Promise<boolean>;
  creationBlock(address: Address, head: bigint): Promise<bigint | undefined>;
  labels(): Record<string, string>;
  setVendor(address: Address, allowed: boolean): Promise<void>;
  /** Hands the page's shared funding and withdrawal flows the numbers they check against. */
  shared(values: { vaultTokens: bigint; ownerTokens: bigint; token: Address; owner: Address; paused: boolean }): void;
  setControls(): void;
  /** Whether a wallet has linked Telegram on the relay: null when the relay cannot be asked or there is none. */
  linkedOf?(address: string): Promise<boolean | null>;
  /** Signs and sends the registration that connects an agent to the relay. Asks for confirmation first. */
  connectAgent?(agent: Address, approver: Address): void;
  /** Called after every read of the vault with what was read. */
  onRefreshed?(snapshot: Snapshot): void;
}

/** What the last read of the vault found. The guided path reads its steps from this, never from storage. */
export interface Snapshot {
  vault: Address;
  owner: Address;
  cap: bigint;
  agents: AgentView[];
  approvers: ApproverView[];
  vendors: Address[];
  vaultTokens: bigint;
  paused: boolean;
  now: bigint;
  partial: boolean;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element ${id}`);
  return found as T;
};
const setText = (id: string, text: string) => void ($(id).textContent = text);
const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Pages read when the vault's creation block cannot be found. The same build setting as the version 1 list. */
const FALLBACK_PAGES = (() => {
  const raw = Number(import.meta.env.VITE_LOG_FALLBACK_PAGES ?? 12);
  return Number.isInteger(raw) && raw >= 1 && raw <= 400 ? raw : 12;
})();

interface Scan {
  vault: Address;
  agents: Set<Address>;
  approvers: Set<Address>;
  vendors: Set<Address>;
  scannedTo: bigint;
}

export function initV2(ctx: V2Context) {
  let scan: Scan | undefined;
  let agents: AgentView[] = [];
  let approvers: ApproverView[] = [];
  let ownerAddress: Address | undefined;
  let pending: (() => Promise<void>) | undefined;
  let lastCap = 0n;
  const linkStates = new Map<string, boolean | null>();

  // ---- The one confirmation panel ----

  function ask(lines: string[], action: () => Promise<void>, header?: string): void {
    const vault = ctx.vault();
    if (!vault && header === undefined) return;
    setText("v2-confirm-text", [header ?? `Vault ${vault}, owned by ${ownerAddress ?? "(reading...)"}.`, ...lines].join("\n"));
    $("v2-confirm").hidden = false;
    $("v2-confirm").focus(); // display only: the panel is a fixed second step and must be seen
    pending = action;
    ctx.status("Check what this will do, then confirm or cancel. Nothing has been sent.");
    ctx.setControls();
  }
  const dismiss = () => {
    $("v2-confirm").hidden = true;
    pending = undefined;
  };
  $("v2-confirm-yes").addEventListener("click", () => {
    const action = pending;
    dismiss();
    if (action) void action();
  });
  $("v2-confirm-no").addEventListener("click", () => {
    dismiss();
    ctx.status("Cancelled. Nothing was sent.");
  });

  const readAddress = (id: string, what: string): Address | undefined => {
    const value = $<HTMLInputElement>(id).value.trim();
    if (!isAddress(value, { strict: false })) {
      ctx.status(`${what} must be an address.`, true);
      return undefined;
    }
    return getAddress(value);
  };
  const amount = (id: string): bigint | undefined => {
    try {
      return parseUsdc($<HTMLInputElement>(id).value);
    } catch (error) {
      ctx.status(error instanceof AmountError ? error.message : "Enter an amount like 0.25.", true);
      return undefined;
    }
  };
  const refusalContext = () => ({
    owner: ownerAddress ?? zeroAddress,
    approvers: approvers.filter((a) => a.enabled).map((a) => a.address),
    agents: agents.filter((a) => a.enabled).map((a) => a.address),
  });
  const write = (functionName: string, args: unknown[]) => {
    const wallet = ctx.wallet();
    const account = ctx.account();
    const vault = ctx.vault();
    if (!wallet || !account || !vault) throw new Error("not connected");
    return wallet.writeContract({ address: vault, abi: vaultV2Abi, functionName, args, account, chain: wallet.chain } as never);
  };

  // ---- A. The vault's daily cap ----

  $("v2-cap-save").addEventListener("click", () => {
    const limit = amount("v2-cap-input");
    if (limit === undefined) return;
    const before = $("v2-cap").dataset.value ? BigInt($("v2-cap").dataset.value as string) : 0n;
    const lines = [
      `Set the vault's daily cap to ${formatUsdc(limit)} USDC (it is ${formatUsdc(before)} now).`,
      "This is the most all agents together can pay in one UTC day, exceptions included, on top of each agent's own limit. It takes effect at once and does not cancel any approval already signed.",
    ];
    if (limit === 0n) lines.push("A cap of 0 means every agent is refused until a cap above zero is set.");
    ask(lines, async () => void (await ctx.run(`Set the vault daily cap to ${formatUsdc(limit)} USDC`, () => write("setVaultDailyLimit", [limit]))));
  });

  // ---- B. Agents ----

  function selectAgent(address: string | undefined): void {
    const agent = address ? agents.find((a) => same(a.address, address)) : undefined;
    $<HTMLInputElement>("v2-agent-address").value = agent?.address ?? "";
    if (agent) {
      $<HTMLInputElement>("v2-agent-per").value = formatUsdc(agent.perPaymentLimit) || "1";
      $<HTMLInputElement>("v2-agent-daily").value = formatUsdc(agent.dailyLimit) || "10";
    }
    setText("v2-agent-heading", agent ? `Selected agent ${agent.address}` : "Add an agent");
    $<HTMLInputElement>("v2-agent-address").focus();
  }
  $("v2-agent-clear").addEventListener("click", () => selectAgent(undefined));

  $("v2-agent-save").addEventListener("click", async () => {
    const agent = readAddress("v2-agent-address", "The agent address");
    const per = amount("v2-agent-per");
    const daily = amount("v2-agent-daily");
    if (!agent || per === undefined || daily === undefined) return;
    const days = $<HTMLInputElement>("v2-agent-days").value.trim();
    if (!/^[1-9][0-9]{0,3}$/.test(days)) return ctx.status("Days must be a whole number from 1 to 9999.", true);
    const problem = agentProblem(agent, true, refusalContext()) ?? limitsProblem(per, daily);
    if (problem) return ctx.status(problem, true);
    const block = await ctx.pub()!.getBlock();
    const validUntil = block.timestamp + BigInt(days) * 86_400n;
    const existing = agents.find((a) => same(a.address, agent));
    ask(
      [
        `Agent ${agent}${existing ? ` (policy version ${existing.version} now, ${existing.enabled ? "switched on" : "switched off"})` : " (new)"}.`,
        `Save it switched ON with a per-payment limit of ${formatUsdc(per)} USDC, a daily limit of ${formatUsdc(daily)} USDC, valid for ${days} days (until ${new Date(Number(validUntil) * 1000).toISOString()}).`,
        "This changes only this agent. Approvals waiting for other agents stay valid. An approval already signed for this agent no longer works, because its policy version moves on: the agent has to ask again. Spending already counted today is not reset.",
        "Until the vault's daily cap is above zero, and an allowed vendor exists, this agent still cannot pay.",
      ],
      async () => void (await ctx.run(`Save agent ${short(agent)}`, () => write("configureAgent", [agent, per, daily, validUntil, true]))),
    );
  });

  function switchOff(address: string): void {
    const agent = agents.find((a) => same(a.address, address));
    if (!agent) return ctx.status("That address is not an agent this vault knows.", true);
    if (!agent.enabled) return ctx.status(`Agent ${agent.address} is already switched off.`, true);
    ask(
      [
        `Agent ${agent.address} (policy version ${agent.version}).`,
        "Switch it OFF. It can no longer pay. Its limits are kept, so switching it on again later needs one save.",
        "This changes only this agent. Approvals waiting for other agents stay valid. Approvals already signed for this agent stop working.",
      ],
      async () => void (await ctx.run(`Switch off agent ${short(agent.address)}`, () => write("configureAgent", [agent.address, agent.perPaymentLimit, agent.dailyLimit, agent.validUntil, false]))),
    );
  }
  $("v2-agent-off").addEventListener("click", () => {
    const agent = readAddress("v2-agent-address", "The agent address");
    if (agent) switchOff(agent);
  });

  // ---- C. Approvers ----

  function changeApprover(address: Address, enabling: boolean): void {
    const problem = approverProblem(address, enabling, refusalContext());
    if (problem) return ctx.status(problem, true);
    const known = approvers.find((a) => same(a.address, address));
    if (!enabling && !known?.enabled) return ctx.status(`${address} is not a switched-on approver.`, true);
    const lines = enabling
      ? [
          `Approver ${address}.`,
          "Add it. An approver can authorize an exception for any enabled agent, with no budget of its own: an exception lifts only the per-payment limit, and the agent's daily limit and the vault's daily cap still apply.",
          "Adding an approver does not change any agent and does not cancel any waiting approval.",
        ]
      : [
          `Approver ${address}.`,
          "Remove it. Approvals it has already signed stop working once this transaction runs. Adding it again later does not bring an old approval back.",
          "No agent changes, and approvals signed by other approvers are not affected.",
        ];
    ask(lines, async () => void (await ctx.run(`${enabling ? "Add" : "Remove"} approver ${short(address)}`, () => write("setApprover", [address, enabling]))));
  }
  $("v2-approver-add").addEventListener("click", () => {
    const address = readAddress("v2-approver-address", "The approver address");
    if (address) changeApprover(address, true);
  });

  // ---- Reading the vault ----

  async function scanLogs(mine: Address, head: bigint): Promise<string> {
    const pub = ctx.pub()!;
    const events = vaultV2Abi.filter((x) => x.type === "event" && ["AgentConfigured", "ApproverSet", "RecipientSet"].includes(x.name));
    const fetchRange = async (fromBlock: bigint, toBlock: bigint) =>
      (await pub.getLogs({ address: mine, events: events as never, fromBlock, toBlock })) as unknown as { eventName: string; args: Record<string, string> }[];
    const apply = (target: Scan, logs: { eventName: string; args: Record<string, string> }[]) => {
      for (const log of logs) {
        if (log.eventName === "AgentConfigured") target.agents.add(getAddress(log.args.agent as string));
        else if (log.eventName === "ApproverSet") target.approvers.add(getAddress(log.args.approver as string));
        else if (log.eventName === "RecipientSet") target.vendors.add(getAddress(log.args.recipient as string));
      }
    };
    const previous = scan?.vault === mine ? scan : undefined;
    if (previous) {
      const fresh = await pageLogs(fetchRange, previous.scannedTo + 1n, head, { retry: false });
      if (!fresh.complete) {
        scan = undefined;
        throw new Error(fresh.reason ?? "the RPC stopped answering");
      }
      apply(previous, fresh.items);
      previous.scannedTo = head;
      return "";
    }
    const created = await ctx.creationBlock(mine, head);
    const start = created ?? (head >= MAX_LOG_RANGE * BigInt(FALLBACK_PAGES) ? head - MAX_LOG_RANGE * BigInt(FALLBACK_PAGES) + 1n : 0n);
    const result = await pageLogs(fetchRange, start, head, { maxPages: created === undefined ? FALLBACK_PAGES : 400, retry: false });
    const fresh: Scan = { vault: mine, agents: new Set(), approvers: new Set(), vendors: new Set(), scannedTo: head };
    apply(fresh, result.items);
    if (result.complete && created !== undefined) {
      scan = fresh;
      return "";
    }
    // Keep what was read for this draw, but never treat it as a complete history.
    scan = undefined;
    previousPartial = fresh;
    return `Partial list: this page read ${created === undefined ? `the most recent blocks, from ${result.scannedFrom}, because this RPC could not say when the vault was created` : `block ${result.scannedFrom} to ${head}`}${result.reason ? `, then ${result.reason}` : ""}. An agent, approver or vendor added earlier may be missing. Type an address to look it up.`;
  }
  let previousPartial: Scan | undefined;

  async function refresh(): Promise<void> {
    const pub = ctx.pub();
    const vault = ctx.vault();
    const account = ctx.account();
    if (!pub || !vault || !account) return;
    const mine = vault;
    const read = (functionName: string, args?: unknown[]) => pub.readContract({ address: mine, abi: vaultV2Abi, functionName, args } as never) as Promise<never>;
    const balanceOf = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

    const block = await pub.getBlock();
    const [owner, token, paused, cap] = (await Promise.all([read("owner"), read("token"), read("paused"), read("vaultDailyLimit")])) as [Address, Address, boolean, bigint];
    const day = dayOf(block.timestamp);
    const [vaultTokens, ownerTokens, spent] = await Promise.all([balanceOf(token, mine), balanceOf(token, account), read("spentByDay", [day]) as Promise<bigint>]);
    let partialNote = "";
    let seen: Scan | undefined;
    try {
      partialNote = await scanLogs(mine, block.number);
      seen = scan?.vault === mine ? scan : previousPartial;
    } catch (error) {
      partialNote = `Could not list agents, approvers and vendors (${error instanceof Error ? error.message.slice(0, 120) : "an RPC error"}).`;
    }
    const agentAddresses = seen ? [...seen.agents] : [];
    const approverAddresses = seen ? [...seen.approvers] : [];
    const vendorAddresses = seen ? [...seen.vendors] : [];
    const [agentRows, approverRows, vendorAllowed] = await Promise.all([
      Promise.all(agentAddresses.map(async (address): Promise<AgentView> => {
        const [version, perPaymentLimit, dailyLimit, validUntil, enabled] = (await read("agentPolicy", [address])) as unknown as [bigint, bigint, bigint, bigint, boolean];
        const [spentToday, held] = await Promise.all([read("spentByAgentDay", [address, day]) as Promise<bigint>, balanceOf(token, address)]);
        return { address, version, perPaymentLimit, dailyLimit, validUntil, enabled, spentToday, held };
      })),
      Promise.all(approverAddresses.map(async (address): Promise<ApproverView> => {
        const [version, enabled] = (await read("approverState", [address])) as unknown as [bigint, boolean];
        return { address, version, enabled };
      })),
      Promise.all(vendorAddresses.map((address) => read("allowedRecipient", [address]) as Promise<boolean>)),
    ]);
    // The owner may have switched vaults while these reads were in flight. Draw nothing from a stale answer.
    if (ctx.vault() !== mine) return;
    ownerAddress = getAddress(owner);
    agents = agentRows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.address.localeCompare(b.address));
    approvers = approverRows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.address.localeCompare(b.address));
    const vendors = vendorAddresses.filter((_, i) => vendorAllowed[i]);
    ctx.shared({ vaultTokens, ownerTokens, token, owner: ownerAddress, paused });

    setText("v2-address", mine);
    setText("v2-owner", ownerAddress);
    setText("v2-paused", paused ? "PAUSED: no agent can pay" : "Active");
    setText("v2-cap", cap === 0n ? "0 USDC: no agent can pay yet. Set it in A." : `${formatUsdc(cap)} USDC`);
    $("v2-cap").dataset.value = cap.toString();
    setText("v2-spent", `${formatUsdc(spent)} USDC (UTC day ${day})`);
    setText("v2-balance", `${formatUsdc(vaultTokens)} USDC`);
    setText("v2-owner-balance", `${formatUsdc(ownerTokens)} USDC`);
    $("v2-not-owner").hidden = ctx.isOwner();
    const capInput = $<HTMLInputElement>("v2-cap-input");
    if (!capInput.value && cap > 0n) capInput.value = formatUsdc(cap);

    lastCap = cap;
    renderAgents(block.timestamp);
    renderApprovers();
    void loadLinks();
    renderVendors(vendors);
    setText("v2-agent-note", partialNote);
    setText("vendors-note", partialNote || (vendors.length ? "" : "No vendors yet. Payments to any other address are refused."));

    const checks = assessV2({ cap, agents, vendorCount: vendors.length, vaultTokens, paused, now: block.timestamp, partial: partialNote !== "" });
    $("v2-checks").replaceChildren(
      ...checks.map((c) => {
        const li = document.createElement("li");
        const tag = document.createElement("span");
        tag.className = `tag ${c.state}`;
        tag.textContent = c.state === "ok" ? "OK" : c.state === "warn" ? "FIX" : "TO DO";
        li.append(tag, document.createTextNode(c.text));
        return li;
      }),
    );
    setText("v2-verdict", isReady(checks) ? "An agent can pay now. This says the setup is complete, not that the contract has been audited." : "Not yet: work through the items above.");
    ctx.setControls();
    ctx.onRefreshed?.({ vault: mine, owner: ownerAddress, cap, agents, approvers, vendors, vaultTokens, paused, now: block.timestamp, partial: partialNote !== "" });
  }

  /** Asks the relay, once per refresh, whether each approver has linked Telegram, then redraws the approvers. */
  async function loadLinks(): Promise<void> {
    if (!ctx.linkedOf) return;
    const who = [ownerAddress, ...approvers.filter((a) => a.enabled).map((a) => a.address)].filter((a): a is Address => Boolean(a));
    const mine = ctx.vault();
    const answers = await Promise.all(who.map((a) => ctx.linkedOf!(a)));
    if (ctx.vault() !== mine) return;
    who.forEach((a, i) => linkStates.set(a.toLowerCase(), answers[i] ?? null));
    renderApprovers();
  }

  // ---- Drawing the lists ----

  const button = (text: string, onClick: () => void, secondary = true) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = secondary ? "secondary" : "";
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  };
  const badge = (text: string, on: boolean) => {
    const s = document.createElement("span");
    s.className = `badge ${on ? "on" : "off"}`;
    s.textContent = text;
    return s;
  };

  function renderAgents(now: bigint): void {
    const list = $("v2-agent-list");
    if (!agents.length) {
      const li = document.createElement("li");
      li.textContent = "No agent yet. Until one is added and switched on, nothing can be paid.";
      return void list.replaceChildren(li);
    }
    list.replaceChildren(
      ...agents.map((agent) => {
        const li = document.createElement("li");
        li.className = "row";
        const body = document.createElement("div");
        body.className = "grow";
        const address = document.createElement("div");
        address.className = "mono";
        address.textContent = agent.address;
        const live = isLive(agent, now);
        const state = !agent.enabled ? "OFF" : live ? "ON" : "ON, EXPIRED";
        const detail = document.createElement("div");
        detail.className = "note";
        detail.textContent = `Per payment ${formatUsdc(agent.perPaymentLimit)} USDC, daily ${formatUsdc(agent.dailyLimit)} USDC, paid today ${formatUsdc(agent.spentToday)} USDC. Valid until ${agent.validUntil === 0n ? "never set" : new Date(Number(agent.validUntil) * 1000).toISOString()}. Policy version ${agent.version}. Holds ${formatUsdc(agent.held)} USDC of its own.`;
        body.append(address, badge(state, agent.enabled && live), detail);
        li.append(body, button("Edit", () => selectAgent(agent.address)));
        if (agent.enabled) li.append(button("Switch off", () => switchOff(agent.address)));
        if (agent.enabled && ctx.connectAgent && ownerAddress) {
          const choices = [ownerAddress, ...approvers.filter((a) => a.enabled).map((a) => getAddress(a.address))];
          const label = document.createElement("label");
          label.className = "approver-pick";
          label.textContent = "Approver who gets this agent's alerts ";
          const select = document.createElement("select");
          select.className = "approver-select";
          for (const choice of choices) {
            const option = document.createElement("option");
            option.value = choice;
            option.textContent = `${choice === ownerAddress ? "Owner " : "Approver "}${choice}`;
            select.append(option);
          }
          label.append(select);
          const connectButton = button("Connect this agent", () => ctx.connectAgent!(getAddress(agent.address), getAddress(select.value)));
          connectButton.className = "connect-agent";
          li.append(label, connectButton);
        }
        return li;
      }),
    );
  }

  /** Whether an approver can get alerts: they link Telegram by opening the approval site's /?link page. */
  function linkNote(address: string | undefined): HTMLElement {
    const note = document.createElement("span");
    note.className = "note link-state";
    const state = address ? linkStates.get(address.toLowerCase()) : undefined;
    note.textContent = !ctx.linkedOf ? "" : state === true ? "Alerts: linked" : state === false ? "Alerts: not linked. Tell them to open https://styxco.xyz/?link" : "Alerts: not checked";
    return note;
  }

  function renderApprovers(): void {
    const list = $("v2-approver-list");
    const owner = document.createElement("li");
    owner.className = "row";
    const ownerBody = document.createElement("div");
    ownerBody.className = "grow mono";
    ownerBody.textContent = ownerAddress ?? "";
    owner.append(ownerBody, badge("OWNER, ALWAYS AN APPROVER", true), linkNote(ownerAddress));
    list.replaceChildren(
      owner,
      ...approvers.map((approver) => {
        const li = document.createElement("li");
        li.className = "row";
        const body = document.createElement("div");
        body.className = "grow mono";
        body.textContent = approver.address;
        const detail = document.createElement("span");
        detail.className = "note";
        detail.textContent = `version ${approver.version}`;
        li.append(body, badge(approver.enabled ? "ON" : "OFF", approver.enabled), detail);
        if (approver.enabled) li.append(linkNote(approver.address));
        if (approver.enabled) li.append(button("Remove", () => changeApprover(getAddress(approver.address), false)));
        return li;
      }),
    );
  }

  function renderVendors(vendors: Address[]): void {
    const names = ctx.labels();
    $("vendors").replaceChildren(
      ...vendors.map((address) => {
        const li = document.createElement("li");
        const text = document.createElement("span");
        text.className = "mono";
        const label = names[address.toLowerCase()];
        text.textContent = `${label ? `${label}: ` : ""}${address}`;
        li.append(text, button("Remove", () => void ctx.setVendor(address, false)));
        li.querySelector("button")!.classList.add("remove");
        return li;
      }),
    );
  }

  function reset(): void {
    scan = undefined;
    previousPartial = undefined;
    agents = [];
    approvers = [];
    ownerAddress = undefined;
    dismiss();
    for (const id of ["v2-agent-address", "v2-approver-address", "v2-cap-input"]) $<HTMLInputElement>(id).value = "";
    $<HTMLInputElement>("v2-agent-per").value = "1";
    $<HTMLInputElement>("v2-agent-daily").value = "10";
    $<HTMLInputElement>("v2-agent-days").value = "7";
    setText("v2-agent-heading", "Add an agent");
    for (const id of ["v2-agent-list", "v2-approver-list", "v2-checks"]) $(id).replaceChildren();
  }

  return { refresh, reset, ask, hasPending: () => pending !== undefined, cap: () => lastCap, forgetLinks: () => linkStates.clear() };
}
