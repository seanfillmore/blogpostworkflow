# Giveaway Entry Verification — every earning method, proven before launch

**Date:** 2026-08-12
**Status:** design approved
**Branch:** `feature/giveaway-entry-verification` (stacked on `feature/soap-giveaway-meta-campaign`, PR #434)

## 1. Purpose

Before a single ad dollar moves, prove that every way of earning an entry actually credits the right number of entries — and that every way of *not* earning one credits nothing.

The campaign has six earning methods and a 69-entry ceiling. An entrant who performs an action and does not get credited is a silent loss: they see a number that disagrees with what the emails and official rules promised them, and there is no error anywhere to notice. Conversely, an action that credits when it should not is a fairness and legal problem, because the referral rung gates eligibility for a second $536.40 prize.

This is not a substitute for the unit tests, which already cover the pure logic. It exists because the pure logic is only one layer: the entry ladder spans a Liquid form, browser JS, a public HTTP endpoint, Klaviyo profile properties, Klaviyo's double-opt-in machinery, a nightly reconciler and a report. Every defect found in review that mattered lived at a *seam* between two of those, not inside one.

## 2. What must be proven

### Positive — the six rungs

| Rung | Value | Path |
|---|--:|---|
| Base entry | 1 | `POST /api/giveaway/enter` |
| Confirm email | +2 | Klaviyo double-opt-in click → SUBSCRIBED set → reconciler |
| Survey (3 questions) | +3 | `POST /api/giveaway/answers` |
| Referred friend who confirms | +5 each, cap 10 | referee's `gv_referred_by` → reconciler credits the referrer |
| Instagram post/tag | +3 | `POST /api/giveaway/answers` with a handle |
| Photo upload | +10 | `POST /api/giveaway/upload` with rights granted |

### Negative — twelve things that must credit nothing

1. Self-referral (names own address) — entry still succeeds, referral silently dropped
2. Referrer named by a referee who never confirms — no credit
3. Referrer that never entered at all — no credit
4. Client-supplied `gv_entries` — server total unaffected
5. Client-supplied `confirmed: true` — stays `false`
6. Client-supplied `referrals: 50` — stays `0`
7. Unknown enum value (`household: 'martian'`) — not stored
8. Upload without the usage-rights checkbox — 400, no CDN write, no credit
9. Upload with a non-image extension — 400
10. Upload over the size cap — 400
11. A repeat `/enter` — must not reset an existing breakdown
12. Purchases — no route, webhook or order path may touch `gv_entries`

### Rate limits

- `/enter` 429s on the 6th request from one IP
- `/answers` + `/upload` share a budget that 429s on the 31st
- **the real four-request funnel never 429s** — the regression guard for the defect where a legitimate entrant was locked out of the +10 rung

### Explicitly out of end-to-end scope

**The referral cap at exactly 10** would require ten confirmed referees, i.e. ten manual confirmation clicks. It stays covered by the existing unit test (14 referees, credits stop at 10). The harness proves referrals credit; the unit test proves they stop. Stated here so nobody later assumes the cap was exercised live.

## 3. Approach

A **hybrid**: a scripted harness for everything reachable over HTTP, plus a short manual browser pass for what only a browser reveals.

Neither half is sufficient alone. The harness cannot see the storefront, and the storefront is where the most damaging defects were found — a fabricated entry count shown to every visitor arriving from email, a survey failure swallowed with no message, a submit button left permanently disabled. The manual pass cannot feasibly cover twelve negative cases or a 31-request rate-limit boundary.

Rejected alternatives: harness-only (blind to the UI bugs that actually happened) and checklist-only (hours of work, not repeatable, and some cases impractical by hand).

## 4. Test identities

Five identities, chosen so that every negative case is *provable* rather than merely absent.

| | Role | Confirms? | Expected final |
|---|---|---|--:|
| **A** | referrer; also does survey, Instagram, upload | yes (manual click) | **24** = 1 + 2 + 3 + 3 + 10 + 5 |
| **B** | enters naming A, confirms | yes (manual click) | **3** = 1 + 2 |
| **C** | enters naming A, never confirms | no, deliberately | **1** — and A must not gain a second +5 |
| **D** | names itself | no | **1** — self-referral void |
| **E** | names an address that never entered | no | **1** — credits nobody |

Addresses are `+`-aliases on one real inbox, so all five land in a single mailbox: `<base>+gvtest-<runid>-a@…` through `-e@…`. The base address is a **required CLI argument**, not hard-coded — the runbook records which address to use.

Every identity carries `gv_test: true` and `gv_test_run: <runid>`.

## 5. Isolation and the prize-safety problem

Test identities are created on the **production list `Y2ukbE`**, deliberately. A separate list would test a configuration we are not launching with, and so could not catch a wrong `listId`, a flow bound to the wrong list, or a reconciler pointed somewhere else.

That choice creates a real hazard: **a test profile in the draw pool has a genuine chance of winning a $536.40 prize.** This is already true of the single real test entry the launch runbook mandates — nothing excludes it today. So:

- `gv_test` profiles are **excluded** from the daily report, so they cannot skew the day-5 answer-mix gate.
- `gv_test` profiles must be **excluded from the Phase 2 draw** when it is built. Recorded here as a binding requirement on that work.
- `gv_test` profiles are **included** by the reconciler. This is not an oversight: the reconciler must credit them or the confirm and referral rungs cannot be verified at all. Excluding them there would make the framework unable to test the thing it exists for.
- Cleanup deletes them and verifies deletion.
- **Gate A gains a check: zero `gv_test` profiles remain on the entrant list.** Cleanup can be forgotten; a gate cannot. This is the actual safety net, and it also finally covers the runbook's real test entry.

## 6. Files

| File | Responsibility |
|---|---|
| Create `lib/giveaway/test-identity.js` | Pure. Builds the five identities from a run id and base address, generates aliases, defines the `gv_test` marker and the expected-total table. No I/O. |
| Create `scripts/giveaway/e2e-verify.mjs` | The harness. Phased subcommands, expected-vs-actual table, non-zero exit on mismatch, JSON artifact. |
| Create `docs/runbooks/2026-08-12-giveaway-entry-verification.md` | Step-by-step: the commands, the two clicks, the browser pass, the cleanup check. |
| Create `tests/lib/giveaway-test-identity.test.js` | Unit tests for the pure identity builder. |
| Modify `lib/giveaway/summarize.js` | Exclude `gv_test` profiles. |
| Modify `scripts/giveaway/verify-launch.mjs` | Add the zero-test-profiles-remain check. |

## 7. Phases

```
0  preflight    endpoint reachable, config sane, DNS resolves from THIS machine
1  seed         A-E via real POST /enter          assert 201 + entries=1 each
2  positive     A: survey -> 4, instagram -> 7, upload -> 17
3  negative     the 12 must-not-credit cases      assert nothing moved
4  PAUSE        human clicks 2 confirmation emails (A and B only)
5  reconcile    reconciler --apply                A=24, B=3, C/D/E=1
6  limits       /enter 429@6, mutate 429@31, funnel never 429s     <- LAST
7  reset        pm2 restart clears the in-memory limiter
8  exclusion    run report, assert test profiles absent from counts
9  cleanup      delete all gv_test profiles, verify gone
10 browser      the manual pass
```

**Why limits run last.** The limiter is per-IP and the harness is one IP, so proving `/enter` 429s on the 6th request burns that budget for an hour — every functional test after it would fail for the wrong reason. Running limits last and then restarting PM2 is the clean reset, and it is legitimate precisely because the limiter is designed to be in-memory and reset on restart.

**Phase 0 checks local DNS on purpose.** A resolver still holding the `NXDOMAIN` cached before `entries.realskincare.com` existed reports `ENOTFOUND` and produces a misleading failure. Phase 0 fails fast with that diagnosis rather than letting it masquerade as a broken endpoint.

## 8. The manual browser pass

Ten checks, each targeting a defect class that curl cannot see. Items 4, 5, 7 and 8 are regression checks for bugs found in review.

1. Lander: submit with no first name → visible error, no navigation
2. Successful entry → redirects to the entered page
3. Survey submit → count updates to the real number
4. `/pages/giveaway-entered?e=<A>` in a **fresh tab** → shows 24, **not** "1"
5. Same page with no `?e=` and empty sessionStorage → count **hidden**, not "1"
6. Bonus form with a file but rights unticked → visible error
7. Bonus button disables during submit, re-enables after
8. Forced upload failure → visible error, button recovers
9. No offer copy anywhere: `$99`, `$66`, "months free" absent
10. Rules page: self-referral prize clause and the Cheyenne address present

## 9. Output and failure reporting

The harness prints an expected-vs-actual table per identity, writes `data/reports/giveaway/e2e-<runid>.json`, and exits non-zero on any mismatch. Each assertion names the rung and the delta, so a failure identifies *which earning method broke* rather than only that something did.

## 10. Sequencing

This cannot run until PR #434 merges and the dashboard deploys — `https://entries.realskincare.com/api/giveaway/entries` returns 401 until the running app contains `routes/giveaway.js`, because the request falls through to basic auth instead of the pre-auth allowlist.

Order: merge #434 → deploy → merge this → run phases 0-9 → human runs phase 10.
