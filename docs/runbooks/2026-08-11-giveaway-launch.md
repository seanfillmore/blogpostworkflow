# Giveaway launch runbook — 2026-08-11

Status: **NOT LAUNCHED — but Gate A now PASSES** (updated 2026-08-12).

Entry Period is set: **Aug 15 → Sept 14 2026, draw Sept 16.** All six
entry-earning methods are verified end-to-end against production (see
`2026-08-12-giveaway-entry-verification.md` — A=24, B=3, C=D=E=1). Gate A
passing is necessary, not sufficient: it checks mechanics, not readiness. The
remaining blockers are in the deploy checklist at the bottom. Do not weaken or
skip a check to get a green run; get the prerequisites done instead.

## Step 1 — Sean-gated setup (cannot be automated)

None of these six items can be completed from this codebase — they are manual
steps in Meta Business Manager, Cloudflare, and Klaviyo's UI. Confirm each
before re-running the gate.

| # | Item | State |
|---|------|-------|
| 1 | Meta Business Manager + ad account + payment method | **Done — verified via Graph API 2026-08-12.** Four ACTIVE ad accounts, all with valid funding. **Use `RSC Ad Account` (`act_946015593265647`)** — most history ($1,832.70 lifetime) and carries the configured pixel. Decided 2026-08-12. |
| 2 | DNS, batch in one Cloudflare visit: Meta domain-verification `TXT` on `realskincare.com`, and a `CNAME` for `entries.realskincare.com` pointing at the same origin as `rum.realskincare.com` | **CNAME done** — `entries.realskincare.com` resolves to `137.184.119.230` and the endpoint answers `400` pre-auth (verified 2026-08-12). **Domain verification DONE** — confirmed in Business Settings 2026-08-12: `realskincare.com` (ID `1084285435769951`) is **Verified** and owned by the *Real Skin Care* portfolio, the same one that holds RSC Ad Account. |
| 3 | Install the official Facebook & Instagram sales channel app (pixel + CAPI). Do **not** hand-add a pixel to `theme.liquid` — that's how the orphaned `twq` pixel once pushed Clarity's script-error rate to 12.4% | **Done.** Gate A asserts the pixel is registered in the Shopify web-pixels config AND that the id matches `config.metaPixelId`. Graph API confirms pixel `1948396628850834` is attached to three ad accounts and **last fired 2026-08-11** — it is live and receiving. |
| 4 | ~~Aggregated Event Measurement: rank `Lead` at priority #1~~ | **NOT APPLICABLE — Meta removed this, confirmed 2026-08-14.** Per Meta's own docs (facebook.com/business/help/721422165168355): "there are no steps you need to take for your events to be processed through Aggregated Event Measurement… The Aggregated Event Measurement tab in Meta Events Manager has been removed because you no longer need to configure your web events." No 8-event prioritisation, no value sets, no conversion domain at campaign creation, and domain verification is no longer required *for event configuration* (it is still done here, and still useful for other purposes). This account has the change — the tab is absent in Events Manager. AEM still runs; it is just no longer configurable. |
| 5 | Klaviyo list `Y2ukbE` set to **double opt-in** (List Settings → Opt-in Process) | **Done — and now asserted by Gate A.** The setting can only be *changed* in the UI, but it IS readable: `GET /api/lists/{id}/` returns `attributes.opt_in_process`. Verified live 2026-08-11: `Y2ukbE` is `double_opt_in`, so this check PASSES today. Keep it as a gate anyway — the account is not uniform (`S6hKFq "Email List"` is `single_opt_in`), so a re-created or re-pointed list can silently land single, which would pay the +2 rung to everyone for doing nothing and strip the deliverability screen the existing 481 real subscribers depend on. |
| 6 | Welcome flow `UUa3Qk` filtered to exclude `gv_entrant` profiles | **DONE — verified via API 2026-08-14.** `profile_filter` now carries a fourth condition group: `properties['gv_entrant']` / existence / `not-set`. It is its own group, so Klaviyo ANDs it with the three metric gates (Placed Order, Added to Cart, Checkout Started, each count = 0) rather than ORing it away. Belt and braces: the welcome flow triggers on list `S6hKFq`, while entrants are added to `Y2ukbE`, so it would not fire for them even without the filter. |
| 7 | Confirm the derived client IP actually varies between visitors (see below) | **DONE — verified 2026-08-14, and the premise was wrong.** `CF-Connecting-IP` is never set on this host: `entries.realskincare.com` is deliberately **grey-clouded** (proxying it would inherit the storefront zone's SSL mode and cause a redirect loop — see the comment in `/etc/nginx/sites-enabled/entries`). The load-bearing header is `X-Real-IP`, and the chain is verified at every link: nginx's access log shows distinct real client IPs with nothing collapsed to `127.0.0.1`; the vhost sets `proxy_set_header X-Real-IP $remote_addr`; and `getClientIp` reads `x-real-ip` (rate-limit.js:126) immediately after the absent `cf-connecting-ip`. Nothing sits between nginx and Node — it proxies straight to `127.0.0.1`. |

Items 2, 3 and 5 are the three that Gate A (below) can and does check. Items 1,
6 and 7 all turned out to be confirmable after all — 1 and 6 via the Graph and
Klaviyo APIs, 7 by inspecting the nginx vhost and access log against
getClientIp. Item 4 turned out not to exist at all — Meta removed AEM
configuration. Every item in this table is now closed.

### Item 7 — confirm the rate limiter is actually seeing per-visitor IPs

**RESOLVED 2026-08-14 — and the original premise below was wrong.** Keeping the
reasoning because the failure mode it describes is real and worth understanding;
only the mechanism differs.

`getClientIp()` tries `cf-connecting-ip`, then `x-real-ip`, then
`x-forwarded-for`, then the socket. This host **never sets the first one**:
`entries.realskincare.com` is deliberately DNS-only / grey-clouded, because
proxying it would inherit the storefront zone's SSL mode (Flexible loops,
Full-strict needs an origin cert). So the load-bearing header is `X-Real-IP`,
which the vhost sets from `$remote_addr`, and nginx proxies straight to
`127.0.0.1` with nothing in between.

