# Giveaway launch runbook — 2026-08-11

Status as of this writing: **NOT LAUNCHED. Gate A fails.** That is the correct,
expected state — three of the six Sean-gated setup items below are still
outstanding, and this gate exists to make it impossible to spend an ad dollar
until they're done. Do not weaken or skip a check to get a green run; get the
prerequisites done instead.

## Step 1 — Sean-gated setup (cannot be automated)

None of these six items can be completed from this codebase — they are manual
steps in Meta Business Manager, Cloudflare, and Klaviyo's UI. Confirm each
before re-running the gate.

| # | Item | State |
|---|------|-------|
| 1 | Meta Business Manager + ad account + payment method | **Outstanding** |
| 2 | DNS, batch in one Cloudflare visit: Meta domain-verification `TXT` on `realskincare.com`, and a `CNAME` for `entries.realskincare.com` pointing at the same origin as `rum.realskincare.com` | **Outstanding** — `entries.realskincare.com` does not resolve (`getaddrinfo ENOTFOUND entries.realskincare.com`, confirmed live 2026-08-11) |
| 3 | Install the official Facebook & Instagram sales channel app (pixel + CAPI). Do **not** hand-add a pixel to `theme.liquid` — that's how the orphaned `twq` pixel once pushed Clarity's script-error rate to 12.4% | **Outstanding** — no `connect.facebook.net` / `fbevents` / `fbq(` on the live lander |
| 4 | Aggregated Event Measurement: rank `Lead` at priority #1 (if `Purchase` outranks it, iOS lead conversions are silently dropped) | **Outstanding** — blocked on item 3 (no ad account/pixel yet to configure AEM against) |
| 5 | Klaviyo list `Y2ukbE` set to **double opt-in** (List Settings → Opt-in Process) | **Outstanding**. Not scriptable — `lib/klaviyo-profiles.js` documents that double opt-in is a list *setting*, not an API field, so `verify-launch.mjs` cannot check it programmatically. Confirm by hand in the Klaviyo UI before launch. |
| 6 | Welcome flow `UUa3Qk` filtered to exclude `gv_entrant` profiles | **Outstanding** |

Items 2 and 3 are the two that Gate A (below) can and does detect and fail on.
Items 1, 4, 5, and 6 have no live surface a script can observe from outside
the respective admin UIs, so they stay human-confirmed checklist items — do
not check any of them off without doing them.

## Step 2 — the verification script

`scripts/giveaway/verify-launch.mjs` re-derives Gate A from the live storefront
on every run — it does not trust any saved/Admin-API record, because this
store has served a stale render from edge cache before while the Admin API
already reported the corrected content (see the rules-clause section below).
Only what the storefront actually serves matters to an entrant, so every check
fetches the public URL.

Run:

```bash
nvm use && npm test        # expect: pass 1213, fail 0, cancelled 0
node scripts/giveaway/verify-launch.mjs
```

### Actual Gate A output (2026-08-11, Node v22.23.1)

```
PASS  /pages/free-soap-giveaway returns 200 (got 200)
PASS  /pages/giveaway-entered returns 200 (got 200)
PASS  /pages/giveaway-official-rules returns 200 (got 200)
PASS  lander states NO PURCHASE NECESSARY
PASS  lander carries the Meta release
PASS  lander links the official rules
PASS  entered page contains NO offer copy
PASS  rules: void in Rhode Island
PASS  rules: purchases do not earn entries
PASS  rules: unsubscribing does not forfeit an entry
PASS  rules: ARV $536.40 stated
PASS  rules: referrer must be a confirmed entrant
PASS  rules: liability cap on the 3-year obligation
PASS  rules: self-referral earns NO SECOND PRIZE (double-payout guard)
PASS  rules: self-referral voided for prize eligibility, separately from crediting
PASS  rules: one-base-entry carve-out reconciles §4 with the bonus ladder
PASS  rules: sponsor address is the corrected Cheyenne, WY address
PASS  rules: superseded Blum, TX address is NOT present
FAIL  Meta pixel fires on the lander
PASS  lander declares an entry endpoint
PASS  endpoint is first-party (entries.realskincare.com)
FAIL  endpoint answers without auth (got getaddrinfo ENOTFOUND entries.realskincare.com)
PASS  config.listId is set
PASS  config.nurtureFlowId is set

2 failure(s). DO NOT launch.
```

Exit code: **1**. 22 PASS / 2 FAIL.

The two failures map directly to Step 1 items 2 and 3 (DNS, pixel install) —
both expected and both blocking, by design. Item 5 (Klaviyo double opt-in) is
**not** one of the two script failures: as noted above, it is not
API-observable, so it is a Step 1 checklist item only, not a `verify-launch.mjs`
check. Re-run the gate after each of items 2 and 3 is completed; do not
proceed to Step 4 (real test entry) until it prints `Gate A passed.`

