# Marketing — open questions for Sean

Decisions the marketing work is currently blocked on or would be improved by. Raised as
the Stefan Georgi "Secrets of the DTC Universe" series was ingested into
`.claude/skills/marketing-*` by `agents/marketing-learner`.

**How to use this:** answer inline under a question and mark it `ANSWERED — <date>`, or
delete it if it stops mattering. Questions move to the Answered section at the bottom so
the decision and its date stay on the record. New secrets keep appending here.

Nothing in this file is a recommendation to act *now*. Where an answer would change a
skill, that is noted.

**Last updated:** 2026-08-20 · secrets ingested: #2, #5, #6, #7, #8, #9, #10, #11

---

## A. Blocked on a number only you can set

### A1. What opens the `scale` gate, and what opens `team`?

`STAGES` now runs `tracking → cro → offer-aov → traffic → scale → team`, and
`CURRENT_STAGE` is `traffic`. 23 tactics sit parked behind the two capacity gates —
Advantage+ Shopping, multi-variant hook tests, creator sourcing and partnerships,
CPM/CTR benchmarking, community-on-purchase, dunning at volume.

I invented the definitions:

- `scale` — enough order, list and spend volume for a number to be read rather than
  squinted at. Today: ~54 orders/month, sub-1,000 list, $30/day.
- `team` — anyone producing work who is not you.

**What I need:** the trigger *you'd* actually use. A concrete one, e.g. "`scale` at 200
orders/month or $100/day sustained for a month", "`team` the day I pay a creator". Bumping
`CURRENT_STAGE` is a one-constant change that un-hides everything behind it at once.

**Why it matters:** parked tactics are invisible to every agent until the gate opens. Set
too high, good work stays hidden. Set too low, agents propose things you can't staff.

---

### A2. What are the exit conditions on the ad-account freeze?

Georgi #9 says restraint without a written exit condition collapses back into tinkering on
the first uncomfortable day. The account is frozen until ~2026-08-27 (learning phase).

His list — rising CAC, compressing margins, falling CVR, falling CTR with rising CPM — is
the wrong list here. At $30/day driving giveaway entries, the two metrics that matter are
**cost per entry** and **entry→purchase rate**.

Observed so far: CPL $3.02 on day one, $0.56 on day two (partial), lifetime ~$1.00 across
39 leads. CTR 4.6% → 8.8%.

**What I need:** the thresholds. Something like "cost per entry above $X for 3 consecutive
days, or entry→purchase below Y% after 30 days." I can propose numbers off the observed
range and you veto, if you'd rather work that way.

---

### A3. Should I run `--readjudicate --all`?

The recovery pass re-read only the 50 rejections whose recorded reasoning turned on
timing, and recovered 17. There are **284 rejections** in the corpus. The other 234 read as
duplication or no-mechanism rejects, which I believe are correct and would stay correct.

**What I need:** whether to spend the API budget confirming that. Costs more than the
default pass and I expect it to recover few.

---

## B. Strategy questions a skill should not answer for you

### B1. What is the coconut-oil differentiator — the formula, the baking-soda-free construction, or neither?

Georgi #7 argues the mechanism is now purely compare-and-contrast: *"the real problem with
other products is that they don't do X, and ours does."* And that a product with no
differentiator either shouldn't be sold, or has to compete on price, service or delivery
speed instead.

Coconut oil is closer to his turmeric case than his robot vacuum: a known ingredient in a
saturated category. The recorded competitor set is CeraVe, Vanicream, Cetaphil.

**What I need:** your read on what the actual X is. Candidates: the formula itself,
baking-soda-free construction, the transition-period support, or a non-product
differentiator. This determines what every PDP hero, Amazon bullet and ad angle leads with,
so it is upstream of a lot of recorded copy guidance.

---

### B2. Should `creative-packager`'s default angle be `personas[0].angles[0]`, or the shared-centre angle?

Georgi #6 argues avatar research is mostly a cope for not shipping and that ~90% of ad
effort belongs at the shared centre of the market — the symptom cluster and life situation
nearly every buyer in it has in common.

This project has infrastructure pointed the other way: `agents/voice-of-customer`
regenerates `data/context/personas.json` monthly, rank-ordered, and `creative-packager`
reads `personas[0].angles[0]` as its **default ad angle**. Four agents read the file.

**The question is narrower than it first looked.** The tactic that survived ingestion is
*differentiate creative on angle* — one ad on the physical symptom, one on appearance, one
on confidence — all still aimed at the shared centre. That is compatible with keeping
`personas.json` as an angle **source**; it is incompatible with treating persona segments
as separate targeting cells. So this is not keep-or-kill.

Two further things worth weighing before you answer:

