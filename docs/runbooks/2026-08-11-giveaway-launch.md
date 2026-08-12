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
| 5 | Klaviyo list `Y2ukbE` set to **double opt-in** (List Settings → Opt-in Process) | **Done — and now asserted by Gate A.** The setting can only be *changed* in the UI, but it IS readable: `GET /api/lists/{id}/` returns `attributes.opt_in_process`. Verified live 2026-08-11: `Y2ukbE` is `double_opt_in`, so this check PASSES today. Keep it as a gate anyway — the account is not uniform (`S6hKFq "Email List"` is `single_opt_in`), so a re-created or re-pointed list can silently land single, which would pay the +2 rung to everyone for doing nothing and strip the deliverability screen the existing 481 real subscribers depend on. |
| 6 | Welcome flow `UUa3Qk` filtered to exclude `gv_entrant` profiles | **Outstanding** |
| 7 | Confirm the derived client IP actually varies between visitors (see below) | **Outstanding — do this last, once `entries.realskincare.com` resolves through Cloudflare** |

Items 2, 3 and 5 are the three that Gate A (below) can and does check. Items 1,
4, 6, and 7 have no live surface a script can observe from outside the
respective admin UIs (or, for item 7, the live network path), so they stay
human-confirmed checklist items — do not check any of them off without doing
them.

### Item 7 — confirm the rate limiter is actually seeing per-visitor IPs

`agents/dashboard/lib/rate-limit.js` keys the `/enter`, `/answers`, and
`/upload` budgets off `req.headers['cf-connecting-ip']`, because this domain
is fronted by Cloudflare and that header is what Cloudflare sets at its edge
per visitor. **This is unverifiable from the diff alone** — it depends on
what actually reaches the Node process in production, not on the code.

The failure mode if it's wrong is severe and silent: if anything between
Cloudflare and this Node process (a load balancer, a misconfigured proxy, a
missing `trust proxy`-equivalent setting) strips `CF-Connecting-IP` and no
`X-Forwarded-For` survives either, `getClientIp()` falls back to
`req.socket.remoteAddress` — which in that scenario is the *proxy's* address,
identical for every visitor. Every entrant would then share ONE 5/hour
`/enter` budget and one 30/hour `/answers`+`/upload` budget between all of
them, and the giveaway would start silently 429-ing real entrants within
minutes of the first few visits, with no error in the logs beyond a stream
of 429s that look like abuse rather than a misconfiguration.

**Before turning on the Meta campaign, confirm the derived IP actually
varies between two different networks** (e.g. your home connection and your
phone on cellular, or two different people hitting the lander at the same
time). Simplest method: temporarily add one log line at the top of
`getClientIp()` in `agents/dashboard/lib/rate-limit.js` —

```js
console.log('[giveaway] client ip:', req.headers['cf-connecting-ip'], req.socket?.remoteAddress);
```

— redeploy, hit `/pages/free-soap-giveaway` from two different networks,
`pm2 logs seo-dashboard --lines 50 --nostream` on the server, and confirm the
two `cf-connecting-ip` values are different real IPs (not both empty, not
both equal to each other, not both equal to a Cloudflare/DigitalOcean
internal address). Remove the log line and redeploy once confirmed. If the
two values come back identical, do NOT launch ads — the limiter would be
one shared budget for the entire campaign, and the fix is upstream of this
code (the proxy config between Cloudflare and Node), not in
`rate-limit.js` itself.

## STATUS UPDATE — 2026-08-12: infrastructure is DONE

Two of the three Step-1 prerequisites are complete. What remains is a merge and a deploy.

### Meta pixel — DONE
Pixel `1948396628850834` ("Real Skin Care's Pixel") is installed via the Shopify Facebook & Instagram sales channel with **Maximum** data sharing (Meta Pixel + advanced matching + Conversions API), connected to 3 ad accounts.

Gate A originally reported a FALSE FAIL against this working install, because it grepped for `connect.facebook.net` / `fbevents` / `fbq(`. The sales channel registers the pixel inside Shopify's sandboxed web-pixels runtime, so none of those classic markers appear in page HTML. The check now asserts `"pixel_type":"facebook_pixel"` in the web-pixels config **and** that the id equals `config.metaPixelId` — a pixel firing into the wrong dataset is worse than none, because it looks like it works.

