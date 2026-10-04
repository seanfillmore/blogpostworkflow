# Press Outreach — design

**Date:** 2026-10-04 · **Status:** approved in conversation, spec awaiting review
**Goal:** earn third-party links and mentions on the editorial and roundup pages that Google and AI assistants cite, by running hand-quality pitches at a steady cadence without Sean doing the legwork. **Success is links and mentions earned, not emails sent.**

## Why now

The first campaign (2026-09-21) sent 31 pitches, 18 of them by email. As of 2026-10-04:

- **0 follow-ups sent.** All 31 were due 2026-10-01.
- **0 outcomes recorded.** The contact book still shows every pitch as `sent`.
- **2 replies, both unrecorded:** a decline (Nourish Move Love, 09-22) and a request to sample the soap (Saleam Singleton, 09-25), unanswered for 9 days.

The prospecting side already works: `agents/pr-target-finder` ranks ~500 editorial targets with bylines, and `agents/backlink-opportunity` finds link-gap domains. Everything after the target list was manual, and the manual part is what stalled.

## Decisions (Sean, 2026-10-04)

| Question | Decision |
|---|---|
| Autonomy | **Sean approves every first pitch.** Follow-ups, scheduling, routine replies and samples run on their own. |
| Targets | **Both lists, editorial first:** ~70% of weekly slots from pr-target-finder, ~30% from backlink-opportunity. |
| Samples | **The agent ships them**, as $0 Shopify orders, under a monthly cap (default **10 kits**). |
| Finding addresses | **Free research first, Hunter as a verified fallback.** `HUNTER_API_KEY` is in both `.env`s (Data-platform plan: 1,000 searches + 1,000 verifications per month). |

## Non-goals

- **No templated blasts.** The universe is hundreds of people, which calls for one-to-one personalization (`marketing-cold-outreach-prospecting`).
- **No consumer outreach**, and nothing sent through the Gmail connector. Sean's mail is Hushmail.
- **No Instagram or Substack DMs.** Contacts reachable only that way stay manual and are listed in the digest.
- **No reworking creator-outreach.** It is live and stays untouched.

## Architecture

A new agent, `agents/press-outreach`, built the same way as `agents/creator-outreach`. Each rule is a pure module in `lib/`, tested against fake fixtures (the contact book is private, and this repo is public). I/O is injected.

```
pr-target-finder ─┐
                  ├─► press-prospects ─► contact-finder ─► press-pitch ─► drafts ─► [Sean approves]
backlink-opp ─────┘        (queue)        (address)        (draft+gates)               │
                                                                                        ▼
            link-check ◄── contact book ◄── replies ◄── press-outreach sender (cron, 30 min)
            (weekly)       (the record)     (classify)    first pitches · follow-ups
                                              │
                                              └─► press-samples ($0 order) · escalate to Sean
```

### 1. Prospect queue — `lib/press-prospects.js` (pure)

- **Inputs:**
  - the pitch bucket from `data/reports/pr-targets/latest.json`
  - `data/backlinks/opportunities.json`
  - the contact book
- **Excludes:**
  - any person or outlet that `eligibleFor` rejects (the 60-day re-pitch cooldown, non-pitchable statuses)
  - any domain the book already has an open pitch with
  - any domain or contact with a `pending` or `approved` draft, or a draft **rejected within the last 60 days** (§4)
  - targets pr-target-finder marked as demoted
- **No weekly pitch cap** (Sean, 2026-10-04: "I will take as many as you can write"). Throughput is bounded only by prospects with a verified address, Hunter's monthly allowance, and the daily send cap in §5. Drafting runs daily at **14:20 UTC** (`--draft --apply`) and tops the approval queue up to `queueTarget` (default **25** pending drafts), filled about 70% editorial and 30% link-gap. Leftover share from either list goes to the other.
- **Per-run bounds:** one run drafts at most `draftRunMax` (default **10**), so the queue fills over a few days rather than in one long run. A run stops **starting** new prospects at **15:30 UTC** (the 16:00 UTC send window needs the shared lock, and the 15:00 UTC scheduler and Monday LLM jobs share the box), and never runs longer than **60 minutes**; a run started by hand after 15:30 is bounded by the 60 minutes alone. A run that stops early says so in its digest row with the number of prospects left.
- **Order:** within each list, the source agent's own rank.
- **Output:** a list of prospects with the evidence each one was picked on (target URL, the competitor it cites, rank).

### 2. Address finder — `lib/contact-finder.js` (I/O)

Free pass first, in order. All fetches go through `lib/fetch-pool.js`, so failures get named outcomes and the per-host cap applies.

