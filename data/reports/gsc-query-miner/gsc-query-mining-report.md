# GSC Query Mining Report — Real Skin Care
**Run date:** July 27, 2026  
**Window:** Last 90 days  
**Impression threshold:** 50+  
**Total queries in GSC:** 5000  

---
# Real Skin Care — SEO Action Plan (Last 90 Days)

---

## Executive Summary

- **Cannibalization is the single biggest revenue leak.** The "sls free toothpaste" topic alone has 4 competing blog posts splitting ~11,826 impressions across fragmented URLs. Consolidating these into one authoritative page could 3–5× clicks overnight without creating a single new word of content.
- **Two queries ranking #3 generate zero clicks**, meaning the title/meta or SERP feature is completely misaligned with what searchers expect to find. "Are coconut oil toothpastes safe for sensitive teeth?" (414 impressions, pos #3, 0 clicks) and "are coconut oil toothpastes effective for everyday use?" (341 impressions, pos #3, 0 clicks) are the most urgent title/meta fixes in the dataset.
- **The lotion category is nearly invisible despite real demand.** "Coconut lotion" (1,111 impressions, pos #30), "coconut body lotion" (861 impressions, pos #23), and "clean body lotion" (500 impressions, pos #20) are all ranking too low to generate clicks and pointing to no clearly optimized landing page. The lotion cluster has 17,756 impressions and only 42 clicks — a 0.24% CTR.
- **The tattoo soap opportunity is being wasted on duplicate URLs.** Four separate pages compete for "best soap for tattoos," collectively ranking around position 10–15 with minimal clicks. One consolidated, authoritative page could realistically reach top 5.
- **The "2026" content cluster shows early traction with nearly zero payoff** (11,318 impressions, 5 clicks, avg pos #9.1). Dated blog posts are already pulling impressions, but CTR is catastrophically low — likely a title/freshness mismatch that needs immediate attention before a competitor locks in those rankings.

---

## Impression Leaks — Action Plan

### Group 1: Ranking Too Low to Matter (Positions 20–50) — Need Ranking Lift

**Queries:** `coconut lotion` (#30.3), `coconut body lotion` (#23.5), `clean body lotion` (#20.1), `best clean body lotion` (#18.2), `chemical free body lotion` (#29.9), `body lotion without chemicals` (#30.4), `best natural body lotion` (#40.4), `coconut body cream` (#24.1)

**Root Cause:** No single optimized collection or pillar page is consolidating authority for the lotion category. Multiple collection URLs (`/collections/natural-body-lotion`, `/collections/organic-body-lotion`, `/collections/best-non-toxic-body-lotion`, `/collections/non-toxic-body-lotion`) are splitting signals at positions 50–75, ensuring none rank.

**Action:** 301-redirect `/collections/organic-body-lotion`, `/collections/best-non-toxic-body-lotion`, and `/collections/non-toxic-body-lotion` into a single canonical page at `/collections/natural-body-lotion`. Rewrite that page's title to `Natural Coconut Body Lotion — Chemical Free & Clean | Real Skin Care`, expand its on-page copy to 300+ words covering "coconut body lotion," "clean body lotion," and "chemical free" language, and add internal links from all coconut oil blog posts.

---

### Group 2: Wrong SERP Intent — Informational Queries Landing on Product/Collection Pages

**Queries:** `coconut for the skin` (#11.8), `coconut oil for face` (#20), `coconut oil for body` (#36), `coconut moisturizer for face` (#31.1), `coconut oil face moisturizer` (#29.6)

**Root Cause:** These are informational/research-phase queries ("how does coconut oil help skin?"). If they're resolving to product or collection pages, searchers won't click because the page won't look like the answer to their question.

**Action:** Create or designate one existing blog post as the canonical "Coconut Oil for Skin: Benefits, Uses & How to Apply" guide at `/blogs/news/coconut-oil-for-skin`. It should cover face, body, and moisturizing use cases in distinct H2 sections, naturally targeting all five queries above. Add product CTAs mid-post. Internal-link to it from every coconut product page.

---

### Group 3: High-Position, Zero-Click — Title/Meta Mismatch (Urgent)

**Queries:** `are coconut oil toothpastes safe for sensitive teeth?` (#3, 414 impressions, 0 clicks), `are coconut oil toothpastes effective for everyday use?` (#3, 0 clicks), `coconut oil as toothpaste` (#8.9, 495 impressions, 0 clicks), `best coconut oil toothpaste for a natural oral care routine.` (#4.7, 275 impressions, 0 clicks)

**Root Cause:** Ranking in the top 5 with zero clicks means the title tag or meta description is failing to match search intent or is being outcompeted by rich SERP features (featured snippets, People Also Ask boxes). The page at `/blogs/news/can-you-use-coconut-oil-as-toothpaste` is surfacing for question-format queries but not earning the click.

**Action:** Rewrite the title tag of `/blogs/news/can-you-use-coconut-oil-as-toothpaste` to directly answer the question: `Is Coconut Oil Toothpaste Safe & Effective? | Real Skin Care`. Rewrite the meta description to lead with a direct answer: *"Yes — coconut oil toothpaste is safe for sensitive teeth and effective for daily use. Here's what the research says."* Add a structured FAQ schema block with direct answers to the two question-format queries to compete for the PAA box and featured snippet. Also add an H2 that reads "Is Coconut Oil Toothpaste Safe for Sensitive Teeth?" with a 40–60 word direct answer immediately below it.

---

### Group 4: No Dedicated Page Exists

**Queries:** `cinnamon toothpaste` (#41.9), `cinnamon sensitive toothpaste` (#27.3), `cinnamon toothpaste for sensitive teeth` (#23.8), `cinnamon toothpaste brands` (#34.8), `cinnamon flavored toothpaste` (#39)

**Root Cause:** Real Skin Care appears to sell or feature a cinnamon toothpaste, but there's no dedicated content or landing page targeting this keyword cluster. Positions in the 24–42 range with 282–500 impressions each confirm Google knows the site is relevant but has no strong target page to rank.

**Action:** Create `/blogs/news/best-cinnamon-toothpaste-for-sensitive-teeth` targeting the full cluster. Structure it as a listicle/guide covering: what makes a good cinnamon toothpaste, whether cinnamon is safe for sensitive teeth (answer: yes, and explain why), and a list of top options with Real Skin Care's product featured first. Target H1: "Best Cinnamon Toothpaste for Sensitive Teeth (2026 Guide)." This single post captures all five queries simultaneously.

---

### Group 5: Category Pages Ranking for Wrong-Funnel Queries

**Queries:** `all natural lip balm` (#48.3), `best soap for women` (#11.9), `coconut hand soap` (#25.6), `coconut deodorant` (#30.5), `coconut oil bar soap` (#20.7)

**Root Cause:** These transactional queries need optimized collection or product pages, not blog content. Positions 11–48 suggest Google is ranking whatever page it can find, not a purpose-built landing page.

**Action:** Audit whether dedicated collection pages exist for each of these:
- `/collections/lip-balm` → title: `All Natural Lip Balm — Real Skin Care`
- `/collections/bar-soap` → title: `Coconut Oil Bar Soap for Women | Real Skin Care`
- `/collections/deodorant` → title: `Natural Coconut Deodorant — Aluminum Free | Real Skin Care`
- `/collections/hand-soap` → title: `Coconut Hand Soap — Natural & Gentle | Real Skin Care`

If collection pages exist, rewrite title tags and add 150-word descriptive copy to each. If they don't exist, create them and redirect any orphan product pages into the correct collection.

---

## Near-Miss Opportunities

### 1. `sls free toothpaste list` — 5,922 impressions, pos #8.1, 55 clicks, 0.9% CTR

**What's holding it back:** The page ranking here (`/blogs/news/best-toothpaste-without-sls-2025`) is competing with three other internal URLs, diluting link equity. Position #8 with 0.9% CTR suggests the title isn't signaling "list" format.

**Actions to push to pos #2–3:**
- Consolidate all SLS toothpaste content (see cannibalization section) into `/blogs/news/toothpaste-without-sls-what-to-know-best-options` which already sits at pos #4.8 for this query.
- Rewrite the title to include the word "List": `SLS-Free Toothpaste List: 12 Best Options in 2026 | Real Skin Care`.
- Add a numbered HTML list (not just bullet points) of SLS-free brands near the top of the post with a comparison table — this is the format that earns featured snippets for list queries.
- Add 5 internal links pointing to the canonical URL from the redirected pages.

---

### 2. `best sls free toothpaste` — 3,179 impressions, pos #5.9, 90 clicks, 2.8% CTR

**What's holding it back:** Already the best performer in the near-miss group, but pos #5.9 with 2.8% CTR means moving to #2–3 could deliver 200–300 clicks from this query alone.

**Actions:**
- After cannibalization consolidation, all link equity flows to one URL. That alone may push this into the top 3.
- Add a "Best SLS-Free Toothpaste" comparison table near the top (product name, key benefit, fluoride Y/N, price range) — this format matches the transactional intent and can earn a featured snippet.
- Add 3 external links to authoritative dental sources citing SLS sensitivity research to boost E-E-A-T.
- Refresh the publish date and add a "Last Updated: [current month] 2026" tag visibly in the post.

---

### 3. `coconut oil deodorant` — 1,008 impressions, pos #9.2, 5 clicks, 0.5% CTR

**What's holding it back:** 0.5% CTR at position #9 is well below the expected ~2% for that position, pointing to a title mismatch. The page likely answers "can you use coconut oil as deodorant" (an informational question) but this query has commercial intent.

**Actions:**
- Identify which URL ranks for this query (likely the coconut oil deodorant blog post). Check if it's an informational post ranking for a transactional query — if so, create or strengthen the `/collections/deodorant` page with "coconut oil deodorant" in the title and H1.
- Add "Shop Our Coconut Oil Deodorant" CTA with a product card near the top of the blog post so even informational visitors convert.
- Build 3 internal links from coconut oil topic posts to the deodorant collection page using anchor text "coconut oil deodorant."

---

### 4. `what soap to use for tattoo` — 622 impressions, pos #8.1, 4 clicks, 0.6% CTR

**What's holding it back:** Low CTR at pos #8 suggests title isn't clearly answering the question. Searchers want a direct recommendation, not a general guide.

**Actions:**
- After consolidating the tattoo soap cannibalization (see below), the surviving page title should lead with the answer: `Best Soap for Tattoos: What to Use for Safe Healing | Real Skin Care`.
- Add a TL;DR box at the very top of the post: *"The best soap for a new tattoo is fragrance-free, sulfate-free bar soap. Here's why and what to look for."* Google often pulls this into the featured snippet, improving both ranking and CTR.
- Add FAQ schema for "what soap should I use on a new tattoo" directly answering in 40 words.

---

### 5. `coconut oil as deodorant` — 860 impressions, pos #6.5, 13 clicks, 1.5% CTR

**What's holding it back:** Competing with related queries across possibly multiple pages. The page serving this query needs to be clearly the most comprehensive answer.

**Actions:**
- Expand the existing post with a dedicated section titled "How to Use Coconut Oil as Deodorant (Step-by-Step)" — this directly targets the how-to intent embedded in this query and can capture a featured snippet.
- Add a FAQ section answering: "Does coconut oil work as deodorant?", "How long does coconut oil deodorant last?", "Is coconut oil deodorant safe for sensitive skin?" with schema markup.
- Add internal links from the coconut oil for skin pillar post (to be created) back to this page.

---

### 6. `best toothpaste without sls` — 453 impressions, pos #7.4, 18 clicks, 4.0% CTR

**What's holding it back:** CTR of 4% is actually strong, meaning ranking improvement alone will compound clicks. Currently 3 URLs compete for this query.

**Actions:**
- Cannibalization fix (see below) is the primary lever — consolidating to one URL should push this into the top 5 automatically.
- Ensure the surviving page's title starts with "Best Toothpaste Without SLS" (exact match) — don't bury the keyword in the middle of the title.
- Add a "Why SLS-Free?" intro section in the first 100 words of the post that Google can pull as a featured snippet definition.

---

### 7. `soap for tattoos` — 517 impressions, pos #9.8, 1 click, 0.2% CTR

**What's holding it back:** Position #9.8 is essentially page 1 row 3 — invisible without a strong title. 0.2% CTR confirms the title/description are not compelling.

**Actions:**
- Same consolidation as "best soap for tattoos" (see cannibalization). The surviving URL should rank for this query automatically once competing pages are redirected.
- Rewrite meta description to include social proof language: *"Used by thousands for tattoo aftercare — here's the exact soap type dermatologists and tattoo artists recommend."*

---

### 8. `coconut oil soap benefits` — 426 impressions, pos #4.5, 4 clicks, 0.9% CTR

**What's holding it back:** Position #4.5 with 0.9% CTR is significantly underperforming (expected CTR at pos 4–5 is 8–10%). This is a clear title/meta failure or a featured snippet is suppressing clicks.

**Actions:**
- Check if a featured snippet (likely a bulleted list of benefits) is appearing above position 1 for this query. If yes, reformat the relevant section of the ranking page as a clean bulleted list of 5–7 benefits with an H2 "Benefits of Coconut Oil Soap" to try to capture the snippet.
- Rewrite the meta description to lead with a compelling hook: *"Coconut oil soap moisturizes, fights bacteria, and is gentle on sensitive skin. Here are 7 science-backed benefits."*
- Add a "Shop Coconut Oil Bar Soap" product card within the first scroll of the post.

---

### 9. `glycerin free toothpaste` — 312 impressions, pos #6.8, 4 clicks, 1.3% CTR

**What's holding it back:** Likely a secondary keyword on an SLS-focused post that hasn't been intentionally optimized for glycerin-free searchers.

**Actions:**
- Add a dedicated H2 section titled "Is Real Skin Care Toothpaste Glycerin-Free?" to the primary SLS toothpaste post.
- Add "glycerin-free" to the page's meta keywords and title tag secondary clause: `Best SLS-Free Toothpaste (Also Glycerin-Free) | Real Skin Care`.
- Internal link from the coconut oil toothpaste product page to this post using anchor text "glycerin-free toothpaste."

---

### 10. `best coconut oil toothpaste for a natural oral care routine
---

## Raw Data

### Impression Leaks (50)
| Query | Impressions | Avg Position | Source |
|---|---|---|---|
| coconut lotion | 1111 | #30.3 | — |
| coconut body lotion | 861 | #23.5 | — |
| coconut for the skin | 536 | #11.8 | — |
| cinnamon toothpaste | 500 | #41.9 | — |
| clean body lotion | 500 | #20.1 | — |
| coconut oil as toothpaste | 495 | #8.9 | — |
| are coconut oil toothpastes safe for sensitive teeth? | 414 | #3 | — |
| best clean body lotion | 397 | #18.2 | — |
| cinnamon sensitive toothpaste | 392 | #27.3 | — |
| coconut hand soap | 371 | #25.6 | — |
| cinnamon toothpaste for sensitive teeth | 369 | #23.8 | — |
| are coconut oil toothpastes effective for everyday use? | 341 | #3 | — |
| body lotion without chemicals | 329 | #30.4 | — |
| cinnamon flavored toothpaste | 329 | #39 | — |
| all natural lip balm | 309 | #48.3 | — |
| chemical free body lotion | 300 | #29.9 | — |
| best soap for women | 287 | #11.9 | — |
| cinnamon toothpaste brands | 282 | #34.8 | — |
| coconut body cream | 280 | #24.1 | — |
| best coconut oil toothpaste for a natural oral care routine. | 275 | #4.7 | — |
| coconut oil for face | 263 | #20 | — |
| best coconut lotions | 259 | #46.4 | — |
| coconut deodorant | 258 | #30.5 | — |
| coconut oil bar soap | 256 | #20.7 | — |
| coconut oil for body | 253 | #36 | — |
| coconut oil for armpits | 247 | #8.6 | — |
| coconut moisturizer for face | 245 | #31.1 | — |
| coconut oil face moisturizer | 245 | #29.6 | — |
| are natural coconut oil toothpastes easy to find? | 236 | #7.7 | — |
| best natural body lotion | 236 | #40.4 | — |

### Near-Misses (30)
| Query | Impressions | Position | Clicks | CTR | Source |
|---|---|---|---|---|---|
| sls free toothpaste list | 5922 | #8.1 | 55 | 0.9% | — |
| best sls free toothpaste | 3179 | #5.9 | 90 | 2.8% | — |
| real skin | 2149 | #6.3 | 80 | 3.7% | — |
| non sls toothpaste | 1803 | #7.8 | 19 | 1.1% | — |
| coconut oil deodorant | 1008 | #9.2 | 5 | 0.5% | — |
| coconut oil as deodorant | 860 | #6.5 | 13 | 1.5% | — |
| toothpaste with no sls | 631 | #8.4 | 1 | 0.2% | — |
| what soap to use for tattoo | 622 | #8.1 | 4 | 0.6% | — |
| soap for tattoos | 517 | #9.8 | 1 | 0.2% | — |
| coconut oil as toothpaste | 495 | #8.9 | 0 | 0.0% | — |
| best toothpaste without sls | 453 | #7.4 | 18 | 4.0% | — |
| sls free toothpaste brands | 441 | #8.1 | 4 | 0.9% | — |
| toothpaste without sls list | 435 | #7.6 | 1 | 0.2% | — |
| best soap for tattoo aftercare | 427 | #9.1 | 1 | 0.2% | — |
| coconut oil soap benefits | 426 | #4.5 | 4 | 0.9% | — |
| best toothpaste without sodium lauryl sulfate | 423 | #9.1 | 11 | 2.6% | — |
| coconut oil for toothpaste | 404 | #8.9 | 4 | 1.0% | — |
| real skincare | 379 | #4.7 | 62 | 16.4% | — |
| coconut oil for deodorant | 345 | #7.7 | 3 | 0.9% | — |
| what toothpaste doesn't have sodium lauryl sulfate | 336 | #9.7 | 2 | 0.6% | — |
| can you use coconut oil as deodorant | 334 | #7.4 | 2 | 0.6% | — |
| what soap is good for tattoos | 326 | #8.2 | 1 | 0.3% | — |
| coconut soap benefits | 324 | #4.5 | 1 | 0.3% | — |
| glycerin free toothpaste | 312 | #6.8 | 4 | 1.3% | — |
| sls free toothpaste for adults | 306 | #7.8 | 4 | 1.3% | — |
| good soap for tattoos | 288 | #9.9 | 1 | 0.3% | — |
| best soap to use on new tattoo | 285 | #9.6 | 1 | 0.4% | — |
| best coconut oil toothpaste for a natural oral care routine. | 275 | #4.7 | 0 | 0.0% | — |
| what soap can i use to wash my tattoo | 248 | #8.7 | 4 | 1.6% | — |
| coconut oil for armpits | 247 | #8.6 | 0 | 0.0% | — |

### Cannibalization Groups (25)
**"sls free toothpaste"** — 11826 total impressions across 4 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 11.3, 6533 impr, 34 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 6.5, 4900 impr, 50 clicks
  - `/blogs/news/best-sls-free-toothpaste-2025` — pos 66.4, 197 impr, 1 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 2.4, 184 impr, 3 clicks

**"sls free toothpaste list"** — 6268 total impressions across 4 pages
  - `/blogs/news/sls-free-toothpaste-list-best-natural-options-2026` — pos 9.2, 2613 impr, 18 clicks
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 8.7, 2423 impr, 19 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 4.8, 868 impr, 13 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 6.3, 364 impr, 6 clicks

**"toothpaste without sls"** — 4993 total impressions across 3 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 14.1, 2291 impr, 12 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 9, 1830 impr, 11 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 5, 872 impr, 8 clicks

**"toothpaste without sodium lauryl sulfate"** — 4321 total impressions across 3 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 16.3, 2125 impr, 11 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 5.2, 1555 impr, 19 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 8.7, 641 impr, 4 clicks

**"best sls free toothpaste"** — 3774 total impressions across 4 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 6, 2825 impr, 77 clicks
  - `/blogs/news/best-sls-free-toothpaste-2025` — pos 13.5, 535 impr, 0 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 3.5, 286 impr, 11 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 6.1, 117 impr, 2 clicks

**"non sls toothpaste"** — 1828 total impressions across 3 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 8.1, 1335 impr, 15 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 9.1, 298 impr, 2 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 4.8, 195 impr, 2 clicks

**"sodium lauryl sulfate free toothpaste"** — 1512 total impressions across 2 pages
  - `/blogs/news/sls-free-toothpaste-list-best-natural-options-2026` — pos 13.8, 807 impr, 2 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 5.4, 705 impr, 8 clicks

**"real skin care"** — 1485 total impressions across 4 pages
  - `/` — pos 2.2, 573 impr, 61 clicks
  - `/collections/all-products` — pos 3.1, 373 impr, 2 clicks
  - `/collections` — pos 2.4, 316 impr, 1 clicks
  - `/collections/coconut-oil-products` — pos 3.7, 96 impr, 1 clicks

**"best fluoride free toothpaste"** — 1410 total impressions across 2 pages
  - `/blogs/news/best-fluoride-free-toothpaste-2025` — pos 20.1, 1409 impr, 5 clicks
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 1, 1 impr, 0 clicks

**"best soap for tattoos"** — 1371 total impressions across 4 pages
  - `/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing` — pos 14.7, 800 impr, 3 clicks
  - `/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2` — pos 9.3, 399 impr, 3 clicks
  - `/collections/best-soap-for-tattoos` — pos 12.7, 160 impr, 0 clicks
  - `/collections/best-soap-for-new-tattoo` — pos 37.3, 12 impr, 0 clicks

**"toothpastes without sodium lauryl sulfate"** — 814 total impressions across 4 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 10.6, 374 impr, 2 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 5.2, 162 impr, 3 clicks
  - `/blogs/news/sls-free-toothpaste-list-best-natural-options-2026` — pos 10.8, 159 impr, 1 clicks
  - `/blogs/news/best-toothpaste-without-sls-2026` — pos 9.2, 119 impr, 1 clicks

**"all natural lotion"** — 621 total impressions across 4 pages
  - `/collections/natural-body-lotion` — pos 50.5, 131 impr, 0 clicks
  - `/collections/organic-body-lotion` — pos 55.5, 121 impr, 0 clicks
  - `/collections/best-non-toxic-body-lotion` — pos 74.9, 104 impr, 0 clicks
  - `/collections/non-toxic-body-lotion` — pos 73.9, 88 impr, 0 clicks

**"sls free toothpaste with fluoride"** — 573 total impressions across 2 pages
  - `/blogs/news/best-toothpaste-without-sls-2025` — pos 14.7, 443 impr, 1 clicks
  - `/blogs/news/toothpaste-without-sls-what-to-know-best-options` — pos 9.6, 130 impr, 1 clicks

**"real skincare"** — 540 total impressions across 2 pages
  - `/` — pos 3.2, 337 impr, 61 clicks
  - `/collections/all-products` — pos 3, 203 impr, 1 clicks

**"are coconut oil toothpastes safe for sensitive teeth?"** — 534 total impressions across 3 pages
  - `/blogs/news/can-you-use-coconut-oil-as-toothpaste` — pos 4.5, 317 impr, 0 clicks
  - `/products/coconut-oil-toothpaste` — pos 2.2, 205 impr, 0 clicks
  - `/collections/non-fluoride-toothpaste/products/coconut-oil-toothpaste?variant=45828181196970` — pos 1, 12 impr, 0 clicks

### Topic Clusters (15)
**"toothpaste" cluster** — 67051 impressions, 530 clicks, avg pos 12.8
  - "best sls free toothpaste" (3179 impr, pos #5.9)
  - "sls free toothpaste" (12305 impr, pos #10.9)
  - "sls free toothpaste list" (5922 impr, pos #8.1)
  - "toothpaste without sodium lauryl sulfate" (4865 impr, pos #14.5)
  - "toothpaste without sls" (5139 impr, pos #11.6)
  - "non sls toothpaste" (1803 impr, pos #7.8)
  - "best toothpaste without sls" (453 impr, pos #7.4)
  - "coconut oil toothpaste" (2811 impr, pos #11.1)

**"coconut" cluster** — 35268 impressions, 106 clicks, avg pos 28.3
  - "coconut oil toothpaste" (2811 impr, pos #11.1)
  - "coconut oil as deodorant" (860 impr, pos #6.5)
  - "coconut oil deodorant" (1008 impr, pos #9.2)
  - "coconut oil for toothpaste" (404 impr, pos #8.9)
  - "coconut oil soap benefits" (426 impr, pos #4.5)
  - "coconut oil for deodorant" (345 impr, pos #7.7)
  - "can you use coconut oil as deodorant" (334 impr, pos #7.4)
  - "coconut oil armpits" (117 impr, pos #8.1)

**"lotion" cluster** — 17756 impressions, 42 clicks, avg pos 28.3
  - "real skin care lotion" (69 impr, pos #1.1)
  - "all natural lotion no chemicals" (81 impr, pos #25.9)
  - "best body lotion without chemicals" (351 impr, pos #11.1)
  - "coconut oil as body lotion" (153 impr, pos #16.8)
  - "non toxic body lotion" (1450 impr, pos #41.3)
  - "real skin care organic body lotion" (35 impr, pos #2.7)
  - "toxic free body lotion" (52 impr, pos #12.6)
  - "unscented lotion" (700 impr, pos #26)

**"body" cluster** — 17486 impressions, 24 clicks, avg pos 29.2
  - "best body lotion without chemicals" (351 impr, pos #11.1)
  - "coconut oil as body lotion" (153 impr, pos #16.8)
  - "coconut oil for body odor" (131 impr, pos #9.1)
  - "non toxic body lotion" (1450 impr, pos #41.3)
  - "real skin care organic body lotion" (35 impr, pos #2.7)
  - "toxic free body lotion" (52 impr, pos #12.6)
  - "best body lotion for sensitive skin 2026" (11 impr, pos #9.4)
  - "best body lotions for sensitive skin 2026" (48 impr, pos #5.9)

**"soap" cluster** — 16866 impressions, 108 clicks, avg pos 22.2
  - "best soap for new tattoo" (460 impr, pos #12.7)
  - "best soap for tattoos" (1360 impr, pos #13)
  - "coconut oil soap benefits" (426 impr, pos #4.5)
  - "what soap can i use to wash my tattoo" (248 impr, pos #8.7)
  - "what soap to use for tattoo" (622 impr, pos #8.1)
  - "best soap for new tattoos" (128 impr, pos #11.9)
  - "real soap" (177 impr, pos #12.3)
  - "best soap for fresh tattoo" (228 impr, pos #9.9)

**"skin" cluster** — 12657 impressions, 178 clicks, avg pos 36.9
  - "real skin" (2149 impr, pos #6.3)
  - "real skin care" (597 impr, pos #3.2)
  - "real skin care lotion" (69 impr, pos #1.1)
  - "real skin care products" (99 impr, pos #7.5)
  - "real skin products" (60 impr, pos #9.7)
  - "real skin care organic body lotion" (35 impr, pos #2.7)
  - "best body lotion for sensitive skin 2026" (11 impr, pos #9.4)
  - "best body lotions for sensitive skin 2026" (48 impr, pos #5.9)

**"sulfate" cluster** — 12239 impressions, 89 clicks, avg pos 10.7
  - "toothpaste without sodium lauryl sulfate" (4865 impr, pos #14.5)
  - "best toothpaste without sodium lauryl sulfate" (423 impr, pos #9.1)
  - "sodium lauryl sulfate free toothpaste" (2825 impr, pos #19.2)
  - "toothpastes without sodium lauryl sulfate" (819 impr, pos #10)
  - "best sodium lauryl sulfate free toothpaste" (117 impr, pos #9.2)
  - "fluoride toothpaste without sodium lauryl sulfate" (118 impr, pos #11.5)
  - "natural toothpaste without sodium lauryl sulfate" (107 impr, pos #6.8)
  - "what toothpaste doesn't have sodium lauryl sulfate" (336 impr, pos #9.7)

**"lauryl" cluster** — 11457 impressions, 88 clicks, avg pos 10.7
  - "toothpaste without sodium lauryl sulfate" (4865 impr, pos #14.5)
  - "best toothpaste without sodium lauryl sulfate" (423 impr, pos #9.1)
  - "sodium lauryl sulfate free toothpaste" (2825 impr, pos #19.2)
  - "toothpastes without sodium lauryl sulfate" (819 impr, pos #10)
  - "best sodium lauryl sulfate free toothpaste" (117 impr, pos #9.2)
  - "fluoride toothpaste without sodium lauryl sulfate" (118 impr, pos #11.5)
  - "natural toothpaste without sodium lauryl sulfate" (107 impr, pos #6.8)
  - "what toothpaste doesn't have sodium lauryl sulfate" (336 impr, pos #9.7)

**"sodium" cluster** — 11369 impressions, 90 clicks, avg pos 10.6
  - "toothpaste without sodium lauryl sulfate" (4865 impr, pos #14.5)
  - "best toothpaste without sodium lauryl sulfate" (423 impr, pos #9.1)
  - "sodium lauryl sulfate free toothpaste" (2825 impr, pos #19.2)
  - "toothpastes without sodium lauryl sulfate" (819 impr, pos #10)
  - "best sodium lauryl sulfate free toothpaste" (117 impr, pos #9.2)
  - "fluoride toothpaste without sodium lauryl sulfate" (118 impr, pos #11.5)
  - "natural toothpaste without sodium lauryl sulfate" (107 impr, pos #6.8)
  - "what toothpaste doesn't have sodium lauryl sulfate" (336 impr, pos #9.7)

**"2026" cluster** — 11318 impressions, 5 clicks, avg pos 9.1
  - "best body lotion for sensitive skin 2026" (11 impr, pos #9.4)
  - "best body lotions for sensitive skin 2026" (48 impr, pos #5.9)
  - "best non fluoride toothpaste 2026" (12 impr, pos #4.5)
  - "best sls free toothpaste 2026" (28 impr, pos #1.9)
  - "best sls-free toothpaste 2026" (32 impr, pos #3.5)
  - "affordable aluminum-free deodorants long-lasting odor protection sensitive skin 2025 2026" (3 impr, pos #8.3)
  - "aluminum free deodorant best 2026" (2 impr, pos #4.5)
  - "aluminum free deodorant recommendations 2026" (2 impr, pos #4)