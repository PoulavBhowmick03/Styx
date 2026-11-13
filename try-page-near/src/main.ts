// The /try page. The agent key is built into the page on purpose (VITE_TRY_AGENT_KEY): it is the
// function-call key of one demo vault, and the page exists so anyone can sign with it.
// textContent only: nothing read from the chain or typed by the visitor is parsed as HTML.
import '../../site/styx.css';
import './try.css';
import nacl from 'tweetnacl';
import { accessKey, base64, functionCall, parseKey, send, view, type Action, type Key } from './near';
import { ACCOUNT, ATTEMPTS, inside, over, usdc, type Attempt, type State } from './attempts';
import { verdict } from './verdict';

const env = import.meta.env;
const RPC: string = env.VITE_TRY_RPC ?? 'https://test.rpc.fastnear.com';
const EXPLORER = 'https://testnet.nearblocks.io';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>('#' + id)!;
const el = (tag: string, text = '', cls = '') => { const e = document.createElement(tag); e.textContent = text; if (cls) e.className = cls; return e; };
const status = (text: string, cls = '') => { $('status').textContent = text; $('status').className = cls; };
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');

let state: State, key: Key, firstVersion: number | undefined;

async function read(): Promise<void> {
  const vault = env.VITE_TRY_VAULT as string, recipient = env.VITE_TRY_RECIPIENT as string;
  const info = await view<{ owner: string; token: string; paused: boolean; vault_daily_limit: string }>(RPC, vault, 'get_vault');
  const [policy, allowed, balance, day, onChain] = await Promise.all([
    view<State['policy'] | null>(RPC, vault, 'get_agent', { agent: key.publicKeyText }),
    view<{ version: number; allowed: boolean } | null>(RPC, vault, 'get_recipient', { recipient }),
    view<string>(RPC, info.token, 'ft_balance_of', { account_id: vault }),
    view<number>(RPC, vault, 'current_day'),
    accessKey(RPC, vault, key.publicKeyText),
  ]);
  if (!policy) throw new Error('This key is not an agent of the vault.');
  const spent = await view<string>(RPC, vault, 'spent_by_agent', { agent: key.publicKeyText, day });
  state = { vault, token: info.token, recipient, agent: key.publicKeyText, policy, recipientVersion: allowed?.version ?? 0, balance };
  firstVersion ??= policy.version;

  const scope = onChain?.key.permission;
  $('key-scope').textContent = !scope ? 'The key is not on the vault account right now.'
    : scope === 'FullAccess' ? 'Full access.'
    : `Call ${scope.FunctionCall.method_names.join(', ')} on ${scope.FunctionCall.receiver_id}. Nothing else.`;
  const left = BigInt(policy.daily_limit) - BigInt(spent);
  const rows: [string, string][] = [
    ['Per payment', `${usdc(policy.per_payment_limit)} tUSDC`], ['Per day', `${usdc(policy.daily_limit)} tUSDC`],
    ['Left today', `${usdc(left > 0n ? left : 0n)} tUSDC`], ['Vault holds', `${usdc(balance)} tUSDC`],
    ['Allowed recipient', recipient], ['Owner', info.owner],
    ['Policy version', String(policy.version)], ['Paused', info.paused ? 'yes' : 'no'],
    ['Gas allowance left', scope && scope !== 'FullAccess' && scope.FunctionCall.allowance ? `${(Number(BigInt(scope.FunctionCall.allowance) / 10n ** 18n) / 1e6).toFixed(4)} NEAR` : 'none'],
  ];
  $('rules').replaceChildren(...rows.map(([k, v]) => { const pair = el('div'); pair.append(el('dt', k), el('dd', v)); return pair; }));
  $('rules-note').textContent = policy.version === firstVersion
    ? `Policy version ${policy.version}: the same as when you opened this page. It changes only when the owner changes the agent's rules.`
    : `Policy version went from ${firstVersion} to ${policy.version} while you were here: the owner changed the rules.`;
}

function show(box: HTMLElement, hash: string, reply: { result?: unknown; error?: unknown }, method: string, sent: string) {
  const v = verdict(reply, method);
  box.className = `result ${v.kind}`; box.hidden = false;
  const parts: HTMLElement[] = [el('p', v.label, 'label'), el('p', v.text)];
  if (v.onChain && hash) {
    const link = el('a', `Transaction ${hash.slice(0, 10)}… on the explorer`) as HTMLAnchorElement;
    link.href = `${EXPLORER}/txns/${hash}`; link.target = '_blank'; link.rel = 'noreferrer';
    const p = el('p'); p.append(link); parts.push(p);
  }
  const raw = document.createElement('details');
  raw.append(el('summary', 'What was sent, and the RPC’s answer'), el('pre', `${sent}\n\n${JSON.stringify(reply.error ?? (reply.result as { status?: unknown })?.status ?? reply, null, 1)}`));
  parts.push(raw);
  box.replaceChildren(...parts);
}

