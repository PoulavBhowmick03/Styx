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

EVM requests with non-null chainId use v2 evm_payment_hash/get_evm_recipient/get_evm_chain.
The page displays the EVM chain, current ERC-20 address and EVM recipient. NEP-413 still signs
for the NEAR vault. The relay/page reject conflicting chain IDs and mixed payment shapes.
A token-configuration change observed on recheck requires a fresh review; configuration is not
frozen by the approval. The asset uses six-decimal formatting.

For the captured v2 fixture and static browser checks, see ../docs/near/APPROVAL_PAGE.md.
After building, serve `npm exec -- vite preview --host 127.0.0.1 --port 5178`, then run
`npm run smoke:evm` in another terminal. CHROME_PATH and APPROVAL_URL override defaults.
