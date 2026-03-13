# Cannibalization Resolver Report — Real Skin Care
**Run date:** March 8, 2026  
**Window:** Last 90 days | Min impressions: 50  
**Mode:** APPLIED  
**Blog-vs-blog groups found:** 116  

## Summary

| | Count |
|---|---|
| 🟢 HIGH confidence decisions | 7 |
| 🟡 MEDIUM confidence (manual review) | 11 |
| 🔴 LOW confidence (manual review) | 2 |
| ↩️ Redirects created | 0 |
| 🔀 Consolidated drafts saved | 2 |
| 👁️ Monitor / skip | 15 |

## Actions Taken

| Query | Loser | Winner | Action | Status |
|---|---|---|---|---|
| sls free toothpaste | /blogs/news/best-toothpaste-without-sls-2025 | /blogs/news/best-sls-free-toothpaste-2025 | CONSOLIDATE | ✅🔀 draft_saved |
| sls free toothpaste | /blogs/news/best-toothpaste-without-sls-2025 | /blogs/news/best-sls-free-toothpaste-2025 | CONSOLIDATE | ⏭️ redirect_exists |
| best sls free toothpaste | /blogs/news/best-toothpaste-without-sls-2025 | /blogs/news/best-sls-free-toothpaste-2025 | REDIRECT | ⏭️ redirect_exists |
| sls free toothpaste list | /blogs/news/best-toothpaste-without-sls-2025 | /blogs/news/best-sls-free-toothpaste-2025 | REDIRECT | ⏭️ redirect_exists |
| best clean body lotion | /blogs/news/best-non-toxic-body-lotion-2025 | /blogs/news/best-clean-body-lotion-2025 | CONSOLIDATE | ✅🔀 draft_saved |
| best clean body lotion | /blogs/news/best-non-toxic-body-lotion-2025 | /blogs/news/best-clean-body-lotion-2025 | CONSOLIDATE | ⏭️ redirect_exists |
| all natural toothpaste | /blogs/news/best-toothpaste-without-sls-2025 | /blogs/news/best-natural-toothpaste-2025 | REDIRECT | ⏭️ redirect_exists |
| best toothpaste without sls | /blogs/news/best-toothpaste-without-sls-2025 | /blogs/news/best-sls-free-toothpaste-2025 | REDIRECT | ⏭️ redirect_exists |

> **⚠️ 2 consolidated post(s) saved as drafts.** Review and publish in Shopify admin → Blog Posts → Drafts.

## Resolution Decisions

### 🟢 "sls free toothpaste"
**Winner:** `/blogs/news/best-sls-free-toothpaste-2025`  
**Confidence:** HIGH — Winner has 2x the impressions and more clicks; consolidate the synonym post into the winner to unify all ranking signals.

- 🔀 **CONSOLIDATE** `/blogs/news/best-toothpaste-without-sls-2025` *(applied)* — Loser targets the same intent with a synonym URL and has minimal unique traffic, but any unique content sections should be merged into the winner before redirecting.

### 🟢 "best sls free toothpaste"
**Winner:** `/blogs/news/best-sls-free-toothpaste-2025`  
**Confidence:** HIGH — Winner dominates at position 5 with 17 clicks; redirect the synonym duplicate and leave the natural toothpaste post alone as a separate intent.

- ↩️ **REDIRECT** `/blogs/news/best-toothpaste-without-sls-2025` *(applied)* — Ranks far lower (pos 42 vs pos 5) with zero clicks and is a near-duplicate synonym post adding no unique value.
- 👁️ **MONITOR** `/blogs/news/best-natural-toothpaste-2025` *(applied)* — Targets a broader 'natural toothpaste' intent that warrants its own page; only appearing here incidentally with negligible impressions.

### 🟡 "natural toothpaste"
**Winner:** `/blogs/news/best-natural-toothpaste-2025`  
**Confidence:** MEDIUM — Winner holds the primary 'natural toothpaste' intent with 772 impressions; monitor the SLS-free post's incidental ranking rather than redirecting a high-performing page.

- 👁️ **MONITOR** `/blogs/news/best-toothpaste-without-sls-2025` — The SLS-free post ranks well (pos 2.8) for this query on a small impression slice, suggesting genuine topical overlap but a distinct sub-intent worth watching before acting.

### 🟢 "sls free toothpaste list"
**Winner:** `/blogs/news/best-sls-free-toothpaste-2025`  
**Confidence:** HIGH — Winner clearly owns this query; redirecting the weaker synonym post will consolidate list-intent signals and likely improve position further.

- ↩️ **REDIRECT** `/blogs/news/best-toothpaste-without-sls-2025` *(applied)* — Winner outperforms at position 5.4 with 10 clicks vs position 14.9 with 1 click; synonym duplicate splits list-intent signals.

### 🟡 "dr bronner alternative"
**Winner:** `/blogs/news/best-dr-bronners-alternatives-2025`  
**Confidence:** MEDIUM — Both pages target related but distinct intents (brand alternatives broadly vs. toothpaste specifically); monitor to confirm they don't cannibalize before consolidating.

