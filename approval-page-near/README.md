# NEAR approval page

Node 22+. `npm ci`, `npm run dev`, then open
`http://127.0.0.1:5173/?relay=http://127.0.0.1:8788&request=<id>`.
`npm run build` produces static `dist/`; use this folder as the Vercel project root.
`npm test` and `npm run typecheck` check the pure review and signing helpers.

Wallet Selector supports MyNearWallet redirects and Meteor inline signing. Redirect context is
retained in sessionStorage and requires the same tab. Callback URLs are reported exactly as supplied
for signing. The relay cryptographically checks them. The agent must copy signature.callbackUrl
into authorization.callback_url when it submits pay_with_exception.

Chain reads use the supplied RPC and one finalized block. Confirm that RPC, vault and token yourself:
a hostile RPC can fabricate view results. Invoice text is unverified. Six-decimal formatting does not
prove a token is USDC. Daily remaining spend, nonce use and settlement are enforced by the contract.
See ../docs/near/APPROVAL_PAGE.md for tested scope and limitations.
