# Runbook — verify every entry-earning method

Proves each of the six entry-earning methods credits the right number of entries, and that twelve must-not-credit paths credit nothing. Run this before any ad spend.

Allow about 45 minutes, most of it waiting on confirmation emails.

---

## Prerequisites

**The endpoint must be deployed.** `https://entries.realskincare.com` returns **401** until the running dashboard contains `agents/dashboard/routes/giveaway.js` — without it, requests fall through to basic auth instead of the pre-auth allowlist.

- PR #434 merged 2026-08-12 and the dashboard is deployed. `preflight` verified `400` (not `401`) on 2026-08-12.
- If you have redeployed since, re-check with `preflight` before anything else. It says which failure it is:
  `the endpoint answers without auth — got 401 — the dashboard has not been deployed with routes/giveaway.js yet`
- To (re)deploy: `ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'`

You also need:

- Node 22 (`nvm use`; the server runs 22.x and is the production truth)
- Access to the inbox you pass as `--email` — all five identities are plus-aliases on it
- SSH to `root@137.184.119.230` for the PM2 restarts below

---

## ☠️ The base inbox gets burned — choose a throwaway

**Learned the hard way on 2026-08-12. Read this before picking `--email`.**

Seeding five plus-aliases of one inbox against the production list tripped Klaviyo's anti-abuse handling — it looks exactly like list-bombing. The effect on that inbox is **permanent**:

- Every **new** alias of that root is stamped `USER_SUPPRESSED` the moment it subscribes. Verified with a fresh alias sent **alone** after 90s of quiet; a different domain in the same run was untouched.
- A suppressed address is never sent a confirmation again.
- A profile already in the pending state is not sent a second confirmation either — **re-subscribing cannot rescue a botched run**.
- A new `--run` id does **not** help. The suppression follows the **root** address, not the alias.

Klaviyo account sending was not harmed — real customer flows kept delivering throughout. The damage is confined to whichever inbox you name here.

**Pacing does NOT prevent this.** An earlier version of this runbook claimed `--delay` avoided the detector. That was wrong, and the r3 run disproved it: seeded 150s apart, A and B stayed clean and **C, D and E were suppressed anyway**. The trigger is the *number of plus-aliases per root*, not their rate — roughly the third onward, regardless of spacing.

**What actually makes the run survivable is the seed ORDER.** A and B are seeded first, and they are the only two that ever need to receive mail. By the time the detector trips it is hitting C, D and E — which must never confirm, so suppressed is precisely the state they are supposed to end in. Do not reorder the identities.

**Rules:**

1. Use an inbox you are willing to lose. Never the operator's main address, never one support or a customer depends on.
2. Keep `--delay` at its default (150s). It does not prevent suppression, but it keeps the account's event log readable and avoids hammering the endpoint.
3. If the run goes wrong, you need a **different inbox**, not a different run id. The suppression follows the root.
4. Expect **A and B to arrive, C/D/E to be suppressed.** That is a passing run, not a failure.

---

## ⚠️ Read before you start

**This creates REAL profiles on the PRODUCTION Klaviyo list `Y2ukbE`.** Every profile is a genuine list member.

- **Cleanup is mandatory.** A forgotten test profile sits in the draw pool with a live chance of winning a $536.40 prize.
- Every profile the harness creates carries `gv_test: true`. That marker is what keeps it out of the daily report and out of the draw.
- **Gate A refuses launch while any `gv_test` profile remains** — `scripts/giveaway/verify-launch.mjs` enumerates the list and fails if it finds one. That is the backstop for a forgotten cleanup, not a substitute for doing it.
- The marker is written straight to Klaviyo, never through the public endpoint — `POST /answers` whitelists the survey enums and drops everything else, and it hardcodes `survey: true`. Marking through the endpoint would both fail to mark and wrongly credit +3.

---

## Rate limiter — why the restarts below are not optional

The budgets are **per IP, per hour**, and you are one IP:

| Route | Budget |
|---|--:|
| `POST /enter` | 5 / hour |
| `POST /answers`, `POST /upload` | 30 / hour |
| `GET /entries` | 120 / hour |

