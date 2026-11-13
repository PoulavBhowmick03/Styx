# Real-wallet test: the approval page and the owner console

Two things have never been done with a real wallet: an approver signing on the approval page, and
the owner using the owner console. This is the script to do both, in about 20 minutes. Everything
is NEAR testnet. Use **Meteor Wallet**: the browser extension on a laptop, or the Meteor app on a
phone. The pages are live at `https://styxco.xyz/approval/` and `https://styxco.xyz/console/`.

The terminal side is `scripts/near/wallet_test.sh`. It was run on 13 Nov 2026 with the test signer
standing in for the wallet: a NEAR and a Base exception both settled through the relay. What's left
is exactly the browser and wallet step.

## 0. Set up (once)

```sh
cd ~/Developer/Styx-near
cargo build --release --manifest-path sdk/near/Cargo.toml   # the agent CLI, if not built
(cd approval-page-near && npm ci)
(cd owner-console-near && npm ci)
```

Have a **testnet** account in a browser wallet on the laptop. Poulav's is `poulav.testnet`, which
lives in a mobile wallet: export its recovery phrase (or private key) from the phone wallet and
import it into the **Meteor** extension (testnet) in the laptop browser, or use the Meteor app on the
phone. A phone can't open the local pages: `localhost` is the laptop, and over plain
http on a LAN address the browser blocks `crypto.randomUUID()`, which the page needs. The phone
works once the page is deployed on https.

Already done for `poulav.testnet` on 13 Nov 2026: funded with 2 testnet NEAR, and its full-access key
`ed25519:mA3qigk1SJQ85o3RGcd32hEHoGM6bjDCvjekyQtNZ2N` registered as an approver on both vaults
(steps A1 and A2). Start at A3 with that key.

Open three terminals:

| Terminal | Command | Leave it running |
| --- | --- | --- |
| 1, relay | `scripts/near/wallet_test.sh relay` | yes |
| 2, approval page | `cd approval-page-near && npm run dev` (it prints `http://localhost:5173`) | yes |
| 3, you | everything below | |

## A. The approval page with your wallet

**A1. Find your wallet's key** (done for poulav.testnet). The vault only accepts signatures from a key the owner registered.
In terminal 3:

```sh
near account list-keys <your-account>.testnet network-config testnet-fastnear now
```

Copy the `full access` key (`ed25519:…`). If there are several, use any one; step A4 tells you if the
wallet signed with another, and shows which.

**A2. Register it as an approver** (done for poulav.testnet) (the owner signs this from your CLI keychain, on both vaults):

```sh
scripts/near/wallet_test.sh approver ed25519:<your key>
```

Expect `succeeded` twice and `{"enabled":true,"version":1}` for both vaults.

**A3. The agent asks you to approve a NEAR payment** (120 tUSDC, over the 100 limit):

```sh
scripts/near/wallet_test.sh request near ed25519:<your key>
```

It prints a URL like `http://localhost:5173/?relay=http://127.0.0.1:8788&request=…`.

**A4. Approve it in the browser.** Open the URL.
- The page should show the payment read back from the chain: 120 tUSDC to
  `vendor-a.styx-owner-c87a.testnet`, the 100 per-payment limit it exceeds, the daily limit that
  still applies, your key as the approver, and that the payment hash and message match the chain.
  **If it reports any mismatch, stop and note it**: that is a finding.
- Click sign, choose Meteor, approve the message in the wallet.
- Expect "posted" (or similar). If it says the wallet used a different key, it shows that key:
  run A2 with it and start A3 again.

**A5. Settle it:**

```sh
scripts/near/wallet_test.sh submit
```

Expect `signature from <your-account>.testnet ed25519:…` and then `{"state":"settled",…}`. Open the
transaction on testnet.nearblocks.io: the `payment_executed` event should show `"exception":true` and
your key as `signer`.

**A6. The same on another chain** (6 USDC on Base, over vault-v2's 5 limit):

```sh
scripts/near/wallet_test.sh request base ed25519:<your key>
```

Open the URL, check the page shows **chain 84532**, the Base USDC token and the `0xf4D8…07cc`
address, sign, then `scripts/near/wallet_test.sh submit`. Expect `settled` with a `0x…` Base hash
(check it on sepolia.basescan.org). `request arc` does the same on Arc.

**What to note, either way:** which wallet, whether the page's read-back matched, whether signing
worked inline in Meteor, any error text, and the transaction ids. Paste
them to Claude and they go into `TESTNET_RUN.md`.

## B. The owner console with the owner account

The console only lets the vault's owner write. The owner is `styx-owner-c87a.testnet`, whose key is
in your near CLI keychain. For this test, import it into Meteor (testnet only):

```sh
cat ~/.near-credentials/testnet/styx-owner-c87a.testnet.json   # shows the private_key; don't paste it anywhere else
```

In Meteor: add account, import with private key, paste the `private_key` value. Then:

```sh
cd owner-console-near && npm run dev    # prints http://localhost:5174 if the approval page holds 5173
```

Open `http://localhost:5174/?vault=vault.styx-owner-c87a.testnet` and connect Meteor with the owner
account.

**B1. Read-back.** Check against what you know: token `usdc.styx-owner-c87a.testnet`, not paused, the
vault's daily limit, today's spend, the vault's tUSDC balance. The agent key
`ed25519:4D9Pbrvn…DwXn` should show its limits, the pay-only method list and its gas allowance. The
payments table may say the indexer is unavailable: that is expected on testnet, not a failure.

**B2. One harmless write.** In "Change rules", `set_recipient` with recipient `wallet-test.testnet`,
allowed. Check the JSON preview, sign in Meteor, and confirm the console re-reads it from the chain
(allowed, version 1). Then do the same with allowed off (version 2).

**B3. Pause and resume.** Pause the vault, sign. In terminal 3, try a payment inside the limits:

```sh
set -a; . ~/.styx-near/demo.env; set +a
printf 'pause test\n' > $STYX_NEAR_STATE_ROOT/pause.txt
echo "{\"method\":\"propose\",\"recipient\":\"vendor-a.styx-owner-c87a.testnet\",\"amount\":\"1000000\",\"invoice_file\":\"$STYX_NEAR_STATE_ROOT/pause.txt\",\"invoice_reference\":\"pause\",\"valid_until\":$(( $(date +%s) + 3600 ))}" | sdk/near/target/release/styx-near-vault
```

Expect `POLICY_LIMIT` / "vault is paused". Then unpause in the console and run the same command:
it should propose normally.

**B4. Afterwards,** remove the owner account from Meteor if you don't want its key in the browser.

## What not to do on camera

Don't show `~/.near-credentials`, `~/.styx-near/`, the relay token or the `cat` output in B. Record
part A from step A3 on.

## On a phone with the Meteor app

No documented link opens a page inside the Meteor app, so Telegram cannot launch the app straight to
the request. The pages include both Meteor modules: the web and extension one, and the in-app one
(`@near-wallet-selector/meteor-wallet-app`), which signs through the Meteor app natively when the page
is opened inside the app's own browser. So on a phone:

1. In the Telegram alert, copy the link.
2. Open it inside the **Meteor app's browser**; connect, choose Meteor, and approve in the app.
3. If that is not available, tapping the button opens the page in Telegram or the phone browser,
   which falls back to Meteor's web wallet (`wallet.meteorwallet.app`) in a popup.

Note which path worked and paste it to Claude.
