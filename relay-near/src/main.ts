import { dirname, join } from 'node:path';
import { Relay, server } from './relay';
import { Links } from './links';
import { telegramBot, telegramNotifier } from './telegram';
import { Watches, checkVaults, rpcView } from './watches';
const origins=(process.env.ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
const t=process.env;
// Telegram is optional: the bot token, page URL and relay URL together turn it on. Each chat links
// its own approver key with /start; TELEGRAM_CHAT_ID, if set, gets the alerts for unlinked keys.
const tg=t.TELEGRAM_BOT_TOKEN&&t.APPROVAL_PAGE_URL&&t.RELAY_PUBLIC_URL?{botToken:t.TELEGRAM_BOT_TOKEN,pageUrl:t.APPROVAL_PAGE_URL,relayUrl:t.RELAY_PUBLIC_URL}:undefined;
const links=tg?new Links(t.RELAY_LINKS_FILE??(t.RELAY_STATE_FILE?join(dirname(t.RELAY_STATE_FILE),'telegram-links.json'):undefined)):undefined;
// Spend alerts read the chain through NEAR_RPC_URL (view calls only) every WATCH_INTERVAL seconds.
const watches=tg?new Watches(t.RELAY_WATCHES_FILE??(t.RELAY_STATE_FILE?join(dirname(t.RELAY_STATE_FILE),'telegram-watches.json'):undefined)):undefined;
const bot=tg&&links?telegramBot({...tg,links,watches}):undefined;
// Alerts also link to the owner console to freeze the agent: CONSOLE_URL, or /console/ beside the approval page.
const consoleUrl=tg?(t.CONSOLE_URL??new URL('../console/',tg.pageUrl.replace(/\/?$/,'/')).toString()):undefined;
const notify=tg?telegramNotifier({...tg,consoleUrl,chatId:t.TELEGRAM_CHAT_ID,chats:k=>links!.chats(k)}):undefined;
server(new Relay(t.RELAY_TOKEN??'',t.RELAY_STATE_FILE),origins,notify,links&&bot?{links,linked:bot.linked}:undefined)
 .listen(Number(t.PORT??8788),t.HOST??'127.0.0.1',()=>{console.log('NEAR relay listening'+(bot?', Telegram alerts and wallet linking on':''));bot?.start();
  if(bot&&watches){const view=rpcView(t.NEAR_RPC_URL??'https://test.rpc.fastnear.com');const every=Math.max(60,Number(t.WATCH_INTERVAL??300))*1000;
   const pass=()=>checkVaults(watches,view,(chat,text)=>bot.say(chat,text)).catch(()=>{});setInterval(pass,every);void pass();}});
