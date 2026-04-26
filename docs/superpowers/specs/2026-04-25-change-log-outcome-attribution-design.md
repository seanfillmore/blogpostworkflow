# Change Log + Outcome Attribution — Design

**Date:** 2026-04-25
**Status:** Spec — pending implementation plan

## Goal

Build a unified system that records every SEO-relevant change made to a Shopify page (manual or agent-driven), runs each change through a controlled measurement window, and attributes the resulting metric movement to the change so the agent fleet (and the user) can learn which kinds of changes work.

Today, agents apply changes continuously and the only specialized feedback loop is `meta-ab-tracker` for title/meta tags. Manual edits are not tracked at all. There is no system that tells you *"the title rewrite + FAQ addition you did on /products/coconut-lotion four weeks ago lifted CTR 24% and revenue 14%."* This spec builds that system.

## Success criterion

> "When I make a change to a Shopify page, 28 days later the system tells me whether it worked, and reverts it if it clearly didn't."

In practice:

- Every experimental change opens a measurement window
- After 28 days, a verdict (improved / no_change / regressed / inconclusive) is computed from GSC + GA4 deltas
- Clear losers (within auto-revertable change types) are reverted automatically
- Clear winners are kept and the learning is fed back to agents via `data/context/feedback.md`
- Ambiguous middle-zone outcomes are surfaced in the daily summary for user review

## Non-goals (v1)

- **Pattern mining across change types.** Field-level data is recorded but no analysis runs in v1; comes in v2 once enough verdicts have accumulated.
- **Cross-page attribution.** When an internal link from page A affects page B, link-add is logged on the source. Target-page movement still attributes to its own bundle.
- **Controlled A/B testing.** v1 is observational only — before vs. after on the same URL.
- **Confidence intervals on verdicts.** v1 uses a bundle-of-thresholds heuristic; statistical-significance tests come later.
- **Change rollforward.** A reverted-loser stays reverted; if conditions change later, that's a separate decision.
- **Structured intent ontology.** `intent` is a free-form text field in v1.
- **Queue priority.** Queued items release FIFO when their page's window closes.
- **Manual-edit intent capture.** Diff-detected manual edits have `target_query: null`. v2 may prompt for tagging.
- **Auto-revert for content_body and image changes.** v1 surfaces these for manual review on regression. Auto-revert thresholds for these come later once we observe baseline noise.
- **Unifying with rank-tracker / rank-alerter.** Those agents flag drops independently. v2 may consolidate.

## Background — existing infrastructure being reused

- **Daily metric snapshots.** `data/snapshots/{gsc,ga4,clarity,shopify,google-ads}/YYYY-MM-DD.json` are already collected daily. The verdict agent reads from these — no new collection.
- **`meta-ab-tracker`.** Already implements window-and-revert for the meta-tag-only path with a 28-day window. Its window logic is generalized into `lib/change-log.js`; `meta-ab-tracker` is refactored to call the shared lib.
- **`lib/notify.js` + daily-summary.** Existing deferred-digest pipeline. Verdict and queue-processor agents notify into the existing 5 AM PT email.
- **`data/context/feedback.md`.** Existing closed-loop guidance file. Verdicts append per-pattern learnings here under `## change-verdict`.
- **`shopify-collector` snapshots.** The diff detector reads consecutive snapshots to detect manual Shopify-admin edits.

## Architecture

A unified change log + outcome attribution layer with five small components.

### Capture model — hybrid

- Agents that change Shopify call `proposeChange(...)` and then `logChangeEvent(...)`. They know what they changed, why, and the target query.
- A daily diff detector compares yesterday's vs today's `shopify-collector` snapshot. Field-level changes that don't already have an agent-logged event become synthetic events with `source: 'manual_diff'` and `target_query: null`. This catches manual Shopify-admin edits without losing them.

### Attribution unit — per-page-window with 3-day grouping

- The page URL is the attribution unit.
- The first experimental change after a quiet period **opens a window** in `forming` status.
- Additional experimental changes within 3 days **fold into the same window** (the bundle).
- After 3 days the window **locks** (status = `measuring`). The 28-day measurement clock starts at lock time. Any further experimental change to the same URL during measurement is **queued**, not applied.
- After 28 days the verdict is computed. Status becomes `verdict_landed`. Queued changes for that URL are released and re-evaluated by their originating agent.

### Two change categories

- **Experimental** — title rewrites, meta description rewrites, content body rewrites, FAQ additions, image swaps, schema additions, internal-link-additions for ranking. Subject to the queue-and-window discipline.
- **Maintenance** — broken-link repairs, factual corrections, stale-year refreshes, image alt updates, redirect cleanups, security fixes. Always apply immediately. Logged for audit only; never extend a window or factor into verdict math.

