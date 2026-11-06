// The one read both the reviewer's fetch and the publisher's read-back use.

import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http, type Address } from "viem";

import { lookupFilter, selectGrant, VaultGrants } from "./core";

export async function readGrant(lookupTag: string, writer: Address, accessKey = ""): Promise<Uint8Array> {
  const client = createPublicClient({ chain: rabdi({ accessKey }), transport: http() });
  const { entities } = await client
    .select({ ciphertext: true })
    .from(VaultGrants)
    .where(lookupFilter(lookupTag))
    .ownedBy(writer)
    .fetch();
  return selectGrant(entities);
}
