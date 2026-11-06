// Fetches one encrypted grant with no other process running:
//   tsx src/fetch.ts <lookup-tag> <writer-address> <output-file>
// The writer comes from the issuer, separately from the tag. ARKIV_ACCESS_KEY is optional; without
// it the SDK uses Arkiv's rate-limited public RPC.
// Exit codes: 1 usage, 3 nothing found, 4 Arkiv unreachable, 5 malformed data. None of them means unpaid.

import { writeFileSync } from "node:fs";

import { ArkivAdapterError, assertLookupTag, assertWriter, exitCodeFor, redacted } from "./core";
import { readGrant } from "./read";

async function main(): Promise<void> {
  const [lookupTag, writer, output] = process.argv.slice(2);
  if (!lookupTag || !writer || !output) throw new ArkivAdapterError("usage: fetch <lookup-tag> <writer> <output-file>");
  assertLookupTag(lookupTag);
  assertWriter(writer);
  const grant = await readGrant(lookupTag, writer, process.env.ARKIV_ACCESS_KEY ?? "");
  // `wx` refuses to replace a file. The verifier requires owner-only grants.
  writeFileSync(output, grant, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ saved: output, bytes: grant.length }));
}

main().catch((error: unknown) => {
  console.error(error instanceof ArkivAdapterError ? error.message : `Arkiv could not be read, which says nothing about the payment: ${redacted(error)}`);
  process.exit(exitCodeFor(error));
});
