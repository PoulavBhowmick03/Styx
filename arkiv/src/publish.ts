// Publishes one encrypted grant: tsx src/publish.ts <grant-file>
// Needs ARKIV_PUBLISHER_KEY_FILE (owner-only, holding a hex key) and ARKIV_ACCESS_KEY.

import { readFileSync, statSync } from "node:fs";

import { createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { ArkivAdapterError, EXPIRY_DAYS, grantValues, newLookupTag, redacted, sameBytes, VaultGrants } from "./core";
import { readGrant } from "./read";

const READ_BACK_ATTEMPTS = 6;
const READ_BACK_WAIT_MS = 2000;

/** The write is only reported as readable once the same bytes come back. Indexing may lag the receipt. */
async function readsBack(grant: Uint8Array, lookupTag: string, writer: Hex, accessKey: string): Promise<boolean> {
  for (let attempt = 0; attempt < READ_BACK_ATTEMPTS; attempt += 1) {
    try {
      return sameBytes(await readGrant(lookupTag, writer, accessKey), grant);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, READ_BACK_WAIT_MS));
    }
  }
  return false;
}

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
  const grant = readFileSync(grantFile);
  const values = grantValues(grant, lookupTag);
  const account = privateKeyToAccount(loadKey(required("ARKIV_PUBLISHER_KEY_FILE")));
  const accessKey = required("ARKIV_ACCESS_KEY");
  const client = createWalletClient({
    chain: rabdi({ accessKey }),
    transport: http(),
    account,
  });
  const { entityKey, txHash, expiresAt } = await client.createEntity(VaultGrants, values, {
    expiration: ExpirationTime.fromDays(EXPIRY_DAYS),
  });
  const readBack = await readsBack(grant, lookupTag, account.address, accessKey);
  console.log(
    JSON.stringify({ lookupTag, writer: account.address, entityKey, txHash, expiresAt: expiresAt.toString(), readBack }, null, 2),
  );
  if (!readBack) throw new ArkivAdapterError("the entity was written but the same bytes did not read back");
}

main().catch((error: unknown) => {
  console.error(error instanceof ArkivAdapterError ? error.message : `publishing failed; the local grant is unaffected: ${redacted(error)}`);
  process.exit(1);
});