- 👁️ **MONITOR** `/blogs/news/best-dr-bronner-s-toothpaste-alternatives-2025` — The toothpaste-specific alternatives post targets a narrower product sub-intent (toothpaste only) that is genuinely different from the broader brand-alternative query.

### 🟡 "fluoride free toothpaste"
**Winner:** `/blogs/news/best-natural-toothpaste-2025`  
**Confidence:** MEDIUM — The natural toothpaste post dramatically outperforms the dedicated fluoride-free post; consolidate fluoride-free content there and monitor the SLS post's minor presence.

- 🔀 **CONSOLIDATE** `/blogs/news/best-fluoride-free-toothpaste-2025` — Despite its keyword-exact URL, this post ranks at position 73 with zero clicks while the natural toothpaste post ranks at position 2.5; merge any unique fluoride-free content into the winner.
- 👁️ **MONITOR** `/blogs/news/best-toothpaste-without-sls-2025` — Ranks well (pos 3.9) on very few impressions for this query, likely incidental; primary action is the fluoride-free post consolidation.

### 🔴 "best fluoride free toothpaste"
**Winner:** `/blogs/news/best-fluoride-free-toothpaste-2025`  
**Confidence:** LOW — The dedicated fluoride-free post owns 99% of impressions for this query but ranks at position 72, signaling a content quality issue to fix on the winner rather than a cannibalization problem to resolve.

- 👁️ **MONITOR** `/blogs/news/best-toothpaste-without-sls-2025` — Only 1 impression for this query on the SLS post; no meaningful cannibalization occurring at this scale.

### 🟡 "best fluoride-free toothpaste brands 2025"
**Winner:** `/blogs/news/best-fluoride-free-toothpaste-2025`  
**Confidence:** MEDIUM — Fluoride-free post is the correct canonical for this brand-list query; consolidating overlapping natural toothpaste content will strengthen its weak position-11 ranking.

- 🔀 **CONSOLIDATE** `/blogs/news/best-natural-toothpaste-2025` — Natural toothpaste post overlaps heavily on brand-list intent and splits signals; merge any unique brand coverage into the fluoride-free winner.
- 👁️ **MONITOR** `/blogs/news/best-sls-free-toothpaste-2025` — Only 2 impressions; negligible cannibalization from the SLS post on this query.

### 🟢 "best clean body lotion"
**Winner:** `/blogs/news/best-clean-body-lotion-2025`  
**Confidence:** HIGH — Winner has 97% of impressions and the only click; consolidate the non-toxic synonym post to unify lotion-related ranking signals.

- 🔀 **CONSOLIDATE** `/blogs/news/best-non-toxic-body-lotion-2025` *(applied)* — 'Non-toxic' and 'clean' lotion posts target near-identical purchase intent; merge any unique product picks or sections into the winner, then redirect.

### 🟡 "best natural toothpaste"
**Winner:** `/blogs/news/best-natural-toothpaste-2025`  
**Confidence:** MEDIUM — Natural toothpaste post owns this query; the Dr. Bronner's post is not a real cannibalization threat but should improve the winner's position-66 ranking through content optimization.

- 👁️ **MONITOR** `/blogs/news/best-dr-bronner-s-toothpaste-alternatives-2025` — Only 1 impression; the Dr. Bronner's alternatives post serves a brand-specific sub-intent that doesn't materially cannibalize the natural toothpaste query.

### 🟡 "benefits of coconut oil on skin everyday"
**Winner:** `/blogs/news/coconut-oil-for-skin-ultimate-guide-to-benefits-and-potential-downsides`  
**Confidence:** MEDIUM — The skin guide holds 99% of impressions and is the correct winner; monitor the lotion post as a distinct sub-intent rather than redirecting.

- 👁️ **MONITOR** `/blogs/news/benefits-of-using-coconut-oil-lotion` — Only 1 impression; the coconut lotion post targets a product-specific angle (lotion format) distinct from the general skin-benefits guide intent.

### 🟡 "coconut lotion benefits"
**Winner:** `/blogs/news/benefits-of-using-coconut-oil-lotion`  
**Confidence:** MEDIUM — The lotion benefits post leads with the only click; consolidate the general skin guide's overlapping content and monitor the moisturizer post for a potentially distinct intent.

- 🔀 **CONSOLIDATE** `/blogs/news/coconut-oil-for-skin-ultimate-guide-to-benefits-and-potential-downsides` — The skin guide overlaps on benefit content but covers a broader scope; migrate any lotion-specific benefit sections into the winner before redirecting.
- 👁️ **MONITOR** `/blogs/news/is-coconut-oil-a-good-moisturizer-exploring-the-benefits-and-uses-of-coconut-oil-for-skin` — The moisturizer post targets a slightly different is-it-effective angle; review content overlap manually before deciding to merge.

### 🟢 "all natural toothpaste"
**Winner:** `/blogs/news/best-natural-toothpaste-2025`  
**Confidence:** HIGH — Natural toothpaste post owns this query; the SLS post's redirect (already recommended above) will resolve this cannibalization automatically.

