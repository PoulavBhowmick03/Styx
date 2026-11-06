# How we use Arkiv

| Feature | Setting | Fits because | What the user sees |
| --- | --- | --- | --- |
| Filters | `lookupTag` plus `ownedBy` | One record per lookup. The writer filter stops anyone else answering under our schema | The reviewer gets exactly one grant or a clear refusal |
| Edit permissions | Entities are never updated | A grant is signed once, and a changed one would fail to open | Nothing to edit |
| Expiry | 7 days | Long enough for a review, and old ciphertext does not stay public longer than needed | After expiry the fetch reports nothing found, which is never read as unpaid. The issuer still holds a local copy |
| Size limit | Refuses over 128 KiB before signing a transaction | Grants above the limit would fail anyway | A clear error and the local-copy route |

**Status:** the publish path has not run against the testnet yet, because it needs a funded publisher key and an access key. The fetch path has run against Rabdi's public RPC and correctly reported no match for a random tag.
