# Drawing runbook — September 15–16, 2026

Order matters. Every step is refusable; nothing here is a formality.

Design: `docs/superpowers/specs/2026-08-22-giveaway-draw-design.md`

## Before September 14 (HARD DEADLINE)

- [x] **Seed commitment copy live on the giveaway page.** Text is the appendix of
      the design doc. Announcing the method *after* entries close defeats its
      purpose, so this is the one step with no recovery. (Verified live 2026-09-12.)
- [x] **Winners excluded from the consolation sends.** All three offer campaigns
      target the whole entrant list, and the draw-day one opens "We drew the
      winner. It wasn't you." `exclude-drawn-winners.mjs --setup --apply` attached
      the exclusion list (`offerExclusionListId`) to all three. Re-check any time:

      node scripts/giveaway/exclude-drawn-winners.mjs --setup

## The close — automatic, nothing to run

Entries close **2026-09-14 23:59:59 PT (06:59:59 UTC Sep 15)**. All times below are
the server's UTC cron; there is no `TZ=` prefix and one would schedule nothing.

| UTC, Sep 15 | PT | what |
|---|---|---|
| 06:55 | 23:55 Sep 14 | `reconcile-referrals.mjs --apply` — stamps confirmations INSIDE the Entry Period. Without it every confirmation after the 08:30 UTC Sep 14 run would enter the draw unconfirmed. Clicks in the last ~5 minutes are the stated residual. |
| 06:59:59 | 23:59:59 Sep 14 | The storefront entry form shows "entries are closed", the entered page drops the survey and bonus forms, and `/api/giveaway/enter`, `/answers`, `/upload` answer **410**. |
| 08:05 | 01:05 | `close-entry-period.mjs --apply` — drafts the nurture **and** confirm flows, then takes the snapshot. It refuses before the close and never retakes an existing snapshot. The snapshot drops any entrant whose `gv_entered_at` is after the close. |

## September 15 — snapshot — DONE

- [x] The snapshot was taken automatically at 08:06 UTC: **7,367 entrants /
      22,803 entries**, `lateEntries: 0`.
- [x] **The sanity check FIRED, and it was right to.** Entrants had moved
      4,205 → 7,282 in a single day against a trend of +20-50. That is the step
      that says "stop and investigate, not draw", and investigating found an
      **automated entry wave** in the final three hours — see below.
- [x] **§5 disqualification applied** (PR #889). 2,948 automated entries removed,
      8 rescued by the engagement exemption. Pool **4,419 entrants / 19,855
      entries**. Evidence committed in
      `data/giveaway/evidence/2026-09-15-entry-fraud/` with its own README.
- [x] Snapshot re-taken with the rule applied and **committed** (PR #890), blob
      `7f4d58117b8c`. `draw.mjs` verified it runs against it.

### The wave, in one table

| | baseline (Sep 10–14) | wave (Sep 15 03:59–06:50 UTC) |
|---|--:|--:|
| rate | ~10 / hour | 1,084 / 1,103 / 778 per hour |
| distinct user agents | **70** | **3** (5,920 of 5,930 on one string, 2,792 IPs) |
| mail domains | gmail 28.1% of pool | 1,939 outlook + 1,007 hotmail, **2 gmail** |
| confirm rate | 47% | **0.14%** |

**§6 is unaffected** — zero of the 2,948 named a referrer.

## September 15, after US markets close — DONE

- [x] **Seed = 52,093.11** — the DJIA close for Tuesday 2026-09-15 (−328.09,
      −0.63%), confirmed against two independent sources. Markets were open, so
      the published fallback ("the next day they close") does not apply.

## September 16 — the drawing (finish by 14:30 PT)

The draw-day consolation email sends at **15:00 PT (22:00 UTC)** and tells everyone
not excluded that they lost. Everything below must be done before it.

- [x] **Consolation sends already exclude the automated cohort** — run 2026-09-15,
      so the 2,948 are not told they lost an entry they never legitimately held:

      node scripts/giveaway/exclude-drawn-winners.mjs --disqualified --apply

- [x] Dry run (seed is **52093.11**):

      node scripts/giveaway/draw.mjs --seed 52093.11

- [x] Read the winner and the §6 determination. Referral prize **NOT AWARDED** —
      the winner named no referrer at entry, a stated condition rather than a
      judgement call.
- [x] Result written and **committed** (PR #893):

      node scripts/giveaway/draw.mjs --seed 52093.11 --apply

      **WINNER: `aiyaamy166@gmail.com`** (6 entries, confirmed). Drawn
      2026-09-16T02:29Z against snapshot `7f4d58117b8c`. Ordering holds 4,419
      unique addresses — so alternate 1 is `angela.knight25@gmail.com` and NO new
      draw is ever needed.
- [x] **Winner excluded from the consolation sends**, ✓ line read:

      node scripts/giveaway/exclude-drawn-winners.mjs --winners --apply

- [ ] Draft and send the notification:

      node scripts/giveaway/draft-winner-email.mjs

      Read `data/giveaway/winner-email-draft.md`, then send it **by hand**.
      §8 requires notification within 48 hours of the drawing.
- [ ] **If the draw is not done by 14:30 PT**, the draw-day email would announce a
      winner who has not been drawn. Revert that campaign to Draft and reschedule
      it (`PATCH /campaign-send-jobs/{id}` `action: revert` — never `cancel`, which
      is permanent). See `scripts/giveaway/repair-scheduled-campaign-unsub.mjs` for
      the cycle.

## If the winner does not respond by the §8 deadline

- [ ] The alternate is already in `draw-result.json` → `ordering[1]`. **No new
      draw.** The ordering was fixed by the published seed, so the alternate is
      exactly as provable as the winner was. The alternate has already received
      the consolation email — that was true when it was sent.

## If someone asks how the winner was chosen

Everything needed to re-derive the result is public or committed:

1. `data/giveaway/draw-snapshot.json` — the frozen pool, committed before the draw.
2. The seed — the published DJIA close for Sep 15, 2026.
3. `node scripts/giveaway/draw.mjs --seed <value>` re-derives the same winner.

The method: every entry is one ticket, tickets are shuffled with a seeded
Fisher-Yates, and each address's first appearance sets the order.

## Post-draw housekeeping — DONE 2026-09-15

- [x] **The 2,948 disqualified profiles are SUPPRESSED in Klaviyo**, which takes
      them off the bill (Klaviyo charges on active profiles; suppressed ones do
      not count) and stops any future send reaching them:

      node scripts/giveaway/suppress-disqualified.mjs --apply

      Verified after: winner and alternate 1 both `suppression: []` /
      `consent: SUBSCRIBED`, so the guard against suppressing the draw pool held.

- [ ] **Still open: send the winner email.** `data/giveaway/winner-email-draft.md`
      is written and committed. §8 gives 48 hours from the drawing to notify and
      the winner 7 days to respond — respond-by **2026-09-23**. Nothing in this
      repo sends it.
