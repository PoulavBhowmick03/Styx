// What each button sends. Pure: given the vault's state as read from the chain, returns the
// receiver and the actions. main.ts signs them with the published agent key.
import { addFullAccessKey, functionCall, transfer, type Action } from './near';

export type State = {
  vault: string; token: string; recipient: string; agent: string;
  policy: { version: number; per_payment_limit: string; daily_limit: string; valid_until: string; enabled: boolean };
  recipientVersion: number; balance: string;
};
export type Built = { receiverId: string; method: string; actions: Action[]; shows: string };
export type Attempt = { id: string; group: 'pay' | 'owner' | 'key'; button: string; about: string; build: (s: State, stranger: string, extra: Extra) => Built };
export type Extra = { paymentId: string; evidence: string; now: number; newKey: Uint8Array };

export const usdc = (base: string | bigint) => { const n = BigInt(base); const f = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${n / 1_000_000n}${f ? '.' + f : ''}`; };
/** An amount inside the per-payment limit: half of it, so the day's budget lasts for more visitors. */
export const inside = (s: State) => { const limit = BigInt(s.policy.per_payment_limit); return limit >= 2n ? limit / 2n : limit; };
export const over = (s: State) => BigInt(s.policy.per_payment_limit) + 1n;

function pay(s: State, recipient: string, recipientVersion: number, amount: bigint, x: Extra): Built {
  const payment = { payment_id: x.paymentId, agent: s.agent, token: s.token, recipient, amount: amount.toString(), evidence_commitment: x.evidence,
    policy_version: s.policy.version, recipient_version: recipientVersion, valid_until: String(x.now + 600) };
  return { receiverId: s.vault, method: 'pay', actions: [functionCall('pay', { payment })], shows: `pay ${JSON.stringify({ payment })}` };
}
const owner = (s: State, method: string, args: unknown): Built =>
  ({ receiverId: s.vault, method, actions: [functionCall(method, args)], shows: `${method} ${JSON.stringify(args)}` });
const HUGE = '1000000000000';

export const ATTEMPTS: Attempt[] = [
  { id: 'pay', group: 'pay', button: 'Pay inside the limit', about: 'An allowed recipient, an amount under the per-payment limit.',
    build: (s, _, x) => pay(s, s.recipient, s.recipientVersion, inside(s), x) },
  { id: 'over', group: 'pay', button: 'Pay over the limit', about: 'One millionth of a token over the per-payment limit, with no approver signature.',
    build: (s, _, x) => pay(s, s.recipient, s.recipientVersion, over(s), x) },
  { id: 'stranger', group: 'pay', button: 'Pay a stranger', about: 'An amount inside the limit, to the account in the box above.',
    build: (s, stranger, x) => pay(s, stranger, 0, inside(s), x) },
  { id: 'raise', group: 'owner', button: 'Raise my own limit', about: 'configure_agent: a million tokens per payment and per day for this key.',
    build: (s, _, x) => owner(s, 'configure_agent', { agent: s.agent, per_payment_limit: HUGE, daily_limit: HUGE, valid_until: String(x.now + 365 * 86400), enabled: true }) },
  { id: 'approver', group: 'owner', button: 'Make myself an approver', about: 'set_approver: this key could then sign its own exceptions.',
    build: s => owner(s, 'set_approver', { approver: s.agent, enabled: true }) },
  { id: 'allow', group: 'owner', button: 'Allow the stranger', about: 'set_recipient: add the account in the box to the allowed recipients.',
    build: (s, stranger) => owner(s, 'set_recipient', { recipient: stranger, allowed: true }) },
  { id: 'withdraw', group: 'owner', button: 'Withdraw everything', about: "withdraw: the vault's whole token balance to the stranger.",
    build: (s, stranger) => owner(s, 'withdraw', { to: stranger, amount: s.balance }) },
  { id: 'token', group: 'key', button: 'Move the tokens directly', about: 'Skip the vault: call ft_transfer on the token contract with this key.',
    build: (s, stranger) => ({ receiverId: s.token, method: 'ft_transfer', actions: [functionCall('ft_transfer', { receiver_id: stranger, amount: s.balance })], shows: `ft_transfer on ${s.token}` }) },
  { id: 'near', group: 'key', button: "Send the vault's NEAR", about: 'A plain transfer of 0.001 NEAR from the vault account to the stranger.',
    build: (_, stranger) => ({ receiverId: stranger, method: 'transfer', actions: [transfer(10n ** 21n)], shows: 'Transfer 0.001 NEAR' }) },
  { id: 'addkey', group: 'key', button: 'Add a full-access key', about: 'Put a new full-access key on the vault account, which could then do anything.',
    build: (s, _, x) => ({ receiverId: s.vault, method: 'add_key', actions: [addFullAccessKey(x.newKey)], shows: 'AddKey (full access)' }) },
];
export const ACCOUNT = /^(?=.{2,64}$)([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$/;