Verified at every link on 2026-08-14, without a deploy:

- **client → nginx:** the access log shows distinct real client IPs
  (`150.241.71.157`, `31.132.90.3`, `66.114.144.160`, …) and nothing collapsed
  to `127.0.0.1`
- **nginx → Node:** `proxy_set_header X-Real-IP $remote_addr` in
  `/etc/nginx/sites-enabled/entries`
- **Node:** `getClientIp` reads `x-real-ip` at rate-limit.js:126

If you ever move this host behind Cloudflare's proxy, re-check: `CF-Connecting-IP`
would start being set and would take precedence, which is fine — but the SSL-mode
problem above is the reason it is not proxied today.

--- original reasoning, retained ---

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

**How to re-test this if the proxy setup ever changes.** The chain-inspection
above is cheaper and needs no deploy, so do that first:

```bash
ssh root@137.184.119.230 'grep proxy_set_header /etc/nginx/sites-enabled/entries'
ssh root@137.184.119.230 'tail -500 /var/log/nginx/access.log | awk "{print \$1}" | sort | uniq -c | sort -rn | head'
```

Distinct client IPs in that histogram, plus `X-Real-IP $remote_addr` in the
vhost, plus `getClientIp` reading `x-real-ip`, is the whole chain.

If you want runtime proof from inside Node rather than by inspection, the
two-network test still works: exhaust the 5/hour `/enter` budget from one
network, then hit the lander from a phone on cellular. If the second network
still enters, the buckets are per-visitor. Do this rather than adding a
temporary log line — a log line needs two deploys and prints the visitor IPs
into `pm2` output.

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
other agent in this fleet; deferral into the digest is unconditional in
`lib/notify.js` (the `NOTIFY_DEFERRED=1` in the cron line is vestigial — nothing
reads it), so the report lands in the 5 AM digest
rather than sending its own email.

✅ **INSTALLED 2026-08-12** (both lines, 08:30 and 08:45 UTC — server is UTC, so
both land well before the 13:00 UTC digest). Both were executed once by hand
exactly as cron runs them: exit 0, logs written, report correctly deferred into
the daily-summary JSONL. Logs go to `data/reports/scheduler/giveaway-*.log`
rather than `/var/log/` — a deliberate deviation from the block above, for
consistency with every other job in this crontab. Prior crontab backed up to
`/root/crontab.backup-giveaway-*`.

The original caution, kept for the record: do not install these until Gate A
passes and the real test entry (Step 4) has been confirmed end to end — running them against a giveaway that
hasn't actually launched is harmless (a no-op with 0 confirmed entrants) but is a
signal worth waiting on so the first real run has real data to act on.

## Nurture flow — deliberately DRAFT

Klaviyo flow `XnD2WQ` (`config.nurtureFlowId`, **4** messages, cadence
0.5h/d2/d6/d12) is **draft** and must stay that way until launch. Set it
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

## Date placeholders — ✅ DONE 2026-08-12

**Entry Period: 12:00 AM PT Aug 18 2026 → 11:59 PM PT Sept 14 2026. Draw: Sept 16 2026.**

*(As filled 2026-08-12 this line read "12:00 AM CT Aug 15 → 11:59 PM CT Sept 14". The open
date moved Aug 15 → Aug 18 on 2026-08-14 to match the ad launch, and the zone moved CT → PT
on 2026-08-20 by operator decision. The placeholder table below quotes the ORIGINAL
placeholder strings verbatim and is deliberately left as-is — it is a record of what was in
the file, not a statement of current timing.)*

