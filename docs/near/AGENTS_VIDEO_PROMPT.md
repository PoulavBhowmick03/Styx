# Prompt: a 30-second motion-graphics video for Styx Agents

Paste everything below the line into Claude Code, run from the repo root.

---

Make a 30-second motion-graphics video that explains **Styx Agents**: watcher agents that guard an AI
agent's wallet on NEAR and can only hit the brakes. It must hook a viewer scrolling X in the first
2 seconds, look premium, and land the idea with no voice-over. Music and sound design carry the
energy; on-screen text carries the story, because X autoplays muted.

## Naming

- **Styx Agents** are the watchers. In the code and docs they are "sentinels".
- The thing being guarded is "your AI agent" or "the hijacked agent". Never call it a Styx Agent.
- The three Styx Agents:
  - **Burst**: too many payments, too fast.
  - **Concentration**: one recipient taking too much.
  - **Judge**: a model on NEAR AI Cloud that reads the payments.

## Build

- **Remotion** (React + TypeScript), in `video/styx-agents/`. Add `video/**/node_modules` and
  `video/**/out` to .gitignore.
- Two compositions, 30 fps, 900 frames each, rendered to H.264 MP4 in `video/styx-agents/out/`:
  - landscape 1920×1080;
  - vertical 1080×1920. Re-lay it out; don't crop it.
- A thumbnail PNG of the "PAUSED" frame.
- Pin exact package versions.
- Everything is drawn in code: SVG and divs animated with `interpolate` and `spring`. No stock
  footage, no AI images, no third-party logos.

## Brand (from site/styx.css, use these exact values)

- **Colours:**

  | Role | Value | Use |
  | --- | --- | --- |
  | Ground | `#0b0a09` | background |
  | Panel | `#131110` | |
  | Panel 2 | `#1a1716` | |
  | Rule | `#26211f` | |
  | Rule 2 | `#3a312d` | |
  | Text | `#f2ede6` | |
  | Muted text | `#9d958d` | |
  | Ember | `#fb4020` | the danger and brake colour |
  | Ok | `#7ddba0` | "within limits", "live" |
  | Wait | `#ffc46b` | |

- **Fonts:** self-hosted from `site/public/fonts/`; load them with `@remotion/fonts` or `@font-face`.
  - Instrument Serif, including italic, for headlines. The site's voice is a serif headline with one
    ember italic phrase, as in "Watchers that can only *hit the brakes.*"
  - Geist for body text.
  - Geist Mono for labels, amounts, hashes and small uppercase kickers with wide letter-spacing.
- **Logo:** `site/public/styx-logo.png`.
- **Style rules from the site:**
  - No symbol glyphs: no check marks, crosses, arrows or emoji. State is always a word: "PAID",
    "WITHIN LIMITS", "PAUSED", "REFUSED".
  - Thin 1 px rules, 4 px radii, generous negative space, dark and calm until the brake moment.
- **Motion language:**
  - Smooth eased moves using the site's curve `cubic-bezier(0.2, 0.7, 0.2, 1)`.
  - Mono labels typing on.
  - Payment "tokens": small pills that read "1 tUSDC".
  - A subtle film grain and a slow drifting ember glow in the background.
  - The single hard cut and freeze comes at the pause.

## Story, beat by beat (frames at 30 fps)

1. **0–2 s (0–60), hook.** Black, then one line types on in serif: "Your AI agent has a wallet."
   Hard cut to ember: "*It just got hijacked.*" A heartbeat thump.
2. **2–8 s (60–240), the drain.**
   - Centre: a vault (a rounded panel labelled `sentinels.styx-vaults.testnet` in mono).
   - Right: a recipient labelled `drain`.
   - Pills fly from vault to recipient in rhythm. Each lands with a mono stamp "PAID · WITHIN
     LIMITS" in ok-green.
   - A counter ticks up: "spent 1 … 2 … 3 … 4 … 5".
   - A limits gauge stays green the whole time.
   - Caption: "Every payment passes the limits."
3. **8–11 s (240–330), the problem.** The camera pulls back to show the pills as an endless stream.
   Serif: "Limits stop one big theft." Then, in ember italic: "*Not a thousand small ones.*" The
   music tension rises here.