1. The `mailto:` links and published text on the writer's author or bio page.
2. The writer's personal site and its contact page, when pr-target-finder or Tavily finds one.
3. A Tavily search for `"<name>" email <outlet>`, kept **only** when the address appears on a page the person or the outlet controls.

**Hunter fallback** runs only when the free pass finds nothing. It uses `email-finder` (name + domain), then `email-verifier`, and **only `status: valid` (deliverable) is kept.** `accept_all`, `unknown`, `risky` and `invalid` never send.

- Every address is stored with its source: `channels[].source` is either `published:<url>` or `hunter:verified:<date>`.
- An unverified address is never written as sendable.
- A prospect with no usable address becomes a contact with status `unverified` and no email channel. It is listed in the digest as manual (DM or contact form), and no Hunter credit is spent on it twice: a prospect that cost a credit is recorded in the agent state (`hunter_tried`), and a contact carrying the no-address note counts too; on later runs it gets the free pass only. An address Hunter did return is cached so no later outcome pays for it again.
- A contact whose status is `unverified` becomes `active` when drafting adds a verified email channel.
- **Budget guard:** before spending a credit, it reads Hunter's `/account` usage. It stops at 80% of either monthly allowance and reports that in the digest.

### 3. Drafting — `lib/press-pitch.js` (pure prompt + checks) and a `standard`-tier model call

Each draft is plain text, **at most 150 words**, with a subject line of at most 70 characters:

- **Opener:** one specific thing from the writer's own target article, fetched fresh. **Deterministic anti-fabrication check:** the draft must carry a short quote or concrete detail from that article, and the check confirms that string actually appears in the fetched text (normalized whitespace and case). A miss gets one regeneration naming the problem. A second miss drops the draft and records the prospect as `draft_failed`. The model's word that it read the page is not a check (same lesson as `lib/html-output-guards.js`).
- **Body:** one product angle chosen for that page. **Facts come only from a closed fact sheet** built from `config/ingredients.json`, the catalog's price and URL, and the brand kit's manufacturing line; the model is told to use no other fact about the brand or products. `agents/ad-studio/claims.js`'s source tracing is **not** used (ruling, 2026-10-04). The safeguards are, together: the closed fact sheet, `checkOutgoingCopy`'s gate, the verified opener quote, and Sean approving every first pitch before it can send.
- **Gates**, each a hard fail with one retry:
  - `checkSeoCopyFields` on the default **commercial** surface: health claims, product-category accuracy (never "antiperspirant"; deodorant is odor-only), oral-care claims
  - no em dashes (stripped deterministically, then re-checked)
  - competitor names never disparaged
- **Required lines:**
  - the sample offer
  - `If this isn't a fit, just reply "no thanks" and I won't follow up.`
  - a signature with the canonical postal address read from `brand-kit.json`, the same source `lib/email-rebuild-checks.js` uses. CAN-SPAM requires it for commercial email.
- **Link-gap prospects** get the same structure, but the ask says the site links to those competitors and what we would add. `data/backlinks/opportunities.json` names the linking domain only, never the page, so the pitch **never names or describes a specific page** as the one that links to them.

### 4. Approval queue

- **Storage:** drafts are written to `data/press/drafts/<id>.json`. This path is **gitignored, server-owned, and inside the `press` offsite-backup set**. A draft holds addresses, so it follows the contact book's privacy rule, and `tests/repo/press-contacts-private.test.js` extends to cover it.
- **Dashboard:** a new **Outreach** panel lists pending drafts with the target page, the opener's source quote, and **Approve / Edit / Reject** buttons.
  - Edit opens the subject and body for changes; an edited draft re-runs the gates before it can be approved.
  - The route reads its body through `readJsonBody`, per the dashboard route contract.
- **Digest:** the 5 AM digest shows `N pitches waiting for approval` with a dashboard link, plus the weekly funnel line from §8.
- **Expiry:** a draft unapproved for **14 days** expires and frees its slot. A stale opener ("loved your piece last month") must never send late.
- **Rejection:** a rejected draft records the reason. The prospect gets a 60-day cooldown and is not re-drafted: a draft rejected within 60 days blocks both its domain (in the prospect queue) and its contact (in the drafting run).
- **Overwrite guard:** a draft file is never replaced by a *different* draft that shares its id once it is approved (a second run the same day for the same contact); only that draft's own edit, rejection, expiry or send may rewrite it.
- **Dashboard card** shows where each address came from (`published:<url>` or `hunter:verified:<date>`), or "address source unknown".

### 5. Sender — `agents/press-outreach` (cron every 30 minutes)