Filled, republished, and **verified on the live storefront** (the rules page
serves the real dates; zero placeholders remain in the served HTML).

> ### ⚠️ The close date has THREE homes, not two
>
> The table below lists two files. There is a third, and it is the one that bites:
> a message's **preheader** is `preview_text` on the flow's send-email action,
> built from the `MESSAGES` map in `scripts/giveaway/build-nurture-flow.mjs` —
> **not** from the HTML. Filling in `06-final-call.html` alone left the flow's
> preheader reading the literal `[ENTRY CLOSE DATE]` in every inbox, and it
> survived the first `flow`-mode rebuild. Caught 2026-08-12 only by re-reading
> the rebuilt flow's messages back out of the API.
>
> **If the dates ever change, all three must change together**, and you must
> verify by reading `preview_text` back off the flow — not by trusting the build.

| File | Placeholder(s) |
|------|----------------|
| `data/giveaway/official-rules.html:18` | `[START: 12:00 AM CT on <date>]`, `[END: 11:59 PM CT on <date>]` |
| `data/giveaway/nurture/06-final-call.html` | `[ENTRY CLOSE DATE]` (preheader + body), `[DRAW DATE]` (body) |

After filling these in `data/giveaway/official-rules.html`, republish the page
via `scripts/giveaway/build-pages.mjs`. After filling them in
`06-final-call.html`, re-run `scripts/giveaway/build-nurture-flow.mjs` in
`templates` mode (it upserts by name, so the same template id `WJ8J9J` is
updated in place).

### A `flow`-mode rebuild — ✅ DONE 2026-08-12, redone 2026-08-13 (flow is now `XnD2WQ`)

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
uploaded. **Done 2026-08-12.** All six preheaders were read back off the rebuilt flow and
confirmed correct, including the `06-final-call` date. Run
`node scripts/giveaway/build-nurture-flow.mjs flow` again only if copy changes;
it brings `preview_text` into line — the same rebuild the
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

## Deploy checklist — live status as of 2026-08-14

**Ad launch: Aug 18 2026** (Sean, 2026-08-14). The Entry Period stays **Aug 15 →
Sept 14, draw Sept 16** as published — entries opening three days before the ads
run is harmless, and re-editing live legal copy is the riskier move.

### ⚠️ The three-day gap this creates — decide before Aug 15

The lander is **already publicly reachable** (`/pages/free-soap-giveaway`,
`/pages/giveaway-entered`, `/pages/giveaway-official-rules` all 200 on
2026-08-14), and the Entry Period opens Aug 15. But nurture flow `XnD2WQ` is
`draft` and the checklist says to set it live only when ads go live on the 18th.

Anyone entering **Aug 14–17** would therefore get the Klaviyo double-opt-in
confirmation (list-level, works today) but **never receive onboarding emails
01–04**. Klaviyo flows do not backfill: the trigger is *Added to List*, so
setting the flow live on the 18th will not reach a profile added on the 16th.
They would be silently short-changed for the whole giveaway.

**Recommended: set `XnD2WQ` live now rather than on the 18th.** It is safe —
the entrant list `Y2ukbE` is verified **empty (profile_count = 0)** and the
trigger only fires on new additions, so nothing retroactive can go out. The
"not before ads" instruction was written when test entries were still moving
through the list; Gate A now confirms zero `gv_test` profiles remain.

The alternative is to keep the flow draft and accept that any organic entrant
before the 18th gets no sequence. That is only defensible if the lander is
unlinked and unindexed — it is neither guaranteed to stay that way.

### ✅ Done
- Entry endpoint deployed; answers `400` pre-auth, not `401`
- `entries.realskincare.com` resolves; Meta pixel live, id-matched, last fired 2026-08-11
- Klaviyo list `Y2ukbE` confirmed `double_opt_in` (asserted by Gate A)
- Meta ad accounts ACTIVE with funding — **use `RSC Ad Account` (`act_946015593265647`)**
- Entry Period dates filled everywhere and verified live
- Nurture flow rebuilt as **`XnD2WQ`**; all preheaders verified correct
- **Deadline emails personalised 2026-08-14.** Both campaigns now show the
  recipient's own entry count and only the rungs they have *not* yet earned,
  driven by `person.gv_entries` and `person.gv_breakdown`. Rendered against five
  personas (new / partial / all-rungs / maxed / no-data) before shipping.
  - **`person.properties.X` does not resolve in Klaviyo.** `05-reminder` used
    it, so every recipient would have read "you've banked *several* entries".
    The working path is `person.<property>`.
  - **Klaviyo CLONES templates into a flow.** Editing a nurture file and running
    `templates` changes nothing about an existing flow — its sends point at
    copies. Re-run `flow` after any content change to 01-04.
