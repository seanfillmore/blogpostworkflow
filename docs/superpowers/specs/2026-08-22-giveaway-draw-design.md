# Soap giveaway: the drawing

Design, 2026-08-22. Implements the September 16 drawing for the "Win 36 Free
Bars" promotion under the published Official Rules
(`data/giveaway/official-rules.html`).

This runs **once**, disposes of **$1,072.80** in prizes across two awards, and is
read by real entrants who can complain. It is not reversible and there is no
second attempt, so every choice below favours provability and refusal-to-proceed
over convenience.

## Determinations in force

Three operator determinations were made before this design and are inputs to it,
not decisions this document reopens.

| Determination | Date | Recorded in |
|---|---|---|
| Unconfirmed entrants **are** in the draw, at whatever entries §5 grants them | 2026-08-22 | `config/giveaway.json` → `drawIncludesUnconfirmedEntrants` |
| Same person with two addresses **is** a valid referral for entry crediting | 2026-08-22 | `lib/giveaway/referral-audit.js`, `validateReferral` |
| Same person with two addresses is **not** eligible for the second prize — §6 as written | 2026-08-22 | this document, §6 logic below |

The first exists because the rules contradict themselves: §4/§5 grant a base
entry for submitting, §12 says the drawing uses "a snapshot of confirmed
entrants". See `docs/giveaway-referral-lessons.md`.

The second and third are not in tension. §6 splits self-referral into two
independent voids — entry-crediting and prize eligibility — and only the prize
half is conditioned on Sponsor's determination. §6 also states outright that "in
no case will one person receive more than one prize under this Promotion."

## Phase 1 — Snapshot

**When.** Sep 15, from `close-entry-period.mjs`, which already runs
`TZ=America/Los_Angeles 5 5 15 9 *` (05:05 PT, the morning after entries close at
23:59:59 PT on Sep 14).

**Ordering matters and already works.** `reconcile-referrals.mjs` runs 08:30 UTC
= 01:30 PT, so on Sep 15 it runs *after* the close and *before* the snapshot.
Final entry counts are therefore settled when the snapshot is taken.

**The post-close gate — a bug the draw would otherwise inherit.** `reconcile.js`
credits a confirmation whenever it happens; it has no concept of the Entry
Period. Left alone, the 01:30 PT run on Sep 15 would credit confirmations made
*after* entries closed. §5 requires every entry action to be completed "during
the Entry Period", so the snapshot filters on:

    gv_confirmed_at <= entryClosesAt

and recomputes the entry total from the filtered breakdown rather than trusting
the stored `gv_entries`. This will exclude late confirmers. That is correct and
is the reason it is called out here rather than buried.

**Output.** `data/giveaway/draw-snapshot.json`, written on the **server** (that is
where cron runs), then **committed to git by the operator** — that commit is the
immutability guarantee and the timestamp.

Cron does not commit or push. This repo has no server-side push credentials and
adding them for one annual job would be a standing risk for a one-day benefit.
So Phase 1 ends with a deliberate manual step, and there is a full day between
the snapshot (Sep 15) and the drawing (Sep 16) to take it:

1. `close-entry-period.mjs` writes the snapshot and fires `notify({ immediate: true })`
   — immediate, not deferred, because the 5 AM digest is the wrong latency for
   the one artefact the drawing depends on.
2. Operator: `scp` the file down, commit it on a branch, merge it.
3. `draw.mjs` refuses to run against a snapshot that is not committed, or whose
   contents differ from the committed copy (`git hash-object` vs
   `git rev-parse HEAD:<path>`).

Step 3 is what makes step 2 safe to be manual: forgetting it does not produce a
quietly-unprovable draw, it produces a refusal.

```json
{
  "takenAt": "2026-09-15T12:05:00.000Z",
  "entryClosesAt": "2026-09-14T23:59:59-07:00",
  "determinations": { "drawIncludesUnconfirmedEntrants": true },
  "totals": { "entrants": 0, "entries": 0, "confirmed": 0, "unconfirmed": 0 },
  "entrants": [
    {
      "email": "someone@example.com",
      "entries": 6,
      "confirmed": true,
      "referredBy": "friend@example.com",
      "samePersonSuspected": false
    }
  ]
}
```

`entrants` is sorted by email so the file is diff-stable and two runs of the
snapshot produce byte-identical output.

**Exclusions.** Test identities from `lib/giveaway/test-identity.js` are removed
and the count reported. An entrant with zero entries cannot occur (§4 grants a
base entry) but is refused loudly if it somehow does.

## Phase 2 — The drawing

**When.** Sep 16, by hand. Never on a timer.

    node scripts/giveaway/draw.mjs --seed <value>            # dry run
    node scripts/giveaway/draw.mjs --seed <value> --apply    # writes the result

**Seed.** The Dow Jones Industrial Average closing value on **Tuesday**, Sep 15,
2026, announced publicly before entries close (copy in the appendix).
Unpredictable when announced, verifiable by anyone, and requires no technical
literacy.

