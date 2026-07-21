# Klaviyo Flows — Update Plan (all live flows)

**Date:** 2026-07-20
**Author:** overnight audit for Sean
**Scope:** the 5 live flows besides the new Post-Purchase flow (which is done/live).
**Status:** plan for review — nothing executed except one live-defect fix (below).

---

## TL;DR

All five live flows work but are dated (mostly ~Oct 2024–Feb 2025), inconsistent
with the new Post-Purchase quality bar, and leave revenue on the table. The biggest
issues: **Browse Abandonment links to a staging domain and isn't personalized**, the
**Product Review flow now double-fires against the Post-Purchase review email**, and
**preview text is empty almost everywhere** (a pure CTR leak). None of them use the
$50 free-shipping lever. Discounts in play are all free-shipping except Winback's flat
25%.

**One thing already fixed tonight (live defect I introduced):** Post-Purchase Email 4
referred friends to code `NEWCUS`, which **does not exist** in Shopify. The real active
code is `NEWCUSTOMER` (free shipping). Corrected and re-pushed. (Note: the site's
homepage banner also promises `NEWCUS` — a separate theme bug worth fixing.)

---

## Cross-cutting findings (apply to every flow)

1. **Empty preview text** on nearly all emails — prime inbox real estate wasted. Add to every send. (Fastest, highest-ROI fix across the board.)
2. **Domain inconsistency** — Browse Abandonment links to `realskincare-com.myshopify.com` (staging); others mix `realskincare.com` and `www.realskincare.com`. Standardize to `https://www.realskincare.com`.
3. **No $50 free-ship lever** — none of these flows nudge toward free shipping. Add "you're $X from free shipping" / "ships free over $50" where a cart or product is in play (cart, browse, welcome).
4. **Conversion path per email (Prime Directive)** — several emails (social-follow, brand-story, some welcome steps) have no product/collection CTA or buy path. Every email needs one.
5. **Brand voice & design drift** — mix of old `SYSTEM_DRAGGABLE` templates with dated copy. Bring all to the Post-Purchase bar (founder voice, clean responsive HTML, single primary CTA, free-ship framing).
6. **Dynamic personalization** — Browse Abandonment hardcodes 3 products instead of the viewed product; refresh to event-driven blocks. (Abandoned Cart already loops cart line-items correctly — good.)
7. **Flow coordination / smart-sending** — a single customer can now be enrolled in overlapping flows (see coordination map). Ensure smart-sending + timing prevent same-day pile-ups.
8. **Discount hygiene** — the store has ~50 codes, most EXPIRED (old WEL-xxx welcome uniques, influencer codes, seasonal). Clutter + the dead `NEWCUS` banner promise. Worth a cleanup pass.

---

## Coordination map — who triggers when (post-Post-Purchase)

| Customer event | Flow | Timing |
|---|---|---|
| Signs up (Email List) | Welcome Series | immediate → ~5 days |
| Viewed Product | Browse Abandonment | 6 hr |
| Checkout Started | Abandoned Cart | 4 hr → 2 days |
| **Placed Order** | **Post-Purchase** (new) | 1 hr → 35 days |
| Placed Order | Customer Winback | 75 → 90 days |
| Fulfilled Order | Product Review / Cross-Sell | 14 days |

⚠️ **Overlap:** Post-Purchase asks for a review at ~Day 10 (after Placed Order); Product
Review asks again at Fulfilled Order + 14 days (≈ Day 17–21). Two review asks within a
week. **Must reconcile** (Decision #1).

---

## Flow-by-flow plan

### 1. Welcome Series — `WMhLtj` (live · trigger: Email List signup)

**Now:** 7 emails. E1 Welcome + `SHIPFREE` (free-ship, active ✓). Split on open →
Brand Story / resend-to-non-openers (good tactic). Then Social-Follow, Bestsellers,
USPs, and a stray "Email #7". **Emails #6 and #7 are unfinished drafts** (placeholder
subjects "Email #6 Subject"). Brand Story (founder Sean + Julie, 20 yrs) is strong.

**Problems:** 2 unfinished drafts; "Follow us on social media!" as a standalone email
(low commercial intent); Bestsellers email links only to the homepage (no PDP/collection);
empty preview text throughout; no $50 free-ship framing; no clear buy path on several steps.

**Plan:** Tighten to a focused **5-email** series, all on-brand with preview text:
1. Welcome + `SHIPFREE` + CTA into the top-converting collection (not homepage).
2. Brand Story (keep; add a product CTA + buy path).
3. Bestsellers → link real bestseller PDPs / a "best sellers" collection.
4. Social proof / Judge.me reviews + a product CTA.
5. Last-chance on `SHIPFREE` + bestseller.
Move "follow us on social" into the footer (not its own email). Delete draft #6/#7.
Keep the non-opener resend split.

---

### 2. Abandoned Cart — `SVn26v` (live · trigger: Checkout Started)

**Now:** 4 hr → A/B test → 2 days → Email #2. Two core emails + A/B variants. Dynamic
`{% for item in event.extra.line_items %}` cart loop + "Return to cart" (dynamic checkout
URL) — functional. Preview text set (one of the few). Copy stale (Oct 2024).

**Problems:** recovers **Checkout Started** only (misses earlier cart-adders); no product
images (text-only item loop); no $50 free-ship nudge; only 2 touches; generic copy.

**Plan:** Refresh copy + design to brand bar; keep the dynamic cart loop, **add product
images**; add a **"you're $X from free shipping"** nudge; add a **3rd touch** (~Day 3);
keep/refresh the A/B test. Free-ship framing only — no price discount (per strategy).
Consider a separate lighter "Added to Cart" trigger later (out of scope v1).