- ↩️ **REDIRECT** `/blogs/news/best-toothpaste-without-sls-2025` *(applied)* — SLS-free post appears incidentally on this query with only 3 impressions and is already being redirected for the primary SLS queries, so it should redirect to the natural toothpaste winner.

### 🟡 "coconut oil soap"
**Winner:** `/blogs/news/coconut-soap-benefits-discover-the-wonders-of-coconut-oil-in-soap`  
**Confidence:** MEDIUM — The benefits post ranks far better (pos 1.3 vs 30.2); keep the DIY recipe post separate as it serves a distinct transactional/informational sub-intent.

- 👁️ **MONITOR** `/blogs/news/diy-coconut-oil-soap-benefits-recipe-essential-tips-for-perfect-bars` — The DIY soap recipe post targets a distinct make-it-yourself intent with unique recipe content that warrants its own page rather than a redirect.

### 🟡 "coconut oil moisturizer"
**Winner:** `/blogs/news/is-coconut-oil-a-good-moisturizer-exploring-the-benefits-and-uses-of-coconut-oil-for-skin`  
**Confidence:** MEDIUM — The moisturizer-specific post is the correct canonical for this query despite its weak position-53 ranking; consolidating the lotion post's overlapping content should strengthen it.

- 🔀 **CONSOLIDATE** `/blogs/news/benefits-of-using-coconut-oil-lotion` — The lotion benefits post overlaps heavily on moisturizing use-case content; merge relevant sections into the moisturizer post and redirect to consolidate signals.

### 🟢 "best toothpaste without sls"
**Winner:** `/blogs/news/best-sls-free-toothpaste-2025`  
**Confidence:** HIGH — Clear winner by position and clicks despite the loser having the exact-match URL slug; redirect immediately to unify signals.

- ↩️ **REDIRECT** `/blogs/news/best-toothpaste-without-sls-2025` *(applied)* — The SLS-free post ranks at position 2.4 with clicks while the synonym URL post ranks at position 23.9 with zero clicks; the weaker synonym URL should redirect to the winner.

### 🟡 "coconut oil as moisturizer"
**Winner:** `/blogs/news/is-coconut-oil-a-good-moisturizer-exploring-the-benefits-and-uses-of-coconut-oil-for-skin`  
**Confidence:** MEDIUM — The moisturizer post better matches this intent and earned the only click; consolidate the lotion post's overlapping moisturizer content to strengthen the winner's weak position-38 ranking.

- 🔀 **CONSOLIDATE** `/blogs/news/benefits-of-using-coconut-oil-lotion` — Lotion benefits post has higher impressions for this query but the moisturizer post holds the only click and more specifically matches the intent; merge overlapping moisturizer content from the lotion post into the winner.

### 🔴 "can i use coconut oil as lotion"
**Winner:** `/blogs/news/benefits-of-using-coconut-oil-lotion`  
**Confidence:** LOW — The lotion post better matches the lotion-substitution intent but both posts rank poorly; manual content review is needed before consolidating these coconut oil moisturizer posts.

- 👁️ **MONITOR** `/blogs/news/is-coconut-oil-a-good-moisturizer-exploring-the-benefits-and-uses-of-coconut-oil-for-skin` — This query has a 'can I use it as lotion' intent that the lotion post addresses more directly; the moisturizer post covers overlapping ground but may warrant its own page for the moisturizer-specific angle.

### 🟡 "coconut oil lotion"
**Winner:** `/blogs/news/benefits-of-using-coconut-oil-lotion`  
**Confidence:** MEDIUM — The lotion benefits post is the best canonical for this query; consolidate the moisturizer and roundup posts while keeping the stretch marks post as a distinct sub-intent.

- 🔀 **CONSOLIDATE** `/blogs/news/is-coconut-oil-a-good-moisturizer-exploring-the-benefits-and-uses-of-coconut-oil-for-skin` — The moisturizer post overlaps heavily with the lotion post on coconut oil skincare use-cases; merge relevant lotion-use content into the winner and redirect.
- 🔀 **CONSOLIDATE** `/blogs/news/coconut-oil-body-lotion-that-actually-works-for-dry-skin-2025-roundup` — Product roundup for dry skin lotion overlaps directly with the winner's topic; merge any unique product recommendations into the winner before redirecting.
- 👁️ **MONITOR** `/blogs/news/is-coconut-oil-good-for-stretch-marks-using-coconut-oil-for-pregnancy-stretch-marks` — The stretch marks post targets a highly specific use-case sub-intent (pregnancy/stretch marks) that is genuinely distinct from general coconut oil lotion content.

### 🟢 "best natural toothpaste for sensitive teeth 2025 or 2026"
**Winner:** `/blogs/news/best-toothpaste-for-sensitive-teeth-2025`  
**Confidence:** HIGH — The sensitive-teeth post is the clear topical winner for this specific query; monitor the natural toothpaste post to ensure sensitive-teeth content isn't duplicated across both pages.

- 👁️ **MONITOR** `/blogs/news/best-natural-toothpaste-2025` *(applied)* — The sensitive-teeth post is the correct specific match for this query; the general natural toothpaste post serves a broader intent and should not be redirected, but sensitive-teeth content should not live on both pages.
