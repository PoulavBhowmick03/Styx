# Arkiv schema

One entity type, written through the named schema `vault.payment-grant`.

| Field | Type | Indexed | Purpose |
| --- | --- | --- | --- |
| `app` | `str` | Yes | Always `vault-payment-records` |
| `schemaVersion` | `str` | Yes | Always `1` |
| `lookupTag` | `str` | Yes | 128 random bits as hex, shared with the reviewer |
| `ciphertext` | `bytes` | No | The encrypted, signed grant for one reviewer, up to 128 KiB |

**Fields queried:** `lookupTag`, with the schema tag and the writer (`ownedBy`).

**Owner:** the publisher key that created the entity. Anyone can write under this schema's names, so a reader must filter by the writer address the issuer gave them.

**Expiry:** 7 days after creation, set with `ExpirationTime.fromDays(7)`. It is not extended.