- **First pitches:** only `approved` drafts, sent **16:00–24:00 UTC, weekdays only**, spaced at least 10 minutes apart. **Daily cap ramps:** **10/day** to start, then **25/day** once 14 days have passed since the first send with no auto-pause trigger (§5 kill switches). This is a domain-reputation limit, not a volume target. Cold mail shares a sender reputation with Klaviyo and order email. Approved drafts over the cap wait for the next day, oldest first, and still expire under the §4 rule.
- **Follow-ups:** at most **2 per pitch**, on **day 5 and day 12**, threaded with `In-Reply-To` and `References`, under 60 words, no new claims.
  - Templates are fixed and gated once at build time; no model call is needed.
  - A follow-up sends only if no reply exists in **any** folder (§6).
  - Follow-ups are automatic: Sean already approved the conversation.
- **Mail:** `lib/hushmail.js` `sendMail`, sent via Resend and appended to Hushmail Sent, with an `X-RSC-Agent: press-outreach` header so its own mail is never mistaken for Sean's.
- **Record:** every send updates the pitch in the contact book: `message_id`, `follow_ups_sent`, `last_sent_at`.
- **Kill switches:**
  - `config/press-outreach.json` `enabled: false` stops everything.
  - **Auto-pause** triggers on a hard-bounce rate above 3% over the last 50 sends, or **any** spam complaint, read from Resend's email events. A pause sends an `immediate` notification and needs `--resume` to clear. Cold mail must never cost the domain that Klaviyo and order emails depend on.
- **State safety:** the contact book is the only record of what was sent. If it is missing or unparseable, the agent refuses to send, the same rule as creator-outreach's state file. Writes go to a temp file and are renamed into place, with a backup to `data/press/backups/` first, through `lib/press-contacts.js`.

### 6. Replies — classification in `lib/press-replies.js` (pure)

- **Where it reads:** every folder, not just the Inbox. `agents/inbox-sorter` files mail into `Cold Pitches`, `Newsletters` and others, and a reply filed there would otherwise look like silence and draw an unwanted follow-up. This needs a new `fetchFromAllFolders` in `lib/hushmail.js`, read-only (EXAMINE + PEEK, the same as the existing readers).
- **What it matches:** only mail whose sender address or `In-Reply-To` matches an open pitch.
- **Classes:**