---

### 3. Browse Abandonment — `WSWAUX` (live · trigger: Viewed Product) — **highest urgency**

**Now:** 6 hr → single email. **Links point to the staging domain**
`realskincare-com.myshopify.com`, and it **hardcodes 3 products** (lotion, hand soap,
toothpaste) instead of the product the person actually viewed. No preview text.

**Problems:** staging-domain links (unprofessional, tracking/SEO risk — they 301 to live
but shouldn't be there); zero personalization (defeats the purpose of browse abandonment);
single minimal touch.

**Plan:** Rebuild around a **dynamic viewed-product block** (event-driven: image + title +
PDP link on `www.realskincare.com`); fix **all** URLs to the live www domain; add preview
text; add a bestseller fallback + **$50 free-ship** nudge; consider a 2nd touch. Add a
smart-sending guard so it doesn't collide with Abandoned Cart.

---

### 4. Customer Winback — `T4FNSc` (live · trigger: Placed Order + 75 days)

**Now:** 75 d → Email 1 (soft; uses a popular-products feed — good) → 15 d → Email 2
(**`ComeBack25` = 25% off**, active ✓). No preview text.

**Problems:** flat 25% is a heavy margin hit; no preview text; only 2 emails; timing not
validated against real repurchase cycle.

**Plan:** Refresh copy/design; keep the product feed; add preview text. **Discount ladder
(Decision #2):** lead softer (free-ship `SHIPFREE` or 15%) and reserve `ComeBack25` (25%)
for the final "last chance" touch — softer on margin, stronger urgency. Optionally add a
3rd last-chance email with an expiry.

---

### 5. Product Review / Cross-Sell — `UgeSBy` (live · trigger: Fulfilled Order + 14 days)

**Now:** single review-request email, 14 days after fulfillment. No explicit review CTA
link found in the template (relies on a Klaviyo block or is missing) — needs a proper
Judge.me deep link. No preview text.

**Problem:** **Directly overlaps the new Post-Purchase flow's review ask.** Two asks within
a week is spammy and splits response.

**Plan (Decision #1):** Reconcile ownership of the review ask. Recommended:
**Fulfilled Order is the better trigger** for a review (the customer has actually received
the product), so make *this* flow the review engine — upgrade it with a Judge.me deep link
+ a cross-sell/replenish block + preview text — and **remove the review ask from
Post-Purchase Email 4** (revert it to referral-only, or repurpose). That gives one
well-timed review ask instead of two.

---

## Discounts in play (verified active)

| Code | Type | Used by |
|---|---|---|
| `SHIPFREE` | Free shipping | Welcome E1 |
| `NEWCUSTOMER` | Free shipping (new customers) | Post-Purchase E4 referral (fixed from `NEWCUS`) |
| `SETSHIP` | Free shipping, $45 min, once/cust | Post-Purchase E3 bundle |
| `ComeBack25` | **25% off** | Winback E2 |

Everything is free-shipping except Winback's 25% — consistent with the "free shipping, not
price discounts" posture, with reactivation as the one exception. ~30 expired codes clutter
the store; the homepage banner promises the non-existent `NEWCUS`.

---

## Proposed build sequence (one flow per PR, test-one-email-first, draft → review → live)

1. **Browse Abandonment** — worst state (staging links + no personalization); fastest win.
2. **Product Review reconciliation** — resolve the overlap (Decision #1) before it sends twice.
3. **Abandoned Cart** — refresh + images + free-ship nudge + 3rd touch.
4. **Welcome Series** — trim to 5, finish drafts, add preview text + buy paths.
5. **Winback** — refresh + discount ladder (Decision #2).

Each built the same headless way as Post-Purchase (`lib/klaviyo.js`), created/edited as
draft, verified (no orphan links, all CTAs 200, conditionals render), then set live on your
OK. Cross-cutting fixes (preview text, domain, free-ship) fold into each flow's rebuild.

---

## DECISIONS NEEDED (for the morning)

1. **Review-ask overlap (Post-Purchase vs Product Review).** Recommend: dedicated Product
   Review flow owns it (fires on Fulfilled Order = better timing); remove the review ask
   from Post-Purchase Email 4. OK?
2. **Winback discount.** Keep flat 25% (`ComeBack25`), or move to an escalating ladder
   (free-ship/15% first, 25% only as the closer)? Recommend the ladder.
3. **Welcome offer.** Keep `SHIPFREE` (free shipping) as the welcome incentive, or switch to
   a % (there's an expired 30% "Welcome_30" history)? Recommend keep free-ship.
4. **Abandoned Cart.** Add a 3rd touch? Free-ship framing only, or any incentive on the
   final email? Recommend 3rd touch, free-ship framing, no discount.
5. **Browse Abandonment.** One email or add a 2nd touch? Recommend 2 touches.
6. **Overall discount posture.** Confirm: price discounts only for winback/reactivation,
   free-shipping everywhere else (welcome, cart, browse, post-purchase)?
7. **Editor type.** OK to rebuild these as code-based templates like Post-Purchase? Gains:
   consistency + version control. Loses: Klaviyo drag-and-drop editing on those emails.
8. **Homepage banner.** Fix the theme's `NEWCUS` → `NEWCUSTOMER` (live site currently
   promises a dead code)?
9. **Discount cleanup.** Archive the ~30 expired codes cluttering the store?

---

## Appendix — raw audit data
`scripts/post-purchase-flow/audit-flows.js` regenerates `flow-audit.json` (full graph,
subjects, links, copy samples) for any flow.
