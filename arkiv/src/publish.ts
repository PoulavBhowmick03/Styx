// Publishes one encrypted grant: tsx src/publish.ts <grant-file>
// Needs ARKIV_PUBLISHER_KEY_FILE (owner-only, holding a hex key) and ARKIV_ACCESS_KEY.

import { readFileSync, statSync } from "node:fs";

import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ArkivAdapterError, EXPIRY_DAYS, grantValues, newLookupTag, VaultGrants } from "./core";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new ArkivAdapterError(`${name} must be set`);
  return value;
}

function loadKey(path: string): Hex {
  if (statSync(path).mode & 0o077) throw new ArkivAdapterError("the publisher key file must be owner-only");
  const text = readFileSync(path, "utf8").trim();
  return (text.startsWith("0x") ? text : `0x${text}`) as Hex;
}

async function main(): Promise<void> {
  const [grantFile] = process.argv.slice(2);
  if (!grantFile) throw new ArkivAdapterError("usage: publish <grant-file>");
  const lookupTag = newLookupTag();
  // Checks the size before touching a key or the network.
  const values = grantValues(readFileSync(grantFile), lookupTag);
  const account = privateKeyToAccount(loadKey(required("ARKIV_PUBLISHER_KEY_FILE")));
  const client = createWalletClient({
    chain: rabdi({ accessKey: required("ARKIV_ACCESS_KEY") }),
    transport: http(),
    account,
  });
  const { entityKey, txHash, expiresAt } = await client.createEntity(VaultGrants, values, {
    expiration: ExpirationTime.fromDays(EXPIRY_DAYS),
  });
  console.log(
    JSON.stringify({ lookupTag, writer: account.address, entityKey, txHash, expiresAt: expiresAt.toString() }, null, 2),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof ArkivAdapterError ? error.message : "publishing failed; the local grant is unaffected");
  process.exit(1);
});
