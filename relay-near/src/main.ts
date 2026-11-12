import { Relay, server } from './relay';
server(new Relay(process.env.RELAY_TOKEN??'',process.env.RELAY_STATE_FILE)).listen(Number(process.env.PORT??8788),'127.0.0.1',()=>console.log('NEAR relay listening'));
