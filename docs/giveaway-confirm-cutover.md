# Giveaway confirmation cutover — double opt-in → branded flow link

**Status as of 2026-08-23: code shipped, cutover NOT performed.** `config/giveaway.json`
still reads `confirmMechanism: "double_opt_in"`, which is the behaviour the promotion has
been running since launch. Nothing in this document has happened yet.

## Why

330 of ~417 paid-acquired entrants (79%) submitted the entry form and never clicked the
double-opt-in link. An unconfirmed entrant keeps their base entry (see the operator
determination in `config/giveaway.json`) but is not on the list, so they receive no nurture
email, cannot be credited as anyone's referrer, and cannot be sold anything. At roughly
$1.87 a submission that is the majority of the acquisition budget sitting behind one click.

The lever that could not be pulled is the confirmation email itself. Klaviyo's double
opt-in email **cannot have its subject line or its button label changed** — both are locked
deliberately, so the two elements doing the most work to earn a click could never mention a
$536.40 prize or +2 entries. Body blocks and the post-click redirect are editable; that is
the whole ceiling.

`flow_link` lifts it: the list goes single opt-in, entrants are subscribed on submit, and a
branded flow email carries the confirmation link
(`{% update_property_link 'gv_confirmed' 'true' '<static url>' %}`). Subject, sender,
button, design and landing page all become ours, and the template is a normal Klaviyo
library template — writable via the API, versioned in this repo, gated by tests.

**Rules-compatible.** §5 defines a confirmed entrant as one who completed "the
email-confirmation step … via the confirmation link sent to you". It never names Klaviyo's
mechanism, and a flow-sent link satisfies it verbatim. No entry value changes, so §14's
modification clause is not in play.

## What the code already handles

- `lib/giveaway/reconcile.js` — `confirmedEver` / `confirmedEmailSet` / `resolveMechanism`.
  Under `double_opt_in`, list membership is the confirmation. Under `flow_link` it proves
  nothing and only `gv_confirmed` (string `'true'` or boolean) or the durable
  `gv_confirmed_at` stamp counts. An unknown mechanism **throws** rather than defaulting.
- Everything that used to read `p.subscribed` as "confirmed" now goes through
  `confirmedEmailSet`: the reconciler, the report funnel, the referral audit, and both
  nudge scripts.
- `scripts/giveaway/nudge-unconfirmed.mjs` **refuses to run** under `flow_link`. Re-issuing
  a subscribe to a single-opt-in list sends no email at all, so it would have reported
  "nudged 40" while sending zero and burning each profile's nudge cap.
- `scripts/giveaway/verify-launch.mjs` asserts the list's opt-in process **matches** the
  configured mechanism, plus the confirm flow, template and segment ids.
- The draw (`lib/giveaway/draw-snapshot.js`) keys off `gv_confirmed_at` only and is
  mechanism-independent. It needs no change.

## What only the Klaviyo UI can do

These four cannot be done from this repo. Two of them are load-bearing.

1. **Set list `Y2ukbE` to single opt-in.** Lists & Segments → Giveaway 2026-09 — Entrants →
   Settings → Opt-in Process → Single opt-in.
2. **Create the confirmed segment.** Name it `Giveaway 2026-09 — Confirmed`, defined as
   *properties about someone* → `gv_confirmed` equals `true` **OR** `gv_confirmed_at` is
   set. Put its id in `config/giveaway.json` as `confirmedSegmentId`. It is built by hand
   because this Klaviyo API revision (2025-07-15) will not return a segment's `definition`,
   so there is no verified shape to write against; `verify-launch.mjs` checks its
   **profile count** is between 1 and the list size instead, which catches both an
   over-broad definition (matches everyone) and a misspelled one (matches nobody).
3. **Re-trigger the nurture flow off that segment.** This is the step most likely to be
   forgotten and it is the one that misfires loudest — see below.
4. **Gate campaigns to the confirmed segment.** The deadline campaigns (`05-reminder`,
   `06-final-call`) currently send to the list. Under `flow_link` the list includes
   unconfirmed entrants.

### The nurture-flow collision

`Giveaway — Entry & Nurture` triggers on **added to the list**. Under double opt-in that
means "confirmed". Under `flow_link` it means "submitted the form", so the entire nurture
sequence would begin at people who never clicked — and `01-confirm` opens with *"Your email
is confirmed — that's +2 entries banked"*, which would be false for every one of them.

The nurture flow must be re-triggered off `confirmedSegmentId` **before** the confirm flow
goes live. Flow definitions cannot be PATCHed, so this means rebuilding it and taking a new
flow id.

## Order of operations

The order matters. Doing 1 before 2 leaves a window where entrants are on a double-opt-in
list while the code has stopped believing subscription means anything, which stalls every
+2 until the flip completes.

1. `node scripts/giveaway/build-confirm-flow.mjs flow` — creates the template and the
   confirm flow **in draft**. Preview it, click the button, confirm the test profile picks
   up `gv_confirmed=true` and lands on `/pages/giveaway-confirmed`.
2. Create the confirmed segment (UI) and write `confirmedSegmentId` into config.
3. Re-trigger the nurture flow off that segment; gate the deadline campaigns to it.
4. Set list `Y2ukbE` to **single opt-in** (UI).
5. Flip `confirmMechanism` to `"flow_link"` in `config/giveaway.json`.
6. Set the confirm flow **live**.
7. `node scripts/giveaway/verify-launch.mjs` — every gate must pass before walking away.

## Backfilling the existing 330

`scripts/giveaway/backfill-subscribe-entrants.mjs`, dry by default, `--limit 50` a batch.

Operator determination 2026-08-23: submitting the entry form and providing an email address
is the consent, so these entrants are subscribed rather than left unreachable.

Two things to keep in view while doing it:

- **The form they entered under did not say so.** The express consent line was added to
  `theme/sections/giveaway-entry.liquid` in this same change and covers entrants from its
  deploy forward, not the 330 who came before. US CAN-SPAM requires no express consent, so
  the exposure is not legal — it is **spam complaints**, which are what damage a small
  sending domain, and the 481 existing subscribers depend on that same domain.
- **Run it in batches and read the complaint rate between them.** A spike is only
  actionable while entrants remain un-subscribed.

The backfill never sets `gv_confirmed`. It makes people **reachable**, not confirmed —
conflating the two would pay the +2 to everyone and inflate every §5 referral credit that
depends on it.

## Rollback

Set `confirmMechanism` back to `"double_opt_in"` and the list back to double opt-in, in
that order. Entrants who confirmed via the flow keep their `gv_confirmed_at` stamp and stay
confirmed — the stamp is mechanism-independent precisely so a rollback costs nobody their
+2. Entrants subscribed by the backfill stay subscribed; that part does not roll back.
