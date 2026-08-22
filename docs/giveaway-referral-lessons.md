# Referral mechanics: what to do differently in the next promotion

Written 2026-08-21, during the "Win 36 Free Bars" soap giveaway, after finding
that referral entries were crediting nothing and could not lawfully be repaired.

## What happened

The entry form has an optional "referred by a friend" field. Whatever is typed
there lands in the entrant's `gv_referred_by`, and
`lib/giveaway/reconcile.js` credits the named person +5 once the referee
confirms.

On 2026-08-21, with 75 profiles on the list, exactly one entrant had named a
referrer — and that referrer had never entered, so nothing was credited. The
address named was one edit-stem away from the entrant's own
(`lisamarob@gmail.com` naming `lisamarobin@outlook.com`), which reads as one
person with two mailboxes rather than a referral at all.

Separately, the `02-referral` email — the one that actually *asks* for referrals —
had sent to nobody at that point. It sits about two days behind entry in the
nurture flow, and the earliest entrant was ~1.6 days old, because the giveaway
opened August 18 but paid traffic did not start until August 20.

## The binding constraint: §5 makes the typed address the identifier

Official Rules §5: referral "is identified **solely** by the referrer's email
address entered in that field."
Official Rules §6: the second prize goes to the referrer "**named at the time of
entry**."

Those two together mean a mistyped referrer address cannot be corrected after
entry. Not by support, not by a "did you mean?" link, not by an admin tool. §13
lets Sponsor modify the Promotion only "if fraud, technical failure, or any other
factor beyond Sponsor's reasonable control impairs the integrity of the
Promotion" — an entrant's typo is none of those, and the general "decisions of
Sponsor are final" clause does not override an express, specific term.

So the fix had to be prevention, and the recovery path had to be limited to
telling people the truth about why their referral was not paying.

## What was built in response

- `lib/giveaway/referral-audit.js` — classifies every referral pair by *why* it
  is not paying. Never writes `gv_referred_by`.
- `scripts/giveaway/audit-referrals.mjs` — nightly; mails the reachable half of
  each broken pair, reports the rest.
- `lib/giveaway/referrer-suggest.js` + the entry form — catches provider typos
  **before submit**, while the typed value is still the value being typed.
- A standing caution under the referral field, because §5 is a rule entrants
  should learn at the moment it binds them, not afterwards.

## For the next promotion

1. **Use unique referral links, not a typed address.** This is the whole lesson
   in one line. A link carries the referrer's identity without asking anyone to
   transcribe an email, which removes the typo class entirely, removes the
   ambiguity about who was named, and removes the enumeration question that a
   "did you mean?" lookup against real entrants would otherwise raise. The
   current rules explicitly say "There is no unique referral link" — that was a
   simplification that cost more than it saved.

2. **If you keep a typed address, validate it at entry time from day one.** Not
   as a later addition. The form is the only place a wrong address is fixable, so
   shipping the form without validation guarantees a population of dead referrals
   that no downstream job can recover.

3. **Write a transcription-error clause into the rules before publishing.**
   Something narrow: Sponsor may correct an obvious transcription error in the
   referral field where the intended entrant is unambiguous and was already a
   confirmed entrant at the time of entry. Without it, "fix the typo" is not
   available at all — and this promotion had to be built around its absence.

4. **Sequence the referral ask against traffic, not against entry.** The ask
   email fires N days after each person enters. If paid traffic starts days after
   the giveaway opens, nobody is old enough to have received it, and the referral
   rung reads as "broken" when it has simply never been requested. Check when the
   ask has actually *delivered* before concluding anything about referral volume.

5. **Decide the self-referral policy in code, not case by case.** §6 voids
   self-referral including "any email address Sponsor determines resolves to the
   same person". That determination now has a heuristic
   (`looksSamePerson` in `lib/giveaway/email-similarity.js`) that routes suspect
   pairs to a human and never emails them. Next time, state the heuristic's
   existence in the rules so the determination is disclosed rather than inferred.

## What NOT to conclude

Referral volume being ~0 in the first days is **not** evidence the mechanic
fails. As of 2026-08-21 the ask had not been delivered to a single entrant. Judge
the rung after `02-referral` has actually sent to a full cohort.