4. **11–16 s (330–480), Styx Agents arrive.** Three watcher nodes slide in around the vault:
   BURST, CONCENTRATION, JUDGE (with "NEAR AI Cloud" in small mono under Judge). Thin scan lines
   sweep the payment stream and the payment count highlights. Kicker: "STYX AGENTS".
5. **16–19 s (480–570), the brake. This is the money shot.**
   - BURST flashes ember: "5 payments in 5 min, over the 4 allowed".
   - The whole frame slams to an ember "PAUSED" in huge serif, with a beat drop and impact hit.
   - A brief freeze and chromatic jolt.
   - The next pill flies, hits the vault and bounces back with "REFUSED: VaultPaused".
6. **19–24 s (570–720), why you can trust it.**
   - A key labelled "Styx Agent's key" in front of five doors: PAUSE, PAY, UNPAUSE, WITHDRAW,
     CHANGE RULES.
   - PAUSE glows open.
   - The other four slam shut one by one on the beat, each stamped "REFUSED BY NEAR".
   - Caption: "Its NEAR key can do one thing: pause."
   - Then "Only the owner unpauses."
7. **24–27 s (720–810), they learn.**
   - A small scoreboard: BURST "+1 catch".
   - A noisy watcher "−2 · retired" fades to grey, and "generation 2" spawns beside it, with a
     mono note "learned: payroll is normal".
   - Caption: "A parent scores them, retires the noisy ones, and spawns the next generation."
8. **27–30 s (810–900), end card.**
   - Logo.
   - Serif: "Styx Agents".
   - Below: "Watchers that can only *hit the brakes.*"
   - Mono footer: "Live on NEAR testnet · paused 8.6 s after the 5th payment · styxco.xyz".
   - Hold the last 20 frames still.

The vertical cut stacks the same beats: the vault in the top third, captions in the lower third, and
the text at least 64 px.

## Facts you may show (all from the testnet run in docs/near/TESTNET_RUN.md; nothing else)

- Vault `sentinels.styx-vaults.testnet`.
- The pause came 8.6 s after the 5th payment's block.
- 6 payments of 1 tUSDC settled, and the 7th was refused with `VaultPaused`.
- The pause transaction `5YxTgLtpndSXEwiNsu2bJNwTrQbNSu99xA5yrf89UR1J`; show it truncated, as
  `5YxTgLtp…`.
- The sentinel key's allowance is 0.05 NEAR and its only method is `sentinel_pause`.

Never use the words "secure", "audited", "unhackable" or "solves", and add no disclaimers.

## Music and sound

- **Original only.** No copyrighted or "inspired by" tracks. Compose the bed in code and render it
  to WAV (Tone.js `Offline` in Node, or Python with numpy and scipy). Commit the generator, not
  samples you didn't make.
- **Style:** a dark, minimal electronic pulse at **120 BPM**, so one beat is 15 frames and one bar is
  60 frames. Picture a heist trailer meets a tech launch.
  - 0–8 s: a low sub pulse plus a filtered arpeggio. The heartbeat thump lands on the hook cut.
  - 8–16 s: a riser, with the filter opening and hats building.
  - At 16 s (frame 480): a hard downbeat, impact hit and sub drop on "PAUSED", with half a second
    of near-silence after it for weight.
  - 19–27 s: a confident groove. A short metallic slam on each door.
  - 27–30 s: a resolve chord with a tail that rings out to the end.
- **Sound design, synced to frames:**
  - a soft tick per pill;
  - a stamp for "PAID";
  - a glass-stop for "REFUSED";
  - typing ticks for the mono text.
- **Mix:** master to about −14 LUFS integrated, peak below −1 dBTP. Fade the last 0.5 s. Mux the WAV
  into both MP4s.
- **Beat map:** write it as a table in `video/styx-agents/BEATS.md` and drive the animations from it.

## Quality bar (check before you finish)

1. Render stills at frames 30, 150, 300, 420, 485, 520, 650, 780 and 880 for both formats, and look
   at each one. Text must be readable at phone size, never touch an edge (at least 80 px margins),
   and never overlap.
2. Watch the whole render muted: the story must read from text alone. Then watch it with sound: the
   PAUSED slam must land exactly on the downbeat.
3. No glyph symbols anywhere, and only the brand colours and three fonts.
4. Report the final file paths, their durations (exactly 30.0 s), resolutions and loudness.