`seed` spends **exactly all five** `/enter` slots. So `negative` (which re-enters A) and `limits` (which needs a fresh budget to measure the boundary at all) each need the limiter cleared first. It is an in-memory map that resets on restart:

```bash
ssh root@137.184.119.230 'pm2 restart seo-dashboard'
```

Every phase that depends on this prints the command when it sees a 429.

---

## The sequence

Pick a short run id (`r1`, `r2`, …) and use the same one throughout — identities and cleanup are scoped to it.

```bash
cd .claude/worktrees/giveaway-e2e   # or wherever this branch is checked out
nvm use && node --version           # must be v22.x

RUN=r1
MAIL=you@gmail.com                  # a real inbox you can open

node scripts/giveaway/e2e-verify.mjs preflight --run $RUN --email $MAIL
node scripts/giveaway/e2e-verify.mjs seed      --run $RUN --email $MAIL
node scripts/giveaway/e2e-verify.mjs positive  --run $RUN --email $MAIL

ssh root@137.184.119.230 'pm2 restart seo-dashboard'    # seed spent all 5 /enter slots

node scripts/giveaway/e2e-verify.mjs negative  --run $RUN --email $MAIL
```

### ⏸ Now the human pause — two clicks, and only two

Your inbox will hold **five** Klaviyo confirmation emails, one per alias.

**Click only the `-a@` and `-b@` ones.**

| Alias | Click it? | Why |
|---|---|---|
| `+gvtest-<run>-a@` | ✅ yes | A must confirm to earn +2 and to be eligible to receive referral credit |
| `+gvtest-<run>-b@` | ✅ yes | B confirming is what earns A the +5 referral |
| `+gvtest-<run>-c@` | ❌ **no** | C is the proof that *a referee who never confirms credits nobody*. Clicking it destroys the test. |
| `+gvtest-<run>-d@` | ❌ no | D must stay unconfirmed at 1 |
| `+gvtest-<run>-e@` | ❌ no | E must stay unconfirmed at 1 |

If you click C by mistake: stop, run `cleanup`, wait for deletion, and start again with a new run id. There is no way to un-confirm a profile.

### Resume

```bash
node scripts/giveaway/e2e-verify.mjs reconcile --run $RUN --email $MAIL
node scripts/giveaway/e2e-verify.mjs exclusion --run $RUN --email $MAIL

ssh root@137.184.119.230 'pm2 restart seo-dashboard'    # limits needs a FRESH budget

node scripts/giveaway/e2e-verify.mjs limits    --run $RUN --email $MAIL

ssh root@137.184.119.230 'pm2 restart seo-dashboard'    # and clear what limits burned

node scripts/giveaway/e2e-verify.mjs cleanup   --run $RUN
node scripts/giveaway/e2e-verify.mjs status    --run $RUN   # re-run until it shows 0
```

`limits` runs late on purpose: proving `/enter` 429s burns that budget for an hour. It also creates five real profiles of its own (`+lim0…4`) and marks them `gv_test` so `cleanup` and Gate A can see them — if it reports it could not mark one, **mark or delete that profile by hand before launching**.

---

## Expected totals

| Identity | Role | Confirms | Expected |
|---|---|---|--:|
| A | referrer; survey + Instagram + upload | yes | **24** = 1+2+3+3+10+5 |
| B | enters naming A, confirms | yes | **3** = 1+2 |
| C | enters naming A, never confirms | no | **1** |
| D | names itself | no | **1** |
| E | names an address that never entered | no | **1** |

Ladder values: base 1, confirm +2, survey +3, referral +5 (cap 10 friends), Instagram +3, upload +10. Ceiling 69.

During `positive`, A should step **1 → 4 → 7 → 17**. The last +5 and +2 arrive only at `reconcile`, after the two clicks.

---

## The browser pass

Ten checks curl cannot see. **Items 4, 5, 7 and 8 are regression checks for defects found in review** — treat a failure there as a returning bug, not a new one.

**RUN 2026-08-14 — 10/10 PASS**, driven headless with Puppeteer against the live pages. Two assertions had to be corrected before the run could be trusted:

