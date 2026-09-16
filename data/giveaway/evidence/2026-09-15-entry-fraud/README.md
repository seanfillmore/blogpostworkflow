# Automated entry wave — 2026-09-15, §5 disqualification evidence

This directory is the **proof behind a disqualification**, captured read-only from the
production box on the day of the close. It exists so that the decision to remove 2,948
entrants from a $1,072.80 drawing can be re-checked by someone who was not there.

Rules §5, published before entries opened:

> Sponsor reserves the right to disqualify any entry it reasonably believes to be
> fraudulent, automated, or otherwise made in violation of these Official Rules.

Operator decision: **disqualify** (Sean, 2026-09-15).

## What happened

In the final ~3 hours of the Entry Period, **2,956 entries arrived against a baseline of
roughly 10 per hour.** Entries close `2026-09-14T23:59:59-07:00` = `2026-09-15T06:59:59Z`.

| | baseline (Sep 10–14) | wave (Sep 15 03:59–06:50 UTC) |
|---|--:|--:|
| entries | 407 over 5 days | 5,930 requests / 2,956 entrants |
| rate | ~10 / hour | 1,084 / 1,103 / 778 per hour |
| **distinct user agents** | **70** | **3** |
| top user agent share | — | **5,920 of 5,930 (99.8%)** on one string |
| distinct source IPs | — | 2,792 (max 6 requests each) |
| confirm rate | 47% (campaign) | **0.14%** (4 of 2,946) |

## The four independent signals

1. **User-agent homogeneity.** 5,920 of 5,930 requests carry the identical string
   `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/152.0.0.0 Safari/537.36`, spread
   across 2,792 distinct IPs. The five days before the wave produced **70** distinct agents
   across 407 entries — iPhones, Macs, Ubuntu, several browsers. 2,792 real people do not
   share three user agents. This is a residential-proxy pool with a pinned agent.
2. **Mail-domain concentration.** Of the 2,948 disqualified: **1,939 outlook.com, 1,007
   hotmail.com (both Microsoft), 2 gmail.com.** In the entrant pool at large gmail is
   **28.1%**. A genuine cohort of 2,948 would carry ~830 gmail addresses; it carries two.
3. **Address shape.** Machine-generated two-name-plus-noise locals: `vallyrosabellaq@`,
   `nettieaster235@`, `karnaflorry59@`, `casandragiovannao@`.
4. **Behaviour.** 4 of 2,946 confirmed (0.14%) against the campaign's 47%, and **every
   disqualified entrant holds exactly ONE entry** — a single POST and nothing else. Real
   entrants accumulate rungs.

Note the onset and end are sharp and were read off the per-minute rate rather than rounded:
**03:59Z** (10 requests in that minute, against 54 in the preceding 3h59m) to a last request
at **06:49Z**. The wave stopped 11 minutes *before* the close on its own, so the final ten
minutes of genuine entries are outside the window entirely.

## The rule that was applied

Implemented in `lib/giveaway/draw-snapshot.js`, declared in
`config/giveaway.json` → `disqualifiedEntryWindows`, applied at snapshot time.

> An entry stamped inside the window is disqualified **unless** the entrant did something a
> script does not: clicked the confirmation link, answered the survey, posted to Instagram,
> uploaded a photo, or was credited a referral.

**It fails open twice.** A profile whose `gv_entered_at` will not parse is never
disqualified, and any engagement rescues. The window is doing the accusing, so every
ambiguity resolves toward keeping the entrant.

**Why not an email-pattern rule.** Measured and rejected. The strongest single feature was
the mail domain at 65.5% of the suspect cohort against 2.1% of the known-good one — nowhere
near the recall needed to disqualify on, and it would have judged individuals on their
choice of mail provider. The real proof is the user agent, and it cannot be joined per
entrant: `agents/dashboard/routes/giveaway.js` forwards it to Meta's CAPI and never persists
it on the profile.

## Effect on the drawing

| | entrants | entries |
|---|--:|--:|
| frozen pool as taken 08:06 UTC | 7,367 | 22,803 |
| disqualified | 2,948 | 2,948 (12.9%) |
| exempt (4 confirmed + 4 engaged) | 8 | 40 retained |
| **draw pool** | **4,419** | **19,855** |

**§6 is unaffected.** Zero of the 2,948 named a referrer, so the referral prize and every
real entrant's referral credits are untouched.

## Files

| file | what it is |
|---|---|
| `nginx-entry-rate.txt` | `POST /api/giveaway/enter` per hour across the whole Entry Period |
| `nginx-onset-per-minute.txt` | per-minute rate 03:00–07:00 UTC — where the window boundaries come from |
| `user-agents.txt` | agent counts, wave vs. the Sep 10–14 baseline |
| `source-ips.txt` | distinct source IPs in the wave, with per-IP request counts |
| `disqualified-entrants.json` | every disqualified and exempt entrant, with entry stamp, entry count and the exemption reason |

Captured read-only. Nothing here was used to mutate a profile; the disqualification happens
at snapshot time and is recorded in `data/giveaway/draw-snapshot.json` →
`excluded.fraudulent` and `determinations.fraudWindows`.
