# Giveaway confirmation cutover — double opt-in → branded flow link

**Status as of 2026-08-24: CUTOVER PERFORMED.** `confirmMechanism` is `flow_link`, list
`Y2ukbE` is single opt-in, confirm flow `VyjCRz` and nurture flow `SajAVS` are live, and
`verify-launch.mjs` passes every gate. What is left is in "Still outstanding" at the bottom.

**It was performed OUT OF ORDER, and the recovery is the part worth reading.** The operator
set the list to single opt-in (step 4) while steps 1-3 were still undone. For roughly four
minutes that put the system in the one state this runbook never describes: list single
opt-in, config still `double_opt_in`, nurture flow still live on list-add. Every submitter
was therefore subscribed on submit, **read as confirmed by `confirmedEmailSet`, paid the +2,
and sent `01-confirm` congratulating them on a click that never happened.** Two entrants
landed in that window (`mjan52@aol.com`, `home5052@medco.net`); both were stripped back to
unconfirmed by hand and their `gv_entries` recomputed (1 and 4). The nurture flow was set to
draft first, before anything else, because it was the only part actively sending falsehoods.

**The step this runbook did not have, and the one that would have silently cost the most.**
Under `flow_link` only `gv_confirmed_at` / `gv_breakdown.confirmed` / `gv_confirmed` count.
Those stamps are written by the **daily 08:30 UTC reconciler** — so at the moment of the
flip, every entrant who confirmed *since the last reconcile run* carried no durable proof at
all. Measured before flipping: **215 list members, 151 stamped, 64 unstamped.** Flipping
first would have read all 64 as unconfirmed, stripped 2 entries from each, and broken every
§5 referral rung keyed off them — silently, with no error anywhere.

**So: run `reconcile-referrals.mjs --apply` under the OLD mechanism, immediately before
flipping the config.** It stamps every currently-confirmed entrant and is what the
"mechanism-independent bridge" in `lib/giveaway/reconcile.js` actually depends on existing.
Note it also stamps anyone who joined after the list went single opt-in, which is why the two
entrants above had to be stripped afterwards — do the reconcile as close to the flip as
possible, and strip anything that joined between the two.

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

**Only ONE of these, and the list below used to claim four.** Three of the four turned out to
be reachable from the API; they were done that way on 2026-08-24 and the corrections matter
because "UI only" is what makes a step get skipped.

1. **Set list `Y2ukbE` to single opt-in** — genuinely UI only. Lists & Segments →
   Giveaway 2026-09 — Entrants → Settings → Opt-in Process → Single opt-in. The API exposes
   `opt_in_process` for READING (which is what `verify-launch.mjs` asserts) but not writing.

The other three, and how each was actually done:

2. **The confirmed segment is creatable via `POST /segments/`.** The old note conflated "the
   definition cannot be read back" with "it cannot be written" — only the first is true
   (`additional-fields[segment]` accepts `profile_count` and nothing else). `Tamb9u` was
   created from ONE condition group holding TWO conditions: `properties['gv_confirmed_at']`
   `is-set` **OR** `properties['gv_confirmed']` equals the string `'true'`.
   **Klaviyo combines condition_groups with AND and conditions within a group with OR** —
   the inverse of what the nesting reads like, and putting them in separate groups would have
   matched only profiles carrying both. Verify by MEMBERSHIP, not by count: the segment was
   checked against the list and matched 213/213 with 0 missing and 0 extra, which is a far
   stronger check than `verify-launch.mjs`'s count-between-1-and-list-size heuristic.
   One gotcha: **Klaviyo rejects a segment on a property no profile has ever carried**
   (`does not exist for this company`). `gv_confirmed` had never been written, so it was
   materialized on a profile that genuinely had confirmed before the segment would create.
3. **The nurture flow re-trigger is creatable too** — `{ type: 'segment', id: '<id>' }` in
   `definition.triggers`, alongside the existing `{ type: 'list', id }`. `build-nurture-flow.mjs`
   picks between them off `confirmMechanism` (`nurtureAudience()`), so this is no longer a
   hand step at all. **`trigger_type` reads `"Added to List"` for a segment trigger as well**,
   so it cannot distinguish the two — read `definition.triggers`.
4. **Gating the deadline campaigns is the same one-line change** — `audiences.included`
   accepts a segment id exactly where it accepted a list id, and validates neither against
   what you meant. `build-nurture-flow.mjs campaigns` now points them at the confirmed
   segment automatically. (`createCampaign`'s parameter was renamed `listId` → `audienceId`
   for that reason; the name was the only thing claiming it had to be a list.)

### The nurture-flow collision

`Giveaway — Entry & Nurture` triggers on **added to the list**. Under double opt-in that
means "confirmed". Under `flow_link` it means "submitted the form", so the entire nurture
sequence would begin at people who never clicked — and `01-confirm` opens with *"Your email
is confirmed — that's +2 entries banked"*, which would be false for every one of them.

