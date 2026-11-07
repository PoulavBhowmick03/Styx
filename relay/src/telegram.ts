// Telegram's Bot API: https://core.telegram.org/bots/api#sendmessage
// No parse_mode is set, so text is delivered literally and cannot inject formatting or links.

import type { Alert, Notify } from "./relay";

export function telegramNotifier(options: {
  botToken: string;
  chatId: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Notify {
  const send = options.fetch ?? fetch;
  const base = options.apiBase ?? "https://api.telegram.org";
  return async (alert: Alert, chatId?: string): Promise<boolean> => {
    const body: Record<string, unknown> = {
      chat_id: chatId ?? options.chatId,
      text: alert.text,
      link_preview_options: { is_disabled: true },
    };
    // The link is always in the text. A button is only added for HTTPS, because Telegram's docs do not
    // say whether it accepts a button to a local address, and a rejected button loses the whole alert.
    if (alert.url?.startsWith("https://")) {
      // Telegram's browser has no wallet, so the first button goes straight to the request in MetaMask.
      // https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/
      const inWallet = `https://link.metamask.io/dapp/${alert.url.slice("https://".length)}`;
      body.reply_markup = {
        inline_keyboard: [
          [{ text: alert.button ?? "Review and sign in MetaMask", url: inWallet }],
          [{ text: "Open in a browser", url: alert.url }],
        ],
      };
    }
    try {
      const response = await send(`${base}/bot${options.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      const result = (await response.json()) as { ok?: boolean };
      return result.ok === true;
    } catch {
      // Errors can contain the request URL, which contains the bot token, so nothing is logged.
      return false;
    }
  };
}
