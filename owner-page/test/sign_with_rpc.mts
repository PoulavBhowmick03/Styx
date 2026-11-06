// Runs the page's review and signature checks with an RPC node standing in for the wallet:
//   tsx test/sign_with_rpc.mts <owner-config> <pending-file> <rpc-url> <output-file>
import { readFileSync, writeFileSync } from "node:fs";

import { buildSignatureFile, parseOwnerConfig, parsePending, reviewPending, typedDataRequest } from "../src/approval";

const [configFile, pendingFile, rpc, output] = process.argv.slice(2) as [string, string, string, string];
const config = parseOwnerConfig(JSON.parse(readFileSync(configFile, "utf8")));
const pending = parsePending(JSON.parse(readFileSync(pendingFile, "utf8")));
reviewPending(pending, config, BigInt(Math.floor(Date.now() / 1000)));
const response = await fetch(rpc, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_signTypedData_v4", params: [config.owner, typedDataRequest(pending)] }),
});
const body = (await response.json()) as { result?: `0x${string}`; error?: unknown };
if (!body.result) throw new Error(`the node refused to sign: ${JSON.stringify(body.error)}`);
writeFileSync(output, await buildSignatureFile(pending, config, body.result));