async function run(button: HTMLButtonElement, box: HTMLElement, build: () => { receiverId: string; method: string; actions: Action[]; shows: string }) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#attempts button')];
  buttons.forEach(b => (b.disabled = true));
  box.hidden = false; box.className = 'result'; box.replaceChildren(el('p', 'Signing with the agent key and sending…'));
  try {
    await read();
    const built = build();
    const { hash, reply } = await send(RPC, state.vault, key, built.receiverId, built.actions);
    show(box, hash, reply, built.method, built.shows);
    await read();
  } catch (e) {
    box.replaceChildren(el('p', 'NOT SENT', 'label'), el('p', e instanceof Error ? e.message : String(e)));
  } finally { buttons.forEach(b => (b.disabled = false)); button.focus(); }
}

function stranger(): string {
  const value = $<HTMLInputElement>('stranger').value.trim().toLowerCase();
  if (!ACCOUNT.test(value)) throw new Error('The stranger must be a NEAR account name, such as stranger.testnet.');
  if (value === state.recipient) throw new Error('That account is the allowed recipient. Pick any other.');
  return value;
}

function attemptRow(a: Attempt): HTMLElement {
  const row = el('div', '', 'attempt'), line = el('div', '', 'line'), button = el('button', a.button) as HTMLButtonElement, box = el('div', '', 'result');
  button.type = 'button'; box.hidden = true;
  const about = a.id === 'pay' ? `${usdc(inside(state))} tUSDC to ${state.recipient}, the allowed recipient.`
    : a.id === 'over' ? `${usdc(over(state))} tUSDC: one millionth over the per-payment limit, with no approver signature.` : a.about;
  line.append(button, el('p', about, 'about')); row.append(line, box);
  button.onclick = () => run(button, box, () => a.build(state, stranger(), {
    paymentId: '0x' + hex(nacl.randomBytes(32)), evidence: base64(nacl.randomBytes(32)), now: Math.floor(Date.now() / 1000), newKey: nacl.sign.keyPair().publicKey }));
  return row;
}

async function main() {
  if (!env.VITE_TRY_VAULT || !env.VITE_TRY_AGENT_KEY || !env.VITE_TRY_RECIPIENT) return status('This page is not set up on this deployment.', 'error');
  key = parseKey(env.VITE_TRY_AGENT_KEY as string);
  await read();
  const link = $<HTMLAnchorElement>('vault-link'); link.textContent = state.vault; link.href = `${EXPLORER}/address/${state.vault}`;
  $('secret').textContent = env.VITE_TRY_AGENT_KEY as string;
  $('copy').onclick = async () => { await navigator.clipboard.writeText(env.VITE_TRY_AGENT_KEY as string); $('copy').textContent = 'Copied'; };
  for (const list of document.querySelectorAll<HTMLElement>('.list'))
    list.replaceChildren(...ATTEMPTS.filter(a => a.group === list.dataset.group).map(attemptRow));
  $<HTMLInputElement>('free-receiver').value = state.vault;
  $<HTMLButtonElement>('free-send').onclick = () => run($<HTMLButtonElement>('free-send'), $('free-result'), () => {
    const receiverId = $<HTMLInputElement>('free-receiver').value.trim(), method = $<HTMLInputElement>('free-method').value.trim();
    if (!ACCOUNT.test(receiverId)) throw new Error('The contract must be a NEAR account name.');
    if (!/^[A-Za-z0-9_]{1,64}$/.test(method)) throw new Error('Give a method name.');
    let args: unknown; try { args = JSON.parse($<HTMLTextAreaElement>('free-args').value || '{}'); } catch { throw new Error('The arguments are not valid JSON.'); }
    return { receiverId, method, actions: [functionCall(method, args)], shows: `${method} ${JSON.stringify(args)} on ${receiverId}` };
  });
  for (const id of ['key-card', 'rules-card', 'attempts']) $(id).hidden = false;
  status('Vault read from the chain. Pick something to try.', 'done');
}
main().catch(e => status(e instanceof Error ? e.message : String(e), 'error'));
