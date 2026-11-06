# World integration debrief

**Status:** the backend and page gate are built and tested against a local fake identity provider. They have **not** completed a flow with World, because registering a client needs a person to sign in to the developer portal.

World's Mumbai proofs are mocked and use fake identities. Do not rely on this gate for production. The contract never checks World: the owner's signature is what authorizes a payment.

| Question | Answer |
| --- | --- |
| Time to first success | Not reached yet |
| Friction | The sandbox guide URL we tried (`/docs/guides/sandbox`) returned only a loading screen when fetched. The prize page says "Agent Pass", while the docs describe OIDC step-up and do not use that name on their main page. The registration guide requires HTTPS callbacks and does not say whether `localhost` is allowed, so a local page may need a tunnel |
| Missing docs | No code samples in the OIDC guide, and `acr` values are not listed there. We read them from the live discovery document |
| Biggest improvement | One complete step-up example, from authorization request to ID token checks |

Update this file with measured results after the first real run.
