import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { linkMessage, registerMessage } from "../../owner-page/src/messages";
import { botReply, People, type ChainReader } from "../src/people";

const VAULT = getAddress("0x2000000000000000000000000000000000000002");
const TOKEN = getAddress("0x3600000000000000000000000000000000000000");
const AGENT = getAddress("0xa00000000000000000000000000000000000000a");
const NOW = 1_800_000_000;
const owner = privateKeyToAccount(generatePrivateKey());
const approver = privateKeyToAccount(generatePrivateKey());

const chain = (overrides: Partial<ChainReader> = {}): ChainReader => ({
  contractVersion: async () => 2n,
  owner: async () => owner.address,
  token: async () => TOKEN,
  signerEnabled: async (_vault, signer) => signer === owner.address || signer === approver.address,
  ...overrides,
});
const people = (reader = chain(), stateDir?: string, now = () => NOW) =>
  new People({ chain: reader, chainId: 5042002n, token: TOKEN, botUsername: "styx_agent_bot", now, ...(stateDir ? { stateDir } : {}) });

const linkBody = async (account = approver, issuedAt = NOW, wallet: Address = account.address) => ({
  wallet, issuedAt, signature: await account.signMessage({ message: linkMessage(wallet, issuedAt) }),
});
const registerBody = async (signer = owner, overrides: { agent?: Address; approver?: Address; issuedAt?: number } = {}) => {
  const a = overrides.agent ?? AGENT, b = overrides.approver ?? approver.address, issuedAt = overrides.issuedAt ?? NOW;
  return { chainId: "5042002", vault: VAULT, agent: a, approver: b, issuedAt, signature: await signer.signMessage({ message: registerMessage(5042002n, VAULT, a, b, issuedAt) }) };
};

describe("linking Telegram to a wallet", () => {
  it("gives a one-time bot link for a wallet that proves itself, and maps the chat once tapped", async () => {
    const p = people();
    const { code, botUrl } = await p.startLink(await linkBody());
    expect(botUrl).toBe(`https://t.me/styx_agent_bot?start=${code}`);
    expect(code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(p.isLinked(approver.address)).toBe(false);
    expect(p.completeLink(code, "555")).toBe(approver.address);
    expect(p.isLinked(approver.address)).toBe(true);
    expect(p.chatFor(approver.address)).toBe("555");
    expect(p.completeLink(code, "666")).toBeUndefined();
    expect(p.chatFor(approver.address)).toBe("555");
  });
  it("refuses a signature by anyone else, so nobody can claim another wallet's alerts", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    await expect(people().startLink(await linkBody(stranger, NOW, approver.address))).rejects.toMatchObject({ status: 403 });
  });
  it("refuses an old signature and an expired code", async () => {
    await expect(people().startLink(await linkBody(approver, NOW - 601))).rejects.toMatchObject({ status: 400 });
    let now = NOW;
    const p = people(chain(), undefined, () => now);
    const { code } = await p.startLink(await linkBody());
    now += 601;
    expect(p.completeLink(code, "555")).toBeUndefined();
  });
  it("lets a wallet move to a new chat by linking again", async () => {
    const p = people();
    p.completeLink((await p.startLink(await linkBody())).code, "1");
    p.completeLink((await p.startLink(await linkBody())).code, "2");
    expect(p.chatFor(approver.address)).toBe("2");
  });
  it("refuses malformed bodies", async () => {
    await expect(people().startLink({ wallet: "nope", issuedAt: NOW, signature: "0x" })).rejects.toMatchObject({ status: 400 });
    await expect(people().startLink(null)).rejects.toMatchObject({ status: 400 });
  });
});

describe("the bot", () => {
  it("links from /start with a code, and answers everything else with what to do", async () => {
    const p = people();
    const { code } = await p.startLink(await linkBody());
    expect(botReply(p, { message: { chat: { id: 555 }, text: `/start ${code}` } })).toEqual({ chatId: "555", text: expect.stringContaining(approver.address) });
    expect(p.chatFor(approver.address)).toBe("555");
    expect(botReply(p, { message: { chat: { id: 7 }, text: `/start ${code}` } })?.text).toMatch(/expired or was used/);
    expect(botReply(p, { message: { chat: { id: 7 }, text: "hello" } })?.text).toMatch(/styxco\.xyz\/\?link/);
    expect(botReply(p, { update_id: 1 })).toBeUndefined();
  });
});

describe("registering an agent", () => {
  it("gives the owner a token that names the vault, agent and approver, and stores only its hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "people-"));
    const p = people(chain(), dir);
    const { token } = await p.register(await registerBody());
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(p.agentByToken(token)).toMatchObject({ vault: VAULT, agent: AGENT, approver: approver.address });
    expect(p.agentByToken("wrong")).toBeUndefined();
    const again = people(chain(), dir);
    expect(again.agentByToken(token)).toMatchObject({ agent: AGENT });
    const { readFileSync, readdirSync } = await import("node:fs");
    for (const file of readdirSync(dir)) expect(readFileSync(join(dir, file), "utf8")).not.toContain(token);
  });
  it("refuses anyone but the vault's owner", async () => {
    await expect(people().register(await registerBody(approver))).rejects.toMatchObject({ status: 403 });
  });
  it("refuses an approver the vault does not list, and accepts the owner as approver", async () => {
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    await expect(people().register(await registerBody(owner, { approver: stranger }))).rejects.toMatchObject({ status: 400 });
    await expect(people().register(await registerBody(owner, { approver: owner.address }))).resolves.toHaveProperty("token");
  });
  it("refuses a contract that is not a current vault, and another token", async () => {
    await expect(people(chain({ contractVersion: async () => 1n })).register(await registerBody())).rejects.toMatchObject({ status: 400 });
    await expect(people(chain({ token: async () => VAULT })).register(await registerBody())).rejects.toMatchObject({ status: 400 });
  });
  it("says the chain could not be read, rather than refusing for a wrong reason", async () => {
    const down = chain({ owner: async () => { throw new Error("rpc"); } });
    await expect(people(down).register(await registerBody())).rejects.toMatchObject({ status: 503 });
  });
  it("refuses an old signature", async () => {
    await expect(people().register(await registerBody(owner, { issuedAt: NOW - 601 }))).rejects.toMatchObject({ status: 400 });
  });
  it("replaces the token when an agent registers again, so an old token stops working", async () => {
    const p = people();
    const first = (await p.register(await registerBody())).token;
    const second = (await p.register(await registerBody(owner, { approver: owner.address }))).token;
    expect(p.agentByToken(first)).toBeUndefined();
    expect(p.agentByToken(second)?.approver).toBe(owner.address);
  });
});

export type { Hex };
