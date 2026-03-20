# Feature Ideas Backlog

## 1. Product Page A/B Testing

**Status:** Brainstormed, not designed
**Area:** CRO

Test product page `body_html` copy end-to-end, measuring add-to-cart rate via GA4.

**Approach (agreed):** Full description swap — generate Variant B via Claude, apply to Shopify `body_html`, store Variant A in test file, revert if B loses at 28 days. Same create → track → conclude → revert loop as existing meta title tests.

**Components needed:**
- `scripts/create-product-test.js <slug>` — generate Variant B, swap body_html, write test file
- `agents/product-ab-tracker/index.js` — weekly GA4 add-to-cart delta, conclude at 28 days
- Dashboard CRO tab: active product tests alongside meta title tests

**Measurement signal:** GA4 `add_to_cart` events per session on the product page

---

## 2. Competitor Traffic Intelligence → Pipeline Feed

**Status:** Brainstormed, not designed
**Area:** SEO Intelligence

Pull competitors' top pages + traffic value from Ahrefs, identify gaps vs. existing posts/briefs/calendar, auto-insert high-priority items into the content calendar (pushing lower-priority items out).

**Components needed:**
- Agent to pull competitor top pages via Ahrefs `site-explorer-top-pages`
- Gap analysis vs. `data/sitemap-index.json`, `data/briefs/`, and content calendar
- Calendar write-back: insert high-confidence gaps at high priority, shift existing items
- Dashboard SEO tab: competitor-sourced opportunities panel

**Conversion proxy:** Ahrefs traffic value (USD) — high value = commercial intent
