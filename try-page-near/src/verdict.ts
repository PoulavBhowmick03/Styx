// Reads an RPC reply to a sent transaction and says who decided: the vault paid, the vault refused
// (the transaction is on chain as a failure), or NEAR rejected it before any block (no transaction).
import type { RpcReply } from './near';

export type Verdict = { kind: 'paid' | 'vault' | 'near' | 'other'; label: string; text: string; onChain: boolean };

const VAULT_REFUSALS: Record<string, string> = {
  PerPaymentLimitExceeded: 'The amount is over the per-payment limit, and there is no approver signature.',
  DailyLimitExceeded: "The agent's daily limit is used up, or this payment would pass it. Visitors share this key, so earlier payments today count.",
  VaultDailyLimitExceeded: "The vault's daily limit is used up, or this payment would pass it.",
  RecipientNotAllowed: 'The owner has not allowed this recipient.',
  VaultPaused: 'The owner has paused the vault.',
  PolicyExpired: "The agent's policy has expired.",
  PaymentAlreadyUsed: 'This payment id has already been paid.',
  NotAgent: 'The signing key is not an enabled agent of this vault.',
  ApproverNotAllowed: 'The signer of the approval is not an approver of this vault.',
  PaymentHashMismatch: 'The approval was signed for a different payment.',
};
const KEY_REFUSALS: Record<string, (detail: any) => string> = {
  MethodNameMismatch: d => `This key may not call ${d?.method_name ?? 'that method'}. NEAR checks the key's method list before the contract runs.`,
  ReceiverMismatch: d => `This key may only call the vault, not ${d?.tx_receiver ?? 'another account'}.`,
  RequiresFullAccess: () => 'This key may only make function calls. Moving NEAR, adding keys and replacing code need a full-access key, and the vault has none.',
  DepositWithFunctionCall: () => 'A function-call key cannot attach NEAR to a call.',
  NotEnoughAllowance: () => "The key's gas allowance is spent. NEAR stops the key until the owner installs it again.",
  AccessKeyNotFound: () => 'This key is not on the vault account. The owner has removed or not yet installed it.',
};

function find(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  if (name in (value as object)) return (value as Record<string, unknown>)[name];
  for (const inner of Object.values(value as object)) { const hit = find(inner, name); if (hit !== undefined) return hit; }
  return undefined;
}

export function verdict(reply: RpcReply, method = 'pay'): Verdict {
  if (reply.error) {
    const keyError = find(reply.error.data, 'InvalidAccessKeyError');
    if (keyError !== undefined) {
      const name = typeof keyError === 'string' ? keyError : Object.keys(keyError as object)[0];
      const detail = typeof keyError === 'string' ? undefined : (keyError as Record<string, unknown>)[name];
      return { kind: 'near', label: `REJECTED by NEAR: ${name}`, onChain: false,
        text: (KEY_REFUSALS[name]?.(detail) ?? 'NEAR does not let this key send that transaction.') + ' It was never included in a block.' };
    }
    return { kind: 'other', label: 'NOT SENT', onChain: false, text: `The RPC did not accept the transaction: ${reply.error.cause?.name ?? reply.error.name ?? 'error'}.` };
  }
  const status = reply.result?.status;
  if (status && 'Failure' in status) {
    const text = JSON.stringify(status.Failure);
    const panic = /Smart contract panicked: ([A-Za-z0-9]+)/.exec(text)?.[1];
    if (panic && VAULT_REFUSALS[panic]) return { kind: 'vault', label: `REFUSED by the vault: ${panic}`, text: VAULT_REFUSALS[panic], onChain: true };
    const missing = /MethodNotFound|MethodResolveError/.test(text);
    return { kind: 'vault', label: 'FAILED on chain', onChain: true,
      text: missing ? 'The contract has no such method.' : panic ? `The contract refused: ${panic}.` : 'The contract could not run this call (for example, arguments it cannot read).' };
  }
  if (status && 'SuccessValue' in status) {
    const value = atob(status.SuccessValue);
    if (method.startsWith('pay') && value === 'false') return { kind: 'vault', label: 'ROLLED BACK', onChain: true, text: 'The vault accepted the payment but the token transfer failed, so it undid the payment.' };
    if (method.startsWith('pay')) return { kind: 'paid', label: 'PAID, within the limits', onChain: true, text: 'The vault checked the limits and the recipient, and transferred the tokens.' };
    return { kind: 'other', label: 'DONE', onChain: true, text: 'The call ran.' };
  }
  return { kind: 'other', label: 'UNKNOWN', onChain: false, text: 'No final answer yet. Check the explorer.' };
}
