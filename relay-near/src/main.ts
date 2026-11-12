import { Relay, server } from './relay';
const origins=(process.env.ALLOWED_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
server(new Relay(process.env.RELAY_TOKEN??'',process.env.RELAY_STATE_FILE),origins).listen(Number(process.env.PORT??8788),process.env.HOST??'127.0.0.1',()=>console.log('NEAR relay listening'));
