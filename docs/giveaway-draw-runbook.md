# Drawing runbook — September 15–16, 2026

Order matters. Every step is refusable; nothing here is a formality.

Design: `docs/superpowers/specs/2026-08-22-giveaway-draw-design.md`

## Before September 14 (HARD DEADLINE)

- [ ] **Seed commitment copy live on the giveaway page.** Text is the appendix of
      the design doc. Announcing the method *after* entries close defeats its
      purpose, so this is the one step with no recovery.

## September 15 — snapshot

- [ ] `close-entry-period.mjs` runs 05:05 PT (`TZ=America/Los_Angeles`) and takes
      the snapshot as its last step. Confirm the **immediate** email arrived — it
      does not wait for the 5 AM digest.
- [ ] Sanity-check the totals in that email against the last `report.mjs` before
      the close. A large unexplained move means stop and investigate, not draw.
- [ ] Pull the file down and **commit it**:

      scp root@137.184.119.230:~/seo-claude/data/giveaway/draw-snapshot.json data/giveaway/

- [ ] Branch, PR, merge. `draw.mjs` refuses on an uncommitted or edited snapshot,
      so skipping this produces a refusal rather than an unprovable draw.

## September 15, after US markets close

- [ ] Record the **Dow Jones Industrial Average closing value**. That is the seed.
      Write it down somewhere that is not this terminal.
- [ ] If markets were unexpectedly closed, the published copy commits us to the
      next day they close. Do not improvise a different source.

## September 16 — the drawing

- [ ] Dry run:

      node scripts/giveaway/draw.mjs --seed <value>

- [ ] Read the winner and the §6 determination. If the referral prize is refused,
      confirm the stated reason matches the rules before continuing.
- [ ] Commit the result:

      node scripts/giveaway/draw.mjs --seed <value> --apply

- [ ] Commit `data/giveaway/draw-result.json`.
- [ ] Draft and send the notification:

      node scripts/giveaway/draft-winner-email.mjs

      Read `data/giveaway/winner-email-draft.md`, then send it **by hand**.
      §8 requires notification within 48 hours of the drawing.

## If the winner does not respond by the §8 deadline

- [ ] The alternate is already in `draw-result.json` → `ordering[1]`. **No new
      draw.** The ordering was fixed by the published seed, so the alternate is
      exactly as provable as the winner was.

## If someone asks how the winner was chosen

Everything needed to re-derive the result is public or committed:

1. `data/giveaway/draw-snapshot.json` — the frozen pool, committed before the draw.
2. The seed — the published DJIA close for Sep 15, 2026.
3. `node scripts/giveaway/draw.mjs --seed <value>` re-derives the same winner.

The method: every entry is one ticket, tickets are shuffled with a seeded
Fisher-Yates, and each address's first appearance sets the order.