The dividing question: *is this change a hypothesis I want to attribute to a metric outcome, or a correction the page should already have?*

### Auto-revert behavior on regression

- Outcome **regressed** + bundle is fully composed of auto-revertable change types (title, meta_description, schema, faq_added, internal_link_added) → write captured `before` values back to Shopify, log the revert, append the negative learning to `data/context/feedback.md`.
- Outcome **regressed** + bundle includes content_body or image changes → status `surfaced_for_review`. Daily summary lists the URL + reasons; user decides.
- Outcome **improved** → keep, append the positive learning.
- Outcome **inconclusive** or **no_change** → keep, log inconclusive.

## Data model

Three concepts: change events (immutable), page windows (mutable), verdicts (attached to windows).

### Storage

```
data/changes/
  events/<YYYY-MM>/<change-id>.json       # immutable per-change records
  windows/<slug>/<window-id>.json         # mutable per-window state
  queue/<slug>/<change-id>.json           # changes proposed while a window was active
  index.json                              # active windows + recent verdicts (rebuilt nightly)
```

### `change_event.json` — immutable

```js
{
  id: "ch-2026-04-25-coconut-lotion-title-001",
  url: "/products/coconut-lotion",
  slug: "coconut-lotion",
  change_type: "title" | "meta_description" | "content_body" | "image" | "schema" | "faq_added" | "internal_link_added",
  category: "experimental" | "maintenance",
  before: "...",        // captured at change time — required for revertability
  after: "...",
  changed_at: "2026-04-25T14:32:00Z",
  source: "agent:meta-optimizer" | "manual_diff" | "manual_logged",
  target_query: "coconut lotion" | null,
  target_cluster: ["coconut lotion","coconut oil lotion","organic coconut lotion"],
  intent: "Lead title with head-term query for CTR lift",
  window_id: "win-coconut-lotion-2026-04-25" | null  // null only for maintenance
}
```

### `page_window.json` — mutable

```js
{
  id: "win-coconut-lotion-2026-04-25",
  url: "/products/coconut-lotion",
  slug: "coconut-lotion",
  opened_at: "2026-04-25T14:32:00Z",
  bundle_locked_at: "2026-04-28T14:32:00Z",   // opened_at + 3d
  verdict_at: "2026-05-26T14:32:00Z",          // bundle_locked_at + 28d
  status: "forming" | "measuring" | "verdict_landed",
  changes: ["ch-2026-04-25-coconut-lotion-title-001", "ch-2026-04-26-coconut-lotion-meta-001"],
  target_queries: ["coconut lotion","coconut oil lotion"],
  baseline: {
    captured_at: "2026-04-25T14:32:00Z",
    gsc: { for_target_queries: { impressions, clicks, ctr, position }, for_page: {...} },
    ga4: { for_page: { sessions, conversions, page_revenue } }
  },
  verdict: null | {
    decided_at: "2026-05-26T14:35:00Z",
    gsc_delta: { impressions, clicks, ctr, position, per_target_query },
    ga4_delta: { sessions, conversions, page_revenue },
    outcome: "improved" | "no_change" | "regressed" | "inconclusive",
    action_taken: "kept" | "reverted" | "surfaced_for_review",
    revert_results: null | [{ change_id, field, before, after_revert, ok }],
    learnings: "Title rewrite + FAQ addition for query 'coconut lotion' yielded +24% CTR / +14% page revenue over 28d. Pattern: lead title with head-term query."
  }
}
```

## Components

### 1. `lib/change-log.js` — shared library, no agent

```js
proposeChange({ slug, changeType, category }) → { action, windowId, reason }
logChangeEvent({ url, slug, changeType, category, before, after, source, targetQuery, intent, windowId })
queueChange({ slug, changeType, source, proposalContext })
isPageInMeasurement(slug) → window | null
getActiveWindow(slug) → window | null
captureBaseline(slug, targetQueries) → baseline
```

Responsibilities:
- Manage window lifecycle (`forming` → `measuring` → `verdict_landed`)
- Append change events to the right window
- Capture baseline metrics from existing snapshots when a window opens
- Maintain `data/changes/index.json` for fast lookup

`proposeChange` returns:
- `{ action: 'apply', windowId: null, reason: 'no_active_window' }` — opens a new window when the change applies
- `{ action: 'apply', windowId: '<id>', reason: 'window_in_forming_period' }` — extends an existing window
- `{ action: 'apply', windowId: null, reason: 'maintenance_bypass' }` — bug-fix path
- `{ action: 'queue', windowId: '<id>', reason: 'window_in_measurement' }` — page is locked