### DNS + TLS + nginx — DONE
- **DNS:** `entries.realskincare.com` → A → `137.184.119.230`, **DNS-only (grey cloud)**, created via the Cloudflare API. Verified against the authoritative Cloudflare NS and against 1.1.1.1 / 8.8.8.8 / 9.9.9.9.
- **TLS:** Let's Encrypt cert issued, expires **2026-11-10**, certbot auto-renew scheduled.
- **nginx:** `/etc/nginx/sites-available/entries`, enabled. Narrow like the `rum` vhost — only `/api/giveaway/`, everything else a flat 404, HTTP→HTTPS 301, `client_max_body_size 12m` for the base64 upload. A pre-cert port-80-only stage was used so the reload could never reference a missing certificate; `nginx -t` passed before every reload and `rum` + the dashboard stayed up throughout.

**`X-Real-IP` in that vhost is load-bearing, not decoration.** These subdomains are A records straight to the origin and deliberately not Cloudflare-proxied, so `CF-Connecting-IP` never exists, the vhost sets no `X-Forwarded-For`, and nginx proxies from `127.0.0.1`. Without the `X-Real-IP` hop every visitor collapses into one rate-limit bucket and the sixth entrant of any hour gets a 429 — which reads as "the campaign isn't converting", not as a bug. `agents/dashboard/lib/rate-limit.js` reads it, with a regression test built from the headers this nginx actually sends.

### The one remaining step: merge PR #434, then deploy

`https://entries.realskincare.com/api/giveaway/entries?email=bad` currently returns **401**, because the deployed dashboard does not yet contain `routes/giveaway.js` — so the request falls through to the basic-auth wall instead of hitting the pre-auth allowlist. It will return **400** once the code ships.

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

Then re-run Gate A. **Run it from the server, or from a machine whose resolver has the new record** — a local resolver that cached the NXDOMAIN from before the record existed will report `ENOTFOUND` and produce a misleading FAIL. Gate A prints the actual cause alongside the failure, so check whether it says `ENOTFOUND` (stale local DNS) or a status code (a real problem).

Remaining after that: the date placeholders, the `flow`-mode rebuild, the flow end boundary, and the rate-limiter per-visitor IP check in Item 7 — which the `X-Real-IP` fix above makes much more likely to pass, but still worth confirming with two real networks.

## Step 2 — the verification script

`scripts/giveaway/verify-launch.mjs` re-derives Gate A from the live storefront
on every run — it does not trust any saved/Admin-API record, because this
store has served a stale render from edge cache before while the Admin API
already reported the corrected content (see the rules-clause section below).
Only what the storefront actually serves matters to an entrant, so every check
fetches the public URL.

Run:

```bash
nvm use && npm test        # expect: fail 0, cancelled 0 (do NOT check the pass count)
node scripts/giveaway/verify-launch.mjs
```

Read **`# cancelled`**, not just `# fail`. On Node 22 a test that never settles is
reported `cancelled`, which prints alongside `# fail 0` and reads like a pass —
that exact combination hid a dead test in this repo for months. Do not assert an
exact `pass` count: the suite grows with every change, so a hardcoded number is
guaranteed to be wrong within a week and teaches whoever reads it to ignore the
line that matters.

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
PASS  Klaviyo list Y2ukbE is double opt-in (got double_opt_in)