| Class | Detection | Action |
|---|---|---|
| **decline** | model classification and a keyword check agree | Record `outcome: declined`, stop follow-ups, start the 60-day cooldown for this concept. No reply sent. |
| **opt-out** | "no thanks", "unsubscribe", "remove me", "don't email" | Set status `do_not_contact`, stop everything, send nothing. |
| **sample yes** | accepts the sample, no other ask | Reply once asking for a mailing address (fixed template); record `outcome: sample_accepted`. |
| **address given** | a reply to that request containing a postal address | §7 creates the order. If the address is ambiguous (missing ZIP, more than one address), escalate. |
| **everything else** | rates, sponsored or paid placement, affiliate terms, questions about ingredients or claims, a confirmed feature, anything angry, anything the classifier is unsure of | **Escalate to Sean only:** an `immediate` email quoting the full thread. **Nothing is sent to the writer** (creator-outreach PR #979 rule). Sean's own reply, found in Hushmail Sent, clears the flag. |

The default for an unsure classification is **escalate**, never reply. A wrong auto-reply to a journalist costs more than a slow one.

### 7. Samples — `lib/press-samples.js`

- **Order:** a $0 Shopify order for the products named in the pitch, created via a draft order completed at $0.
  - Tags: `PR Package` (the existing convention: Saleam Singleton's #2373 was hand-made with it on 2026-09-29) and `press-outreach`.
  - Note: the contact id and the pitch concept.
  - Shipping: the address from the reply.
- **Revenue exclusion is already true:** every $0 order in the snapshots carries `countsAsRevenue: false`, measured across the 30 days to 2026-10-04 (25 of 25 $0 orders). A test pins that a `PR Package` order is classified the same way, so it can never inflate order counts, CVR, or the cluster gate's `MIN_WINDOW_ORDERS`.
- **Cap:** `monthlySampleKits` (default **10**), counted from orders tagged `PR Package` this calendar month, hand-made ones included. Over the cap, or a product we did not pitch, escalates to Sean.
- **Tracking:** when a fulfillment has tracking, one email goes out with the tracking link (fixed template).
- **Follow-up:** 21 days after delivery, one note asking whether they had a chance to try it and offering anything they need for the piece. Then the conversation is left alone.

### 8. Link measurement — weekly, `lib/press-links.js` (pure) plus a step in the agent

- **Who is checked:** every contact with a pitch whose outcome is `replied`, `sample_accepted`, `sample_shipped` or `feature_confirmed`, for 120 days after the last touch.
- **How:** fetch the outlet's target page and the writer's recent articles (via `fetch-pool`), and look for a link to `realskincare.com` or a brand mention.
- **Cross-check:** ~~`agents/backlink-monitor`'s new referring domains are joined to the domains we contacted.~~ **Dropped by ruling (2026-10-04):** the backlink snapshots hold only referring-domain COUNTS, not the domains, so no join is possible. The digest shows the site-wide referring-domain delta between the two newest snapshots instead, labelled "not attributed to outreach".
- **Record:** `link_earned: { url, found_at, dofollow }` or `mention_earned`.
- **Digest:** a weekly funnel line, `drafted · approved · sent · replied · samples · links · mentions`, for the trailing 28 days and all time.
- **Context:** AI-citation movement is read separately against the 2026-09-20 baseline. Per the citation-tracker notes, nothing is readable before 8–12 weeks.

## Data

The contact book `data/press/contacts.json` stays the single record. Pitch entries gain:

```json
{
  "message_id": "<…>",
  "follow_ups_sent": 0,
  "last_sent_at": "…",
  "draft_id": "…",
  "source": "pr-target|link-gap|manual",
  "target_url": "…",
  "outcome": "sent|replied|declined|sample_accepted|sample_shipped|feature_confirmed|link_earned|escalated",
  "sample_order": "#1234",
  "link_earned": null
}
```

Existing fields are unchanged; old records without the new keys read as defaults. `lib/press-contacts.js` gains the transitions, each pure and tested.

`config/press-outreach.json` (tracked):

```json
{
  "enabled": true,
  "queueTarget": 25,
  "dailySendCap": 10,
  "dailySendCapRamped": 25,
  "rampAfterDays": 14,
  "editorialShare": 0.7,
  "monthlySampleKits": 10,
  "followUpDays": [5, 12],
  "draftExpiryDays": 14,
  "hunterUsageStop": 0.8
}
```

## Error handling

| Failure | Behaviour |
|---|---|
| IMAP transient drop | Skip reply handling this run, without reporting a failure (`isTransientNetworkError`, as creator-outreach does). **Follow-ups also skip that run**, because silence cannot be confirmed. |
| Resend error on send | The pitch stays `approved` and retries next run. Three consecutive failures produce a digest `error` row. |
| Fetch of the target article fails (named outcome) | No draft. The prospect is retried next week, up to twice, then marked `unreachable`. It is never drafted from a stale or empty page. |
| Hunter unavailable or over budget | Free pass only, and the digest says so. |
| Gate fails twice | The draft is dropped and counted in the digest with the gate's reason. |
| Contact book unreadable | No sends, no writes, digest `error`. |

**Severity follows the fleet rule:** `status: 'error'` only when the agent broke. Declines, held drafts and gate drops are `info`.

## Rollout (one spec, four PRs)

1. **Sender, follow-ups, replies, approval queue** on the existing 38 contacts.
   - **First batch:** one follow-up to each of the ~16 unanswered September email pitches, through Sean's approval. They are 13+ days late, so they get a "bumping this in case it got buried" wording rather than the day-5 template.
   - The two existing replies are backfilled into the book: Nourish Move Love `declined`, Saleam Singleton `sample_shipped` (#2373, `PR Package`, USPS, 2026-09-29).
2. **Prospect queue, address finder, drafting.** New pitches start flowing into the approval queue.
3. **Samples.**
4. **Link measurement and the weekly funnel line.**

Each PR is tested locally, with a `--dry-run` default on the CLI and `--test-send <addr>` to Sean's own address, before cron is enabled. Cron is added to both `scripts/setup-cron.sh` and the live crontab in the same change, as a UTC-only schedule with no `TZ=` prefix.

## Testing

- **Pure modules**, with fake fixtures on `example.com`, tested TDD: prospect selection and slot split, the address acceptance rules, the anti-fabrication check, gate wiring, every reply class including the "unsure → escalate" default, follow-up timing, sample cap counting, link detection.
- **Source scans:**
  - the agent never imports the Gmail connector
  - every send path goes through `lib/hushmail.js`
  - every draft path runs `checkSeoCopyFields`
  - no first pitch can send without `status: approved`
- **Privacy:** `data/press/drafts/` is ignored and untracked.
- **Order counts:** a `PR Package` $0 order has `countsAsRevenue: false`.
