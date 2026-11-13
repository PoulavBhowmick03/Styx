import { describe, expect, it } from 'vitest';
import fixtures from './fixtures.json';
import { verdict } from './verdict';
import { ACCOUNT, ATTEMPTS, inside, over, usdc, type State } from './attempts';

// fixtures.json holds the RPC's real replies from the testnet run of 13 Nov 2026 (docs/near/TRY_PAGE.md).
describe('verdict, on real testnet replies', () => {
  it('a payment inside the limits', () => expect(verdict(fixtures.pay)).toMatchObject({ kind: 'paid', onChain: true }));
  it('over the limit: refused by the vault, on chain', () =>
    expect(verdict(fixtures.over)).toMatchObject({ kind: 'vault', label: 'REFUSED by the vault: PerPaymentLimitExceeded', onChain: true }));
  it('a stranger: refused by the vault', () => expect(verdict(fixtures.stranger).label).toBe('REFUSED by the vault: RecipientNotAllowed'));
  it('an owner method: rejected by NEAR, never in a block', () => {
    const v = verdict(fixtures.raise, 'configure_agent');
    expect(v).toMatchObject({ kind: 'near', label: 'REJECTED by NEAR: MethodNameMismatch', onChain: false });
    expect(v.text).toContain('configure_agent');
  });
  it('AddKey: needs full access', () => expect(verdict(fixtures.addkey, 'add_key').label).toBe('REJECTED by NEAR: RequiresFullAccess'));
  it('a spent allowance is named as such', () => expect(verdict(fixtures.notEnoughAllowance).label).toBe('REJECTED by NEAR: NotEnoughAllowance'));
  it('a rolled-back transfer is not reported as paid', () =>
    expect(verdict({ result: { status: { SuccessValue: btoa('false') } } }).kind).toBe('vault'));
  it('an RPC error that is not about the key is not called a refusal', () =>
    expect(verdict({ error: { name: 'REQUEST_VALIDATION_ERROR' } }).kind).toBe('other'));
});

const state: State = { vault: 'try.styx-vaults.testnet', token: 'usdc.testnet', recipient: 'vendor.testnet', agent: 'ed25519:abc',
  policy: { version: 3, per_payment_limit: '1000000', daily_limit: '20000000', valid_until: '1', enabled: true }, recipientVersion: 2, balance: '500000000' };
const extra = { paymentId: '0x01', evidence: 'AAAA', now: 1000, newKey: new Uint8Array(32) };
const args = (id: string, stranger = 'mallory.testnet') => {
  const built = ATTEMPTS.find(a => a.id === id)!.build(state, stranger, extra);
  const call = (built.actions[0] as { functionCall: { args: Uint8Array } }).functionCall;
  return { built, json: JSON.parse(new TextDecoder().decode(call.args)) };
};
describe('attempts', () => {
  it('amounts sit just inside and just over the limit', () => {
    expect(inside(state)).toBe(500000n); expect(over(state)).toBe(1000001n); expect(usdc(over(state))).toBe('1.000001'); expect(usdc('20000000')).toBe('20');
  });
  it('the honest payment names the current versions, the token and a deadline', () => {
    const { built, json } = args('pay');
    expect(built.receiverId).toBe(state.vault);
    expect(json.payment).toEqual({ payment_id: '0x01', agent: state.agent, token: state.token, recipient: state.recipient, amount: '500000',
      evidence_commitment: 'AAAA', policy_version: 3, recipient_version: 2, valid_until: '1600' });
  });
  it('the stranger payment and the owner calls name the stranger', () => {
    expect(args('stranger').json.payment.recipient).toBe('mallory.testnet');
    expect(args('withdraw').json).toEqual({ to: 'mallory.testnet', amount: '500000000' });
    expect(args('raise').json.agent).toBe(state.agent);
  });
  it('the direct token call goes to the token, not the vault', () => expect(args('token').built.receiverId).toBe('usdc.testnet'));
  it('every attempt builds, and ids are unique', () => {
    for (const a of ATTEMPTS) expect(a.build(state, 'mallory.testnet', extra).actions.length).toBe(1);
    expect(new Set(ATTEMPTS.map(a => a.id)).size).toBe(ATTEMPTS.length);
  });
  it('account names are checked', () => { expect(ACCOUNT.test('mallory.testnet')).toBe(true); expect(ACCOUNT.test('Bad Name')).toBe(false); });
});
