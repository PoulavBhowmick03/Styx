// Runs the relay from environment variables. See ../README.md.

import { getAddress, isAddress, type Address } from "viem";

import { Relay, type RelayConfig } from "./relay";
import { relayServer } from "./server";
import { telegramNotifier } from "./telegram";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} must be set`);
    process.exit(2);
  }
  return value;
}
function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value, { strict: false })) {
    console.error(`${name} must be an address`);
    process.exit(2);
  }
  return getAddress(value);
}

const port = Number(process.env.RELAY_PORT ?? 8799);
const config: RelayConfig = {
  chainId: BigInt(required("RELAY_CHAIN_ID")),
  vault: address("RELAY_VAULT"),
  owner: address("RELAY_OWNER"),
  token: address("RELAY_TOKEN"),
  pageUrl: required("RELAY_PAGE_URL"),
  relayUrl: process.env.RELAY_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  agentToken: required("RELAY_AGENT_TOKEN"),
  ...(process.env.RELAY_WATCHER_TOKEN ? { watcherToken: process.env.RELAY_WATCHER_TOKEN } : {}),
  maxAlertsPerHour: Number(process.env.RELAY_MAX_ALERTS_PER_HOUR ?? 10),
  maxRequests: Number(process.env.RELAY_MAX_REQUESTS ?? 200),
  ...(process.env.RELAY_STATE_DIR ? { stateDir: process.env.RELAY_STATE_DIR } : {}),
};
const notify = telegramNotifier({
  botToken: required("TELEGRAM_BOT_TOKEN"),
  chatId: required("TELEGRAM_CHAT_ID"),
  ...(process.env.TELEGRAM_API_BASE ? { apiBase: process.env.TELEGRAM_API_BASE } : {}),
});
relayServer(new Relay(config, notify), config).listen(port, process.env.RELAY_HOST ?? "127.0.0.1", () => {
  console.log(`relay listening on port ${port}`);
});
