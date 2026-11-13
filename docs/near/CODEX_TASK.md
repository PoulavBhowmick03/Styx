I ran your validation workflow from start to finish. These were the inputs:
- the Don'ts list (90 items) and the nine sample proposals from the Drive folder
- the official rules
- the revised SOW
- Raven for rules, technical claims and competitors

The SOW is my own draft, so this is partly a self-review.

1. New proposal verdict

PROJECT: Sidereal: Fixed-Rate Rollover
VERDICT: NEEDS REVISION

Reason
- The scope is clean and concrete: one new contract on testnet, three entry points, proof by transaction hash, and a budget that is engineering time only.
- It isn't ready to submit, for three reasons:
  - the novelty case is crowded
  - there's no evidence that real users want it
  - required fields are still empty

Rules check
- Official SDF rules: no formal violations.
  - Deliverables are concrete and relevant to Stellar (§5).
  - The sprint is 30 days or less, and $4,500 is within the "typically $1,000–$5,000" range (§6).
  - The yield is on USDC, so the SCF ban on promoting yield on XLM doesn't apply.
  - No prohibited category (gambling and similar).
  - Sources: official rules and the SCF submission rules they pull in.
- Official requirement not met yet: §7 asks you to name the Chapter Lead who helped. It's still [TEAM: confirm].
- Don'ts the draft follows:
  - Budget is clean: no hosting, RPC, audit, liquidity or contingency lines, and no past work (#1–21).
  - Testnet only (#36).
  - Uses Soroban's built-in authorization (#50) and Stellar Wallets Kit (#53).
  - Rollover is triggered by the user, with no keeper (#65).
  - No optional deliverables (#67).
  - It's contract work (#59) and new work (#70/#71).

Gaps
- Duplicate or false-gap risk (#56/#57) is high.
  - Spectra is live on mainnet with Blend-USDC fixed-rate markets and an order book.
  - Spield was funded through the same chapter.
  - Principal has $116K and a router in its funded scope.
- The router could read as a trivial integration (#61). It only combines contracts you already have.
- No key-management model (#41). The V2 vault, tokenizer and order book each have one admin key. Spield's approved SOW documented multisig admins plus a 24-hour upgrade timelock; yours documents nothing.
- Public claims contradict the SOW. The site and READMEs still say "live on mainnet" (#36/#38/#72), and the SOW links the site as its demo.
- The repo mentions RWAs as a future yield source at ARCHITECTURE.md:27 (#78).
- The demo video appears as Week 4 work (#17). Say explicitly that it isn't billed.
- No proof of the problem. No named users or integrators.
- Empty fields: contact, dates, XLM wallet, video, legal note.

Strengths
- Testing record: about 230 tests against Spield's claimed ~120.
- Build and audit trail: reproducible builds in CI, deployment records, and an internal review with each fix tracked to a test.
- What Spield doesn't have (checked against Spield's own SOW):
  - Order book: Spield's SOW mentions none.
  - Maturities: Spield is a "single-maturity USDC product", with several maturities left as future scope; you deploy a second maturity in D2.
  - Router: Spield has no router contract.
  - Rollover: Spield never mentions it.
- Lock, exit and roll as single calls that contracts can make: Raven found nothing like this anywhere on Stellar, though not finding it doesn't prove nobody has it.

Budget
- Arithmetic checks out: 80 + 25 + 45 = 150 hours, and $2,400 + $750 + $1,350 = $4,500.
- Rate compared with the samples: $30/hour, against roughly $15.6/hour for approved Spield. Celerity used $30/hour too and was rejected, but for other reasons.
- Effort is plausible for two people over 30 days.

Security (checked against the official docs through Raven)
- Confirmed:
  - require_auth works for contract-account callers.
  - The router can move the user's USDC under the user's own authorization, as a nested call.
  - Archived entries restore automatically from Protocol 23 on, so the note about restoring the retired V1 market's entries needs updating.
- Risk: roll might not fit in one transaction. The docs point to Stellar Lab for live network limits, and mainnet values weren't read. Measure it by simulation in week1.
- Risk: funds pass through the router briefly. Assert that it ends every call with a zero balance.
- Risk: prices can move between quote and trade. Always set min_pt_out and deadline from a fresh quote.
- Risk: a frontend could pass in fake market addresses. The SDK should take markets only from committed deployment manifests.

Feedback, in priority order
1. Name 2–3 integrators. Raven found good candidates:
   - DeFindex: $150K SCF, vaults for fintechs.
   - Pods/Deframe: $125K SCF, a yield API for wallets and fintechs.
   - Zebec: runs enterprise payroll on Stellar.
2. Fix the mainnet wording on the site and in the READMEs.
3. Add a 3–4 line key-management model.
4. Lead with rollover and the integrator use case, and confirm Spectra has no rollover.
5. Fill the empty fields.

Approval estimate (subjective, not an official or statistical probability; confidence low)

┌──────────────────────────────────┬──────────┬───────────┐
│             Version              │ Approval │ Rejection │
├──────────────────────────────────┼──────────┼───────────┤
│ As it stands, with empty fields  │ 10–20%   │ 80–90%    │
├──────────────────────────────────┼──────────┼───────────┤
│ After fixes 2–5, no named users  │ 25–40%   │ 60–75%    │
├──────────────────────────────────┼──────────┼───────────┤
│ With 2 or more named integrators │ 40–55%   │ 45–60%    │
└──────────────────────────────────┴──────────┴───────────┘

2. Historical comparison

The nine samples, judged from their text alone. Outcomes come only from the Drive folder names, and none has validator feedback attached.

Approved
- Spield (Jul8)
  - Blind estimate: 40–60%.
  - Today it would break #36/#38 (mainnet before audit) and #70/#71 (hardening, UI overhaul).
  - Calibration: the closest analogue to Sidereal, and the reason #57 is a risk.
- StelloFi (Jul8)
  - Blind estimate: 15–35%.
  - Its objective, deliverables and budget describe three different pieces of work; it reads partly as a retrospective; and it bills past work and contingency.
  - Calibration: an approval I didn't predict. Weak guidance.
- Cyphras (Mar31)
  - Blind estimate: 45–65%.
  - Breaks #14, #52 and #67, and contradicts itself on scope.
  - Calibration: an early 2026 bar.
- Verivyx (May4)
  - Blind estimate: 35–55%.
  - The PDF is the post-sprint completion version, not what was submitted.
  - Calibration: limited value.
- Salapi (Jun23)
  - Blind estimate: 20–40%.
  - Bills $1,300 for company setup and payment-provider activation, and doesn't explain wallet custody.
  - Calibration: approved where today's list would reject.
- Lumen Liquid (Apr10)
  - Blind estimate: 20–40%.
  - Offers "up to 1000x" leverage and counts architecture design as a deliverable.
  - Calibration: the clearest sign the bar has risen.

Rejected
- Miras (Jul2)
  - Blind estimate: 50–70%.
  - Clean and coherent, yet rejected; the reason isn't visible in the text.
  - Calibration: other factors matter, so don't over-fit.
- Dike (Jul9)
  - Blind estimate: 0–10%.
  - The only confirmed formal violation in the set: betting markets, which fall under the SCF gambling ban.
- Celerity v12 (Aug10)
  - Blind estimate: 10–25%.
  - Its deliverables are a self-review, outreach and pitch materials, and the core cash-out is mocked.

Patterns across the set (small, hand-picked sample)
- A prohibited category is the one reliable rejection signal.
- Deliverables that aren't builds get rejected.
- Approvals ran from March to July; rejections from July to August.
- At least four of the six approved samples would likely fail today's list. The bar has tightened, which is an inference since the list is undated.

3. Evidence and uncertainty

Sources checked
- Program rules: the official rules and SCF Handbook, plus the Don'ts doc and the Drive samples.
- Raven:
  - Scout: Spectra, Principal, XCCY, Etherfuse, DeFindex, Pods
  - Principal's SCF #45 submission
  - Spectra's Certora report
  - the Stellar docs on authorization, state archival and resource limits

Not verified
- Whether Spectra offers rollover on Stellar, and whether its core Stellar contracts were audited.
- The date of Etherfuse's Principal Token page, and whether a USD version exists.
- Whether DeFindex or Pods already offer fixed rates.
- What Spield has shipped since July; its repo returns404.
- Mainnet resource limits.
- Whether the BUDS Act applies.

Missing or conflicting
- No validator feedback for any sample.
- Versions don't match what was submitted for Verivyx, StelloFi and Cyphras.
- Six samples have blank chapter or contact fields, probably redacted, so I didn't count that against them.
- The Don'ts list is undated.
- Raven has no record of Sidereal at all.

The repo copy of the validation report is now out of date against this run. I can rewrite it with these results and push it to sidereal-tech/instawards.