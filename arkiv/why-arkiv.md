# Why Arkiv

**What a conventional database would cost.** A reviewer would depend on a server we run staying up and on us not changing what it returns. With Arkiv, the reviewer fetches the encrypted record with every one of our processes stopped, from a public network, filtered by a writer address they were given.

The record's integrity does not come from Arkiv. The grant is signed and the payment is checked against Arc, so a wrong answer from Arkiv fails verification. Arkiv provides availability without us.

**What stays off Arkiv, and why:**

- **Plaintext invoices, approvals and salts.** Arkiv entities are public, so only ciphertext goes there.
- **Keys and any link to a payment.** The lookup tag is random, so an entity alone does not name a payment, vendor or owner.
- **Settlement state.** Arc is the source of truth. Payment never depends on an Arkiv write, and a local copy of the grant always exists.