### 2. `agents/change-diff-detector/index.js` — daily cron

Runs after `shopify-collector` finishes. For every Shopify article + product + collection + page:

- Compare yesterday's snapshot vs today's
- For each field difference (title, meta_description, body_html, etc.), check whether a `change_event` already exists for that URL+field+changed_at within the last 48 hours
- If not, create a synthetic event with `source: 'manual_diff'`, `category: 'experimental'`, `target_query: null`
- Determine window membership: extend the active window if there is one, open a new one if not

### 3. `agents/change-verdict/index.js` — daily cron

For each window where `now > verdict_at` and `status === 'measuring'`:

1. Read the last 28d of GSC + GA4 snapshots
2. Compute deltas vs baseline:
   - For target_queries: position, CTR, clicks, impressions
   - For page (across all queries): impressions, CTR, sessions, conversions, page_revenue
3. Classify outcome:
   - **improved**: any positive threshold crossed AND no negative threshold crossed
   - **regressed**: any negative threshold crossed
   - **no_change**: all deltas within ±5%
   - **inconclusive**: deltas in either direction but below thresholds
4. Decide action:
   - **kept**: improved, inconclusive, or no_change
   - **reverted**: regressed AND all changes in the bundle are auto-revertable (title, meta_description, schema, faq_added, internal_link_added). Writes captured `before` back to Shopify.
   - **surfaced_for_review**: regressed AND bundle includes `content_body` or `image`
5. Write verdict to the window file
6. Append a learning to `data/context/feedback.md` under `## change-verdict`

### Verdict thresholds (v1)

Positive (any one trips → "improved"):
- target_query CTR ≥ +20%
- target_query clicks ≥ +25%
- target_query position −3 or better
- page_revenue ≥ +20%

Negative (any one trips → "regressed"):
- target_query CTR ≤ −20%
- target_query clicks ≤ −25%
- target_query position +5 or worse
- page_revenue ≤ −20%

Thresholds live in a single config object inside `lib/change-log.js` so they can be tuned without touching multiple files.

### 4. `agents/change-queue-processor/index.js` — daily cron

For each `verdict_landed` window where the page now has no active measurement:

- Look in `data/changes/queue/<slug>/` for queued items (FIFO by `proposed_at`)
- For each queued item, apply the proposed change directly using the stored `after` value via `lib/change-log.js` (which calls Shopify, opens a new window, and logs the event with `source: '<original-source>+queue-released'`). The originating agent does NOT need to be re-invoked.
- If the queued item is older than 60 days (the proposal is likely stale), drop and log
- If the Shopify update fails (e.g., the page no longer exists, schema changed), log to a `queue-failures.md` report and surface in the daily summary

**Trade-off accepted:** queued proposals are applied as-was, not re-evaluated against the current page state. If a queued title was generated in May and reflects May's keyword priorities, it gets applied verbatim in June. v2 may add a `proposalContext.regenerate_on_release: true` opt-in for agents that want re-evaluation; v1 keeps it simple.

### 5. Daily-summary integration — no new agent

The existing `daily-summary` agent already reads `data/reports/daily-summary/YYYY-MM-DD.jsonl`. Add `notify(...)` calls in the verdict and queue-processor agents:

- `change-verdict` end-of-run: "X verdicts landed today: A improved, B no_change, C regressed (D reverted, E surfaced for your review)"
- `change-verdict` if any surfaced_for_review: lists the URLs + reasons + window_id
- `change-diff-detector` end-of-run: "X manual edits detected today, opening N new measurement windows"

These flow through the existing 500-char-preview path, so they appear in the morning email automatically.

## Cron placement (additions to `scheduler.js`)

After collectors (so snapshots are fresh), before existing pipeline:

```js
// Step 0a (after collectors run via their own cron entries):
runStep('change-diff-detector', `"${NODE}" agents/change-diff-detector/index.js`);
```

After all daily agent runs (so changes applied today are visible):

```js
// Step 5x (end of daily pipeline, before weekly/monthly blocks):
runStep('change-verdict', `"${NODE}" agents/change-verdict/index.js`);
runStep('change-queue-processor', `"${NODE}" agents/change-queue-processor/index.js`);
```

Adds ~3-5 minutes per day to the existing scheduler.

## Data flow walkthrough — concrete example

**Day 0 (Sunday):** `meta-optimizer` rewrites the title on `/products/coconut-lotion` for query `coconut lotion`.

