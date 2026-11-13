# The /try page: the agent's key, published on purpose

`try-page-near/` is a static page for `styxco.xyz/try/`. It holds the function-call key of one demo
vault and signs transactions with it in the visitor's browser, so anyone can see what the vault and
NEAR let that key do. No wallet is involved. It is built only when the settings below are present.

## Set it up

1. `OWNER=<your testnet account> scripts/near/try_setup.sh` creates `try.styx-vaults.testnet` through
   the factory (4 NEAR), funds it with test tokens, makes the agent key in `~/.styx-near/try/` and
   installs it with 1 tUSDC per payment and 20 per day, valid 30 days. It writes
   `~/.styx-near/try/try.env`. Run it again to top up or re-apply the limits.
2. `set -a; . ~/.styx-near/try/try.env; set +a; scripts/build_site.sh`, then deploy `dist/styx-site`.
   The key goes into the built page, never into the repo.
3. Locally: load the same settings and run `npm run dev` in `try-page-near/` (port 5175).

When the key's gas allowance (0.25 NEAR) runs out, NEAR stops the key and the page says so. Disable
and enable the agent from the console, or run the setup script again after disabling it.

## What each button sends

| Button | Transaction | Who answers |
| --- | --- | --- |
| Pay inside the limit | `pay`, half the per-payment limit, to the allowed recipient | the vault pays, or refuses with its daily limit |
| Pay over the limit | `pay`, the limit plus one base unit | the vault: `PerPaymentLimitExceeded` |
| Pay a stranger | `pay` to the account in the box | the vault: `RecipientNotAllowed` |
| Raise my own limit, Make myself an approver, Allow the stranger, Withdraw everything | `configure_agent`, `set_approver`, `set_recipient`, `withdraw` | NEAR: `MethodNameMismatch`, no transaction |
| Move the tokens directly | `ft_transfer` on the token contract | NEAR: `ReceiverMismatch` |
| Send the vault's NEAR, Add a full-access key | `Transfer`, `AddKey` | NEAR: `RequiresFullAccess` |
| Anything else | any method and arguments on any contract | whatever comes back |

## What ran (13 Nov 2026, NEAR testnet)

Against a development vault, `judge-9770.styx-vaults.testnet` (created through the factory, owner
`styx-judge-65456f.testnet`, set up by `try_setup.sh`), with the page served locally and every
button clicked in a browser:

| Attempt | Result | Transaction |
| --- | --- | --- |
| Pay 0.5 tUSDC to vendor-a | paid | [5wSVuXA4…](https://testnet.nearblocks.io/txns/5wSVuXA4ipMB8dh8AjqitHiW8xksAAtfvV2W2fe2eCj6) |
| Pay 1.000001 tUSDC | vault: `PerPaymentLimitExceeded` | [JCfb9h4d…](https://testnet.nearblocks.io/txns/JCfb9h4dhumfTWsLgRLxrpz95SDrd5DErtuYvQ8CZQmS) |
| Pay `stranger.testnet` | vault: `RecipientNotAllowed` | [Yw13N26n…](https://testnet.nearblocks.io/txns/Yw13N26nxUvXYCgUugD1GV3zWtf6a5Xf92ttqbp4eLT) |
| `configure_agent`, `set_approver`, `set_recipient`, `withdraw`, and `pause` from the free-form box | NEAR: `MethodNameMismatch` | none |
| `ft_transfer` on the token | NEAR: `ReceiverMismatch` | none |
| `Transfer`, `AddKey` | NEAR: `RequiresFullAccess` | none |

The agent's policy read version 1 before and after. The RPC's replies from this run are the test
fixtures in `try-page-near/src/fixtures.json`.

Not yet run: the page on `styxco.xyz` with the team's own vault; two visitors sending at the same
moment (the page retries a nonce another transaction took, which has only been read, not exercised).

## Checks

`cd try-page-near && npm test && npm run typecheck`: 18 tests. `near.test.ts` compares the
transaction bytes with an encoding written out by hand and verifies the signature; `verdict.test.ts`
reads the real replies above. The signing code is `src/near.ts` (about 100 lines) and is for
Poulav's review like any other.