The nurture flow must be re-triggered off `confirmedSegmentId` **before** the confirm flow
goes live. Flow definitions cannot be PATCHed, so this means rebuilding it and taking a new
flow id.

## Order of operations

The order matters, and the two ways it goes wrong are not symmetric. Flipping the CONFIG
before the LIST stalls every +2 (the code stops believing subscription while Klaviyo still
gates on the click). Flipping the LIST before the config — what actually happened — is worse:
it pays the +2 to everyone and tells them so by email. **If the list is already single opt-in
and the config is not, the nurture flow is actively lying; set it to draft first and sort out
the ordering afterwards.**

0. **`node scripts/giveaway/reconcile-referrals.mjs --apply`, under the OLD mechanism.**
   Stamps `gv_confirmed_at` on everyone confirmed so far. Skipping this silently unconfirms
   every entrant since the last 08:30 UTC run — 64 of 215 when this was done for real.
1. `node scripts/giveaway/build-confirm-flow.mjs flow` — creates the template and the
   confirm flow **in draft**. Preview it, click the button, confirm the test profile picks
   up `gv_confirmed=true` and lands on `/pages/giveaway-confirmed`.
2. Create the confirmed segment and write `confirmedSegmentId` into config.
3. Re-trigger the nurture flow off that segment; gate the deadline campaigns to it.
   `build-nurture-flow.mjs flow` and `campaigns` both do this off `confirmMechanism` now, so
   flip step 5 **before** running them, not after.
4. Set list `Y2ukbE` to **single opt-in** (UI).
5. Flip `confirmMechanism` to `"flow_link"` in `config/giveaway.json`.
6. Set the confirm flow **live**, then the nurture flow.
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

## Done 2026-08-24, after the cutover

- **Deadline campaigns scheduled** by the operator — both now `Scheduled`, audience `Tamb9u`.
- **`STEQR5 "TEMP diag"`** deleted.
- **Backfill complete: 510 subscribed across 4 batches, 0 failures.** List went 224 → 733 of
  739 submitted. Health after each batch: **2 bounces, 1 unsubscribe, 0 spam complaints,
  0 suppressions beyond the bounces**, with opens arriving during the run.
- **The backfill IS the confirm send, and that is the design.** `subscribeToList` adds the
  profile to `Y2ukbE`, which is exactly what confirm flow `VyjCRz` triggers on, so every
  backfilled entrant received the branded confirm email automatically — verified through
  `Subscribed to List` → `Received Email` → `Opened Email` on real profiles. No separate
  "send them the confirm email" step is needed or wanted.
- **Confirmation chain verified end to end on real entrants** (no test profile — gate 9 of
  `verify-launch.mjs` exists precisely to keep test identities out of the draw pool):
  click → `update_property_link` writes `gv_confirmed:"true"` → segment `Tamb9u` picks them
  up in ~2 min → nurture `SajAVS` triggers. The `gv_confirmed` arm of that segment is what
  makes it ~2 min instead of up to 24h waiting for the reconciler.
- **`X7atwC` "Entered, not confirmed"** created as the negation of `Tamb9u`, and
  **`confirmReminderCampaign`** drafted against it for 27 Aug.

**One measurement trap worth keeping.** `/profile-subscription-bulk-create-jobs/` is an
ASYNC job. `subscribeToList` discards the job id and returns `{ ok: true }` immediately, so
a profile reads `consent: "NEVER_SUBSCRIBED"` and absent from the list for a minute or two
after a "successful" subscribe. Ninety seconds after the first batch it looked exactly like
a silent failure; it was not. **Wait before concluding a subscribe did not happen** — same
class as `/{pixel}/stats` lag in [[project_traffic_gate_open]].

## Still outstanding

1. **The confirm reminder campaign `01M0RZM53084R8VEM8A2MS63PZ` is DRAFT.** A campaign
   created via the API stores its send date but queues **no send job** — it needs Schedule
   clicked in the UI, the same trap the deadline campaigns had.
2. **Watch the confirmation rate over the next few days.** 215 of 734 confirmed at the time
   of the backfill; the 510 just-mailed entrants are the population that decides whether
   `flow_link` actually beats the 30% double-opt-in rate. That number is the whole point of
   the cutover, and it is the one thing not yet measurable.
3. **`nudge-unconfirmed` is still on cron at 16:00 UTC** and correctly no-ops under
   `flow_link`. It is now dead weight — the reminder campaign replaces it. Retire the cron
   line when convenient (see the UTC-only cron rules in CLAUDE.md).

## Rollback

Set `confirmMechanism` back to `"double_opt_in"` and the list back to double opt-in, in
that order. Entrants who confirmed via the flow keep their `gv_confirmed_at` stamp and stay
confirmed — the stamp is mechanism-independent precisely so a rollback costs nobody their
+2. Entrants subscribed by the backfill stay subscribed; that part does not roll back.