Dates verified rather than assumed: Sep 14 is a Monday (entries close), Sep 15 a
Tuesday (seed), Sep 16 a Wednesday (drawing). Sep 15 is a normal US trading day —
the nearest market holiday is Labor Day on Sep 7. An earlier draft of this
document said "Monday, September 15" and that error was one review away from
being published on the giveaway page as a promise to entrants.

The published copy still carries an explicit fallback for an unforeseen closure,
because a seed that does not exist on the day is not recoverable by improvising
in public.

**Algorithm — deliberately the least clever correct one.** Every entry becomes
its own ticket, the tickets are shuffled with a seeded Fisher-Yates, and the
shuffled tickets are walked taking each address's first appearance:

    tickets   = entrants.flatMap(e => Array(e.entries).fill(e.email))   // 508 today
    shuffled  = fisherYates(tickets, mulberry32(sha256(seed)))
    ordering  = firstAppearanceOrder(shuffled)   // winner, alt 1, alt 2, ...

This is exactly "put every ticket in a drum and pull them out one at a time",
which is the model an entrant already has. A weighted-key method
(Efraimidis-Spirakis) would be fewer lines and is equally correct, but nobody
outside this repo could check it by hand, and being checkable by hand is the
entire point of the seed.

One pass yields the winner **and every alternate in order**, which is what §8's
7-day-to-respond path needs — no second draw, and the alternate is as provable as
the winner.

**PRNG.** `mulberry32`, seeded from the SHA-256 of the seed string. ~15 lines,
in-repo, deterministic across platforms and Node versions. Node has no seeded
RNG and `Math.random()` cannot be reproduced, which would defeat the design.

**§6 second prize.** Pure function, four conditions, each separately tested. The
winner's named referrer wins the same prize only if **all** hold:

1. a `referredBy` exists on the winner's snapshot row;
2. that address is present in the snapshot;
3. its row has `confirmed === true` — §6(a), "themselves a confirmed entrant";
4. `samePersonSuspected === false` and the address is not the winner's own —
   §6(b) and the self-referral void.

Any failure means **no second prize and no substitute**, per §6's explicit "no
obligation to substitute a referral prize winner".

**Output.** `data/giveaway/draw-result.json`, committed: the seed, the snapshot's
git blob hash, the full ordering, the winner, the referral-prize determination
with its reason, and the alternates.

## Phase 3 — Notification

The script **drafts** the winner email and writes it to disk. A human reads it
and sends it. Nothing auto-sends a $536.40 prize notification.

§8 requires notification within 48 hours of the drawing and gives the winner 7
days to respond. If they do not, the next name in the committed ordering is the
alternate — already decided, already provable, no new draw.

## Error handling — every path refuses rather than guesses

| Condition | Behaviour |
|---|---|
| snapshot file missing | refuse |
| snapshot not committed, or its blob hash differs from the committed copy | refuse — the pool must be frozen and provably so, and this is what makes the manual commit step in Phase 1 safe |
| no `--seed` | refuse |
| `draw-result.json` already exists | refuse without `--force`; a second draw must be a deliberate act |
| snapshot totals disagree with the sum of its rows | refuse |
| zero entrants | refuse |

Re-running with the same seed on the same snapshot reproduces the result exactly.
That is the property a sceptic checks, so it is also a test.

## Testing

- `mulberry32` is deterministic for a fixed seed, and matches known vectors.
- Same seed + same snapshot → identical winner, alternates and ordering.
- Different seeds → different winners across a sample (guards a seed that is
  silently ignored — the failure that would look like success).
- Weighted fairness: over many seeds, an entrant with *n* entries wins
  approximately *n* times as often as an entrant with one, within tolerance.
- Alternate ordering is stable and contains no duplicate addresses.
- §6: each of the four rejection paths individually, plus the accept path.
- Post-close confirmations are excluded from the snapshot.
- Snapshot output is byte-identical across two runs.
- The refusal paths are tested as behaviour, not documented as intent — an
  uncommitted snapshot, a modified snapshot, a missing seed and an existing
  result each produce a refusal rather than a draw.

## Appendix — seed commitment copy

Must be live on the giveaway page **before entries close on Sep 14, 2026**.
Announcing the method afterward defeats its purpose. This is copy, not code, and
it is the only part of this work with an external deadline.

> **How the winner is chosen.** When entries close on September 14, 2026, we
> freeze the complete list of entries — nothing is added to it after that. Each
> entry is one ticket. To shuffle those tickets we use a number nobody can
> predict or influence: the closing value of the Dow Jones Industrial Average on
> Tuesday, September 15, 2026. (If U.S. markets are unexpectedly closed that day,
> we use the next day they close.) That number and the frozen list are what
> produce the winner on September 16, and anyone can check the result against
> them afterward.

It states the method only. It promises no additional right and creates no
condition beyond the Official Rules, which are unchanged.

## Out of scope

Prize fulfilment (36 bars over 3 years, 3 sets), tax documentation (§10), and the
alternate-winner *outreach* process. This design produces a provable ordering and
a determination; delivering the prize is separate work.