2 failure(s). DO NOT launch.
```

Exit code: **1**. 23 PASS / 2 FAIL.

The two failures map directly to Step 1 items 2 and 3 (DNS, pixel install) —
both expected and both blocking, by design. Item 5 (Klaviyo double opt-in) IS
now asserted — the last line — and passes: it was previously documented as
un-assertable on the false premise that the API does not expose
`opt_in_process`. It does. Re-run the gate after each of items 2 and 3 is
completed; do not proceed to Step 4 (real test entry) until it prints
`Gate A passed.`

## Step 4 — real test entry (do this once Gate A passes)

Not yet performed — Gate A hasn't passed. When it does:

**Use an address that has NEVER existed in this Klaviyo account.** Not your main
address, not an alias that has ever been on the list, not one that has ever
bought. This is the whole point of the test and it is easy to get wrong: any
address already in Klaviyo carries `SUBSCRIBED` consent *before* it enters, so
the reconciler credits the +2 confirmation rung whether or not the double opt-in
email was ever sent or clicked. The step would print 6 and prove nothing. A
brand-new address starts at `UNCONFIRMED`, so the count only reaches 6 if the
confirmation click genuinely worked. A `+tag` on Gmail (`you+gv1@gmail.com`) is a
distinct Klaviyo profile and works, provided you have never used that exact tag.

1. Open `/pages/free-soap-giveaway` in a browser, enter the never-before-seen
   address, land on `/pages/giveaway-entered`.
2. Answer the three survey questions, confirm the entry count reads **4**
   (base 1 + survey 3).
3. Click the confirmation link in the Klaviyo opt-in email.
4. Run the reconciler by hand — the +2 is written ONLY by the nightly reconciler,
   and its cron line is not installed until step 8 of the deploy checklist, so
   without this the count stays at 4 and looks like a broken confirmation rung:
   ```bash
   node scripts/giveaway/reconcile-referrals.mjs --apply
   ```
5. Reload `/pages/giveaway-entered?e=YOUR@EMAIL` and re-check the count reads
   **6** (+2 confirm).
6. Verify server-side:
   ```bash
   node -e "import('./lib/klaviyo-profiles.js').then(async m => console.log(await m.getProfileByEmail('YOUR@EMAIL')))"
   ```
   Expected: `gv_entrant: true`, `gv_entries: 6`, `gv_confirmed_at` set to an ISO
   timestamp, and `gv_household` / `gv_frustration` / `gv_current_brand` all
   populated.

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

## Nightly cron — reconciler + daily report

Once live, schedule BOTH on the server crontab. Both are idempotent — safe to
re-run after a failure, safe to leave running indefinitely:

```
# Credit the confirmation (+2) and referral (+5) rungs. Idempotent.
30 8 * * * cd /root/seo-claude && /usr/bin/node scripts/giveaway/reconcile-referrals.mjs --apply >> /var/log/giveaway-reconcile.log 2>&1
# Daily giveaway report + day-5/day-10 spend gates. Writes latest.json and
# notifies via lib/notify.js, so the gates land in the 5 AM digest (13 UTC) --
# run it BEFORE that, and after the reconciler, so the digest reads fresh numbers.
45 8 * * * cd /root/seo-claude && NOTIFY_DEFERRED=1 /usr/bin/node scripts/giveaway/report.mjs >> /var/log/giveaway-report.log 2>&1
```

The report is the campaign's **only** in-flight signal — the offer is deferred to
day 30, so there is no revenue number to read until then, and the answer mix plus
ladder participation are what the day-5 and day-10 budget decisions are made from.
It used to print those gates to stdout with nothing scheduling it, which meant no
gate would ever have been read. It now goes through `lib/notify.js` like every
other agent in this fleet; `NOTIFY_DEFERRED=1` is what routes it into the digest
rather than sending its own email.

Do not install these cron lines until Gate A passes and the real test entry
(Step 4) has been confirmed end to end — running them against a giveaway that
hasn't actually launched is harmless (a no-op with 0 confirmed entrants) but is a
signal worth waiting on so the first real run has real data to act on.

## Nurture flow — deliberately DRAFT

Klaviyo flow `WtDX2F` (`config.nurtureFlowId`, 6 messages, cadence day
0.5h/2/6/12/20/28) is **draft** and must stay that way until launch. Set it
live (Klaviyo UI or the flow-status endpoint) **only** at the moment ads go
live — not before. Turning it on early would nurture zero real entrants
against a flow whose date placeholders (below) aren't filled in yet, and
would race the double opt-in setting change (item 5) if that hasn't landed.

### REQUIRED before this flow goes live — give it an end boundary

**Every delay in this flow is relative to ENTRY, but the Entry Period is a fixed
30-day window with one shared close date.** Those two facts do not compose. The
delays are 0.5h / 48 / 144 / 288 / 480 / 672 hours from list-add and
`profile_filter` is `null`, so someone who enters on day 20 receives:

- `05-reminder` ("the drawing is getting closer") on **day 40**, and
- `06-final-call` ("entries close [ENTRY CLOSE DATE] — the drawing is 2 days
  later") on **day 48** — a week and a half *after* the draw has happened,

stating a deadline that has already passed as though it were upcoming, and
soliciting referrals, Instagram posts and photo uploads that can no longer be
credited to anything. Late entrants are exactly the cohort a 30-day paid campaign
produces most of, so this is not an edge case.

**When the Entry Period dates are set (see the placeholder table below), give the
flow an end boundary in the same sitting:** either a flow end date at the Entry
Period close, or a date-based filter on the flow (or at minimum on `05-reminder`
and `06-final-call`) that stops any send after entries close. A relative-delay
flow cannot express this from inside the definition, so
`scripts/giveaway/build-nurture-flow.mjs` cannot do it for you — it prints the
reminder on `golive` and documents it in its header comment. Do not set the flow
live without it.

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
updated in place).

### A `flow`-mode rebuild is ALSO required before golive

A message's `preview_text` (the preheader Klaviyo actually sends) lives on the
flow's send-email action, **not** on the template, and there is no template-only
update path for it (see Task 9's report). Two preheaders were corrected in
`scripts/giveaway/build-nurture-flow.mjs` after the flow was built, and the flow
still carries the old strings:

| Message | Stale `preview_text` on the flow | Corrected in the builder |
|---|---|---|
| `02-referral` | "Every friend who **enters and names you**…" | "…who **enters, names you, and confirms**…" — the +5 requires the friend's own confirmation (rules §6) |
| `04-ugc` | "**Send a photo or video**…" | "**Upload a photo**…" — replies are not processed and video is not accepted |

The email BODIES (and their hidden preheader divs) are already corrected and
uploaded. Run `node scripts/giveaway/build-nurture-flow.mjs flow` before golive
to bring the flow's `preview_text` into line — the same rebuild the
`06-final-call` date placeholder needs. It deletes and recreates the flow, so
`config.nurtureFlowId` changes and the new flow starts as a **draft**; re-apply
the end boundary (above) on the rebuilt flow, and update the flow id referenced
in this runbook.

## Open decisions (not blockers, but don't let them rot)

**The three optional survey questions were never built.** `gv_switch_blocker`,
`gv_unscented_reaction` and `gv_also_buys` are fully wired — enum-validated in
`agents/dashboard/routes/giveaway.js` (`ENUMS` / `ALSO_BUYS`), mapped to top-level
`gv_*` properties, and bucketed by `lib/giveaway/summarize.js` (`ANSWER_KEYS`) into
the daily report — but **no UI or email asks for them**, so those three report
buckets are always empty in production. An empty bucket means "nobody was asked",
NOT "nobody picked that answer"; do not read a zero there as a finding.

Left wired rather than deleted so adding a second survey step is a one-file
change. The decision to make: is the extra answer data worth the drop-off a
second step costs on a page whose whole job is the +3 rung? Until that is
answered, the entered page asks the three REQUIRED questions only, which is what
the daily report's answer mix is actually built from.

## Deploy checklist (do in order)

1. Complete Step 1 items 2 and 3 (DNS + Meta pixel app) at minimum —
   `verify-launch.mjs` blocks on nothing else right now.
2. Complete items 1, 4, 6 (not script-checkable, confirm by hand). Item 5
   (double opt-in) is already done and is now asserted by Gate A.
3. Fill in the four date placeholders above; republish rules page + templates,
   then run `build-nurture-flow.mjs flow` — required for the corrected
   `02-referral` / `04-ugc` preheaders and the `06-final-call` date, none of
   which a `templates`-mode run can reach. Note the new flow id.
4. Give the (rebuilt) nurture flow an **end boundary** at the Entry Period close (see
   "Nurture flow — deliberately DRAFT" above). Non-negotiable: without it, late
   entrants get post-draw emails quoting a deadline that has passed.
5. Re-run `node scripts/giveaway/verify-launch.mjs` — must print `Gate A passed.`
6. Run the real test entry (Step 4) end to end — **with an address that has never
   existed in this Klaviyo account**, or the test cannot detect a broken
   confirmation rung.
7. Complete item 7 — confirm the derived client IP varies between two
   different networks (see Step 1 above). Do not turn on ads if it doesn't.
8. Set flow `WtDX2F` live.
9. Install both nightly cron lines (reconciler + daily report).
10. Turn on the Meta campaign.