1. Agent calls `proposeChange({ slug: 'coconut-lotion', changeType: 'title', category: 'experimental' })` → returns `{ action: 'apply', windowId: null, reason: 'no_active_window' }`.
2. Agent fetches current title from Shopify, generates new title, pushes via Shopify API.
3. Agent calls `logChangeEvent({...})`. `lib/change-log.js` opens a new window in `forming` status, captures baseline metrics, writes event + window files.

**Day 1:** `change-diff-detector` runs. Sees the title change in the snapshot, looks up event log, finds the agent's logChangeEvent already exists. Skips.

**Day 2:** `content-strategist` adds an FAQ section to the same page. Window is still in `forming` (within 3-day grouping). Proposal returns `apply`. Event is appended to the same window. Bundle now contains 2 changes.

**Day 4 (after bundle_locked_at):** `product-optimizer` proposes an image swap. Window is now `measuring`. Proposal returns `queue`. Image change is written to `data/changes/queue/coconut-lotion/`. Not pushed to Shopify.

**Day 12:** `link-repair` fixes a broken external link with `category: 'maintenance'`. Proposal returns `apply` (maintenance bypass). Link is fixed. Change_event is logged for audit but the window is unaffected.

**Day 31 (verdict_at):** `change-verdict` runs:
- Reads last 28d of GSC + GA4 snapshots
- Computes deltas: target_query CTR +24%, position −2.1, page_revenue +14%
- Outcome: **improved** (CTR threshold crossed)
- Action: **kept**
- Appends learning to `data/context/feedback.md`

**Day 32:** `change-queue-processor` releases the queued image change. Applies the stored `after` (the proposed image URL) directly via Shopify and opens a new window starting day 32. The originating agent does not need to be re-invoked.

**Daily-summary on Day 31:**

> ✅ **Change-verdict** — 1 verdict landed today: 1 improved (kept). `coconut-lotion` title+FAQ for "coconut lotion": +24% CTR, +14% revenue.
> 📋 **Change-queue** — 1 item released for coconut-lotion (re-evaluating).

If the verdict had been **regressed**:
- Title and meta auto-revertable → system writes `before` back to Shopify.
- `content_body` (FAQ) is in the bundle → `surfaced_for_review` instead. Daily summary: "1 verdict landed today: 1 regressed — coconut-lotion title+FAQ surfaced for your review (regression: -28% CTR, -22% revenue). Inspect at `data/reports/change-verdict/coconut-lotion-2026-05-26.md`."

## Migration plan for `meta-ab-tracker`

The existing `meta-ab-tracker` is the established precedent for this pattern at the meta-tag level. Its window-and-revert logic generalizes into `lib/change-log.js`. After this spec is implemented:

- `lib/change-log.js` provides `getCTRsForPage`, `computeCTRDelta`, `revertField`, etc. (extracted from meta-ab-tracker)
- `agents/meta-ab-tracker/index.js` becomes a thin caller: when the user runs the meta-optimizer flow, it calls `lib/change-log.js` to open a window. The verdict-and-revert logic is the shared code path.
- Backwards-compatible: existing `data/meta-tests/` files are read by the new code path during the transition. After 60 days no new entries are written there; tests in flight finish on the old code path.

## Risks and open questions

- **Snapshot lag.** GSC data lags ~3 days. The verdict agent must read snapshots ≥3 days old at the verdict timestamp. The 28-day window already absorbs this.
- **Sparse-data verdicts.** A page with low traffic (e.g., 50 impressions/month) will produce noisy verdicts. The verdict agent will tag these as `inconclusive` rather than make claims. v1 doesn't filter them; v2 may add an "insufficient data" outcome.
- **Concurrent agents racing on the same page.** Two agents both reading `proposeChange` for the same slug at the same time could both get `action: 'apply'` if there's no lock. The scheduler runs agents sequentially in `scheduler.js`, so this is unlikely in practice. Still, `lib/change-log.js` should write atomically (write-temp-then-rename) to avoid corrupted index.json.
- **Multi-target-query bundles.** If a single page has 3 changes targeting 3 different queries, the verdict aggregates over the union of target queries. Per-query verdicts could be richer but add complexity. v1 ships the union; per-query split is v2.
- **Revert failures.** Auto-revert calls Shopify API which can fail (rate limit, schema changed, etc.). The verdict agent must surface revert errors to the daily summary as a hard failure, not silently leave the page in the "loser" state.

## References

- Current precedent: `agents/meta-ab-tracker/index.js`
- Existing snapshots: `data/snapshots/{gsc,ga4}/YYYY-MM-DD.json`
- Existing notification flow: `lib/notify.js` + `agents/daily-summary`
- Existing feedback loop: `data/context/feedback.md` + `agents/insight-aggregator`
