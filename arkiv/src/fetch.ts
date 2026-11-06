// Fetches one encrypted grant with no other process running:
//   tsx src/fetch.ts <lookup-tag> <writer-address> <output-file>
// The writer comes from the issuer, separately from the tag. ARKIV_ACCESS_KEY is optional; without
// it the SDK uses Arkiv's rate-limited public RPC.

import { writeFileSync } from "node:fs";

import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";

import { ArkivAdapterError, assertLookupTag, assertWriter, lookupFilter, selectGrant, VaultGrants } from "./core";

async function main(): Promise<void> {
  const [lookupTag, writer, output] = process.argv.slice(2);
  if (!lookupTag || !writer || !output) throw new ArkivAdapterError("usage: fetch <lookup-tag> <writer> <output-file>");
  assertLookupTag(lookupTag);
  assertWriter(writer);
  const client = createPublicClient({
    chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }),
    transport: http(),
  });
  const { entities } = await client
    .select({ ciphertext: true })
    .from(VaultGrants)
    .where(lookupFilter(lookupTag))
    .ownedBy(writer)
    .fetch();
  const grant = selectGrant(entities);
  // `wx` refuses to replace a file. The verifier requires owner-only grants.
  writeFileSync(output, grant, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ saved: output, bytes: grant.length }));
}

main().catch((error: unknown) => {
  console.error(error instanceof ArkivAdapterError ? error.message : `fetching failed: ${String(error)}`);
  process.exit(1);
});
