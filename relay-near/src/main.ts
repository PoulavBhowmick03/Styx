import { dirname, join } from 'node:path';
import { Relay, server } from './relay';
import { Links } from './links';
import { telegramBot, telegramNotifier } from './telegram';
const origins=(process.env.ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
const t=process.env;
// Telegram is optional: the bot token, page URL and relay URL together turn it on. Each chat links
// its own approver key with /start; TELEGRAM_CHAT_ID, if set, gets the alerts for unlinked keys.
const tg=t.TELEGRAM_BOT_TOKEN&&t.APPROVAL_PAGE_URL&&t.RELAY_PUBLIC_URL?{botToken:t.TELEGRAM_BOT_TOKEN,pageUrl:t.APPROVAL_PAGE_URL,relayUrl:t.RELAY_PUBLIC_URL}:undefined;
const links=tg?new Links(t.RELAY_LINKS_FILE??(t.RELAY_STATE_FILE?join(dirname(t.RELAY_STATE_FILE),'telegram-links.json'):undefined)):undefined;
const bot=tg&&links?telegramBot({...tg,links}):undefined;
const notify=tg?telegramNotifier({...tg,chatId:t.TELEGRAM_CHAT_ID,chats:k=>links!.chats(k)}):undefined;
server(new Relay(t.RELAY_TOKEN??'',t.RELAY_STATE_FILE),origins,notify,links&&bot?{links,linked:bot.linked}:undefined)
 .listen(Number(t.PORT??8788),t.HOST??'127.0.0.1',()=>{console.log('NEAR relay listening'+(bot?', Telegram alerts and wallet linking on':''));bot?.start();});
