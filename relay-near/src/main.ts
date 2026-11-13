import { Relay, server } from './relay';
import { telegramNotifier } from './telegram';
const origins=(process.env.ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
const t=process.env;
// Telegram is optional: all four values set turns alerts on; any missing leaves them off.
const notify=t.TELEGRAM_BOT_TOKEN&&t.TELEGRAM_CHAT_ID&&t.APPROVAL_PAGE_URL&&t.RELAY_PUBLIC_URL
 ?telegramNotifier({botToken:t.TELEGRAM_BOT_TOKEN,chatId:t.TELEGRAM_CHAT_ID,pageUrl:t.APPROVAL_PAGE_URL,relayUrl:t.RELAY_PUBLIC_URL}):undefined;
server(new Relay(t.RELAY_TOKEN??'',t.RELAY_STATE_FILE),origins,notify).listen(Number(t.PORT??8788),t.HOST??'127.0.0.1',()=>console.log('NEAR relay listening'+(notify?', Telegram alerts on':'')));
