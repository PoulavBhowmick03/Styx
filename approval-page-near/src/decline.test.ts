import { describe, expect, it } from 'vitest';
import { declineMessage, DECLINE_RECIPIENT, pendingSchema } from './protocol';
import * as relay from '../../relay-near/src/protocol';
import { fixture } from './fixture';

describe('declining a request', () => {
  it('signs exactly the message and recipient the relay checks', () => {
    const p = pendingSchema.parse(fixture());
    expect(declineMessage(p)).toBe(relay.declineMessage(p as never));
    expect(DECLINE_RECIPIENT).toBe(relay.DECLINE_RECIPIENT);
  });
  it('names the payment, amount, recipient and vault, and is never addressed to a vault', () => {
    const p = pendingSchema.parse(fixture());
    const m = declineMessage(p);
    for (const part of [p.payment.payment_id, p.payment.amount, String(p.payment.recipient), p.vault]) expect(m).toContain(part);
    expect(DECLINE_RECIPIENT).not.toBe(p.vault);
  });
});