## Step 4 — real test entry (do this once Gate A passes)

Not yet performed — Gate A hasn't passed. When it does:

1. Open `/pages/free-soap-giveaway` in a browser, enter a real address you
   control, land on `/pages/giveaway-entered`.
2. Answer the three survey questions, confirm the entry count reads **4**
   (base 1 + survey 3).
3. Click the confirmation email, re-check the count reads **6** (+2 confirm).
4. Verify server-side:
   ```bash
   node -e "import('./lib/klaviyo-profiles.js').then(async m => console.log(await m.getProfileByEmail('YOUR@EMAIL')))"
   ```
   Expected: `gv_entrant: true`, `gv_entries: 6`, and `gv_household` /
   `gv_frustration` / `gv_current_brand` all populated.

## CNAME fallback

If the `entries.realskincare.com` CNAME slips (Cloudflare delay, DNS
propagation issue, whatever), do **not** wait on it — serve the entry endpoint
from the existing `rum.realskincare.com` host instead (it already resolves;
confirmed live 2026-08-11) and update the two `endpoint` Liquid assigns:

- `theme/sections/giveaway-entry.liquid:13` — `assign endpoint = 'https://entries.realskincare.com/api/giveaway'`
- `theme/sections/giveaway-entered.liquid:13` — `assign endpoint = 'https://entries.realskincare.com/api/giveaway'`

Change both to the `rum.realskincare.com` origin, keep the `/api/giveaway`
path, redeploy the theme, then re-run `verify-launch.mjs` — the endpoint
first-party check (`host.endsWith('realskincare.com')`) still passes against
`rum.realskincare.com` since that's the same apex domain.

## Nightly reconciler (referral credit)

Once live, schedule the referral reconciler on the server crontab. Idempotent
— safe to re-run after a failure, safe to leave running indefinitely:

```
# Credit referrers whose referred friends have confirmed. Idempotent.
30 8 * * * cd /root/seo-claude && /usr/bin/node scripts/giveaway/reconcile-referrals.mjs --apply >> /var/log/giveaway-reconcile.log 2>&1
```

Do not install this cron line until Gate A passes and the real test entry
(Step 4) has been confirmed end to end — running it against a giveaway that
hasn't actually launched is harmless (it's a no-op with 0 confirmed entrants)
but is a signal worth waiting on so the first real run has real data to act on.

## Nurture flow — deliberately DRAFT

Klaviyo flow `WtDX2F` (`config.nurtureFlowId`, 6 messages, cadence day
0.5h/2/6/12/20/28) is **draft** and must stay that way until launch. Set it
live (Klaviyo UI or the flow-status endpoint) **only** at the moment ads go
live — not before. Turning it on early would nurture zero real entrants
against a flow whose date placeholders (below) aren't filled in yet, and
would race the double opt-in setting change (item 5) if that hasn't landed.

## Date placeholders still needing a human

None of these have real dates yet. All four must be filled with the same
Entry Period dates, consistently, before launch — a mismatch between the
official rules and the final-call email is a direct legal/trust liability
(entrants told two different deadlines).

| File | Placeholder(s) |
|------|----------------|
| `data/giveaway/official-rules.html:18` | `[START: 12:00 AM CT on <date>]`, `[END: 11:59 PM CT on <date>]` |
| `data/giveaway/nurture/06-final-call.html` | `[ENTRY CLOSE DATE]` (preheader + body), `[DRAW DATE]` (body) |

After filling these in `data/giveaway/official-rules.html`, republish the page
via `scripts/giveaway/build-pages.mjs`. After filling them in
`06-final-call.html`, re-run `scripts/giveaway/build-nurture-flow.mjs` in
`templates` mode (it upserts by name, so the same template id `WJ8J9J` is
updated in place) — note the flow's `preview_text` for this message is a
separate field with no template-only update path (see Task 9's report), so if
the preheader date also needs to change there, the `flow` mode rebuild is
required too.

## Deploy checklist (do in order)

1. Complete Step 1 items 2 and 3 (DNS + Meta pixel app) at minimum —
   `verify-launch.mjs` blocks on nothing else right now.
2. Complete items 1, 4, 5, 6 (not script-checkable, confirm by hand).
3. Fill in the four date placeholders above; republish rules page + templates.
4. Re-run `node scripts/giveaway/verify-launch.mjs` — must print `Gate A passed.`
5. Run the real test entry (Step 4) end to end.
6. Set flow `WtDX2F` live.
7. Install the nightly reconciler cron line.
8. Turn on the Meta campaign.