- **Item 5** first read `[data-gv-count]`'s `textContent`, which is the literal `1` baked into the Liquid and is present in the DOM whether or not it is displayed. The real assertion is that its **parent is off-screen** — `showLadder(null)` sets `count.parentNode.hidden = true`. Measured properly: `headingOnScreen=false`. Reading the text alone would have passed a page that *was* showing a fabricated count.
- **Item 7** sampled the button 250ms after click, by which time the request had already returned, so the disable was never observed. Re-run with CDP network throttling (2500ms latency): disabled on all 12 samples during the submit, re-enabled after.

The pass creates one real entry, so it ends by stripping `gv_*` and removing it from the list; Gate A is re-run afterwards and must report `found 0`.

| # | Do this | Expect |
|---|---|---|
| 1 | Lander: submit with no first name | Visible error, **no navigation** |
| 2 | Submit a valid entry | Redirects to the entered page |
| 3 | Submit the survey | Count updates to the **real** number |
| 4 | Open `/pages/giveaway-entered?e=<A's email>` in a **fresh tab** | Shows **24** — not "1" |
| 5 | Open the entered page with **no `?e=`** and empty sessionStorage | Count is **hidden** — not "1" |
| 6 | Bonus form: attach a file, leave rights unticked, submit | Visible error |
| 7 | Watch the bonus button during submit | Disables, then **re-enables** after |
| 8 | Force an upload failure (devtools offline mid-submit) | Visible error, button **recovers** |
| 9 | Search all three pages for `$99`, `$66`, "months free" | Absent everywhere |
| 10 | Rules page | Self-referral prize clause **and** the Cheyenne, WY address present |

---

## Troubleshooting

| Symptom | Cause | Do this |
|---|---|---|
| `ENOTFOUND entries.realskincare.com` | A local resolver cached the NXDOMAIN from before the record existed. **Not** a broken endpoint. | Run from the server, or wait for the cache to expire |
| Endpoint returns **401** | The dashboard is not deployed with `routes/giveaway.js` | `ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'` |
| Unexpected **429** | Per-IP limiter still holding budget from an earlier phase | `ssh root@137.184.119.230 'pm2 restart seo-dashboard'`, then re-run that phase |
| `C`, `D` or `E` shows **4** instead of 1 | Something sent them a `POST /answers` — it hardcodes `survey: true` | Cleanup and restart with a new run id |
| `no Klaviyo profile for …` right after `seed` | Klaviyo's profile-search index lags a subscribe | The harness already retries 5× at 1.5s; if it still fails, Klaviyo is degraded |
| `status` still lists test profiles after `cleanup` | Klaviyo deletion is asynchronous | Wait a few minutes and re-run `status` |

---

## Final checklist

- [ ] Every phase exited 0
- [ ] A = 24, B = 3, C = D = E = 1 at `reconcile`
- [ ] `limits` marked all five `+lim` profiles (or you cleaned them by hand)
- [ ] `status` reports **0 test profiles**
- [ ] All ten browser checks pass
- [ ] `node scripts/giveaway/verify-launch.mjs` reports **`no gv_test profiles remain on the entrant list (found 0)`** and exits 0

---

## ⚠️ Passing this does NOT mean launch-ready

This runbook and Gate A both cover *mechanics*. Four things are still outstanding, and none of them is checked by either:

1. **Entry-period and draw dates are placeholders.** They are deliberately unset. Real dates have to be chosen and propagated to the official rules page, the lander and the nurture emails before a single ad runs — the rules are a binding document.
2. **The flow-mode Klaviyo rebuild is not done.**
3. **The flow end boundary is not defined.**
4. **The nurture flow is still in DRAFT.** `config.nurtureFlowId` is `WtDX2F`; it must be live, or entrants confirm into silence and the +2 rung never pays.

Gate A passing is necessary, not sufficient. Do not read a green gate as permission to spend.

## Related

The **`soap-giveaway` worktree must not be removed yet** — its older ledger is still the reference for the launch work above. Leave `.claude/worktrees/soap-giveaway` in place until those four items are closed.