- **Nurture split onto two clocks 2026-08-13.** The four onboarding emails stay
  in the flow (relative to entry); `05-reminder` and `06-final-call` became
  fixed-date campaigns computed from `config.entryClosesAt`
  (`01M002YCXHW8R58ZAHC3BFAMFY` sends Sept 11, `01M002YFF4TTKKSTWB4F069T0P`
  sends Sept 13). Both **Draft** — they must be scheduled in the Klaviyo UI;
  creating a campaign via the API does not queue a send job.
- Nightly cron installed (reconciler 08:30 UTC, report 08:45 UTC), both smoke-run
- **All six entry-earning methods verified end-to-end** (A=24, B=3, C=D=E=1)
- Three production bugs found and fixed: `/enter` 502 on every entry (#436),
  oversized upload 502→413 (#437), unpaced harness seed (#438/#440)

### ☐ Remaining — none of these can be done from this codebase

1. ~~**Give the flow an end boundary** at the Entry Period close.~~ ✅ **RESOLVED
   2026-08-13.** The two deadline emails are no longer in the flow at all — they
   are fixed-date campaigns, so they cannot fire after the close by construction.
   The onboarding tail is bounded by `close-entry-period.mjs` (cron `TZ=America/Los_Angeles 5 5 15 9 *`),
   which flips the flow to `draft` the morning after entries close. No Klaviyo-UI
   end date is needed, and no date-based `profile_filter`.
   **New manual step:** schedule both campaigns in the Klaviyo UI.
2. ~~**Exclude `gv_entrant` from live welcome flow `UUa3Qk`.**~~ ✅ **DONE —
   verified via API 2026-08-14.** `profile_filter` carries a fourth condition
   group, `properties['gv_entrant']` / existence / `not-set`, ANDed with the
   three metric gates. Doubly safe: welcome triggers on `S6hKFq`, entrants land
   on `Y2ukbE`.
3. ~~**AEM: rank `Lead` at priority #1.**~~ ❌ **NOT APPLICABLE — Meta removed
   AEM configuration.** There is no tab and no ranking to set; events are
   processed through AEM automatically. See item 4 above. This was carried as a
   blocker with a 72-hour lead time for three days and was never real.
5. ~~**Build the campaign.**~~ ✅ **BUILT** — `Soap Giveaway 2026-09 | Leads | US`
   exists in `act_946015593265647`, currently **PAUSED**. Turning it on is step 11.
   Creatives are the remaining input.
6. ~~**Run the browser pass** — the 10 checks.~~ ✅ **10/10 PASS 2026-08-14**,
   headless via Puppeteer. Two assertions were wrong and were corrected first
   (item 5 read a hidden element's text; item 7 sampled after the request had
   already returned) — see the entry-verification runbook.
7. ~~**Confirm the derived client IP varies across two real networks.**~~ ✅ **DONE
   2026-08-14** by chain inspection — see Item 7 above. `X-Real-IP`, not
   `CF-Connecting-IP`, is what carries it on this grey-clouded host.
8. ~~**One real test entry** from a fresh root address.~~ ✅ **DONE 2026-08-12/13.**
   `sean@realskincare.com` completed every rung (19 entries); `sfillm07@yahoo.com`
   exercised the pre-existing-customer path. Both have since been stripped of
   `gv_*` and removed from the entrant list, and Gate A passes clean.
   **Three prior inboxes are now burned** — see the entry-verification runbook.
9. `node scripts/giveaway/verify-launch.mjs` → must print **Gate A passed.**
   ✅ Re-verified 2026-08-14: **10/10 PASS.**
10. **Set flow `XnD2WQ` live.** ⚠️ See the three-day-gap note above — the case for
    doing this on **Aug 15** (when entries open) rather than Aug 18 (when ads
    start) is that a flow set live on the 18th never reaches anyone who entered
    on the 16th. Verified `draft` on 2026-08-14.
11. **Turn on the Meta campaign.** Verified `PAUSED` on 2026-08-14
    (`Soap Giveaway 2026-09 | Leads | US`, `act_946015593265647`). Blocked on
    creatives — the brief is `data/giveaway/creative-briefs.md`; Sean is bringing
    `agents/ad-studio` up to speed to render them.
12. **Schedule both deadline campaigns in the Klaviyo UI.** Verified 2026-08-14:
    `Giveaway — Reminder (2026-09-11)` and `Giveaway — Final Call (2026-09-13)`
    are both **Draft with no send time**. The API can create a campaign but
    cannot queue a send job, so this is UI-only and is the easiest item on this
    list to forget — they look finished from the API.

Order matters only in that 1 must precede 10, and 6-9 should be the last things
before 10-11.
