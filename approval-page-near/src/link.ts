// Link mode (?link=<code>): the wallet signs linkMessage(code) so the relay sends this key's approval
// alerts to the Telegram chat that asked for the code. Not a transaction; nothing here touches a vault.
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet';
import { setupMeteorWalletApp } from '@near-wallet-selector/meteor-wallet-app';
import { summary, text, showDetails } from './ui';
import { LINK_RECIPIENT, linkCode, linkMessage, linkNonce, linkSchema } from './protocol';

// Wallet Selector wants a contract for sign-in; signMessage does not use it. The demo vault is the
// default so the wallet shows a familiar name; VITE_SIGNIN_CONTRACT overrides it.
const SIGNIN_CONTRACT = import.meta.env.VITE_SIGNIN_CONTRACT ?? 'vault.styx-owner-c87a.testnet';
const NETWORK = import.meta.env.VITE_NEAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';

type Elements = { title: Element; status: Element; details: Element; connect: HTMLButtonElement; sign: HTMLButtonElement };

export async function linkFlow(code: string, relay: URL, el: Elements, error: (e: unknown) => void) {
  if (!linkCode.safeParse(code).success) throw new Error('Invalid link. Send /start to the Styx bot for a new one.');
  document.title = 'Styx: link Telegram alerts';
  el.title.textContent = 'Link your wallet to Telegram';
  text('eyebrow', 'TELEGRAM ALERTS');
  text('lead', 'Sign a message so Styx sends approval alerts for your key to your Telegram chat. It is not a transaction and cannot move funds or approve a payment.');
  text('footer', 'Alerts come only for payments that ask this key to approve. Send /unlink to the bot to stop them.');
  summary([['Relay', relay.host], ['Network', NETWORK], ['Link expires', '15 minutes after /start']]);
  showDetails(`Message you will sign:\n${linkMessage(code)}\n\nNEP-413 recipient: ${LINK_RECIPIENT}`);
  const selector = await setupWalletSelector({ network: NETWORK, modules: [setupMeteorWallet(), setupMeteorWalletApp({ contractId: SIGNIN_CONTRACT })] });
  const modal = setupModal(selector, { contractId: SIGNIN_CONTRACT });
  el.connect.hidden = false; el.sign.hidden = false; el.sign.textContent = 'Sign link message';
  el.status.textContent = 'Connect the wallet whose key approves payments, then sign.';
  el.connect.onclick = () => modal.show();
  el.sign.onclick = async () => {
    el.sign.disabled = true;
    try {
      const wallet = await selector.wallet();
      const result = await wallet.signMessage({ message: linkMessage(code), nonce: linkNonce(code), recipient: LINK_RECIPIENT });
      if (!result) return;
      const body = linkSchema.parse({ schema: 'styx-near-telegram-link/1', code, accountId: result.accountId, publicKey: result.publicKey, signature: result.signature });
      const r = await fetch(new URL('/links', relay), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`Relay refused the link (${r.status}): ${((await r.json().catch(() => ({}))) as { error?: string }).error ?? ''}`);
      el.status.classList.remove('error'); el.status.textContent = `Linked. Telegram alerts for ${result.publicKey} will come to your chat. Send /unlink to the bot to stop them.`;
      el.sign.hidden = true; el.connect.hidden = true;
    } catch (e) { error(e); } finally { el.sign.disabled = false; }
  };
}