- **The research-cap claim is the weakest-evidenced thing in the series.** It scored 5/10
  and the grader said why: pure assertion delivered as a personality read ("most of the
  people who love AvatarMaxxing are actually just using it as a cope"), no data, no example
  of a research project that failed to pay off. Do not let it outrank local evidence.
- **The persona pipeline has already paid for itself once, for a reason Georgi's argument
  does not cover.** The 2026-07-27 generation put steroid and prescription language into
  every copy-facing field of the top-ranked persona; catching that is why the health-claims
  withholding exists. That is a compliance function, not an avatar-targeting one, and it
  survives regardless of how you answer.

**What I need:** whether the default angle stays `personas[0].angles[0]` or becomes the
shared-centre angle, with personas demoted to one angle source among several. Nothing has
been changed.

---

### B3. The scent/SKU-match quiz — kill it or keep it?

`marketing-offer-construction` records a scent/SKU-match quiz across the 12-SKU catalog as
one of three lead-magnet options. Georgi #8 argues directly against launching behind a quiz
funnel, and the grader agreed on the specifics: a 15-step sequence with logic for 12 SKUs
is not something one person hand-running $30/day can build, populate and then debug against
~54 orders/month.

Two recorded tactics now point opposite ways.

**What I need:** whether the quiz stays as a live option, gets parked behind `scale`, or is
`--falsify`'d out. Right now both entries sit in the library and an agent could reach for
either.

---

### B4. Does a video-format tactic get parked behind `team`, or rejected when its structure already exists as a static?

Raised by #5. The "yapper ad" (creator to camera: pain → skeptical discovery → trial →
transformation → CTA) was **rejected** as a duplicate — that story skeleton is already
recorded in `marketing-conversion-copy-angles` as the long-form native story ad, and the
only additive element is the video medium, which `marketing-paid-creative-testing` already
declines as the default for a solo operator.

That reasoning is defensible, but it is exactly the shape of call you corrected me on. The
static-before-video rule declines video *as the default*, not forever, so an argument
exists that the video execution should have parked behind `team` rather than been rejected.

The tie-break is a deliberate design choice in `isTimingReject`: **merit signals win**, so
a rejection naming duplication is never re-read as a timing rejection. Without that, every
re-adjudication pass re-proposes the same duplicates and the skills accumulate near-copies.

**What I need:** whether you want that tie-break relaxed for the specific case of "same
structure, different medium." I have left it as-is rather than change it on my own read.

---

## C. Ready to build, waiting on go/no-go

### C1. Build the post-entry email sequence?

The highest-value open item, and now supported by two independent secrets: #10 (*"when paid
is capped, spend the hours converting the leads you already paid for"* — 7/10) and #9
(*name the binding constraint first*).

39 giveaway entrants and counting, ~32/day at the current rate, with no path to a purchase.
The recorded design: three steps, escalating by **offer structure** not by discount depth —
reminder → named bundle → low-COGS bonus → time-bounded promotion with a reason-why. The
grader explicitly refused the descending-discount ladder (50%/75% off a consumable with real
COGS is margin-negative, and `marketing-offer-construction` warns a repeating percent-off
ladder trains the list to wait).

**What I need:** go/no-go. The freeze on the ad account makes this free time.

---

### C2. Compute the real cost-per-entry ceiling?

Georgi #10's top tactic: allowable cost per lead = downstream conversion rate × blended
customer value, computed *before* touching the creative. For this campaign that is
**entry→purchase rate × contribution margin at $50.46 AOV**, plus the repeat tail implied
by the 18–22.5% repeat rate.

**What I need:** go/no-go, plus one fact I have not verified — whether giveaway entrant
emails are matchable against Shopify orders. If they aren't, this can't be computed from
data and becomes an assumption.

---

## D. Standing / operational

- **Ad account freeze holds through ~2026-08-27.** #9 argues for extending rather than
  shortening it. No campaign, ad set or ad edits — a significant edit restarts the learning
  phase, and the account was already reset once on 2026-08-20 at 03:37 PT.
- **At the next flexible-ad rebuild**, apply the reserved-slot rule from #11: two of the
  three creative slots hold what has proven itself, one slot stays reserved for a new or
  retested angle. Not applicable until a creative visibly wins.
- **A method now available, needing no decision:** #5's transposition move — take a proven
  direct-response ad from any era and re-render it in a current format, holding hook,
  speaker, tone and story beats fixed (6/10, `marketing-competitor-messaging-teardown`).
  Unlike the competitor-teardown briefing from #11, the source is an old ad rather than a
  live competitor's, so it carries no phrasing-lift risk.

---

## Answered

*(nothing yet — decisions and their dates land here)*
