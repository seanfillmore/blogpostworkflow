# Writer Standing Rules

> Append-only. New rules are added by insight-aggregator when a recurring editor pattern is detected (≥3 posts in 30 days). Existing rules are never removed.


## Added 2026-04-08 — factual concerns

**factual concerns** — Editor flagged this category in 21 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: benefits-of-using-coconut-oil-lotion, benefits-of-using-coconut-oil-lotion.json, best-aluminum-free-deodorant, best-clean-body-lotion-2025, best-coconut-oil-body-lotions-for-extremely-dry-skin-2025-clean-natural-picks-refreshed.

## Added 2026-04-08 — cta quality

**cta quality** — Editor flagged this category in 8 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: benefits-of-using-coconut-oil-lotion, benefits-of-using-coconut-oil-lotion.json, best-natural-deodorant-for-sensitive-skin, best-sls-free-toothpaste-2025, cinnamon-toothpaste.

## Added 2026-04-08 — ingredient accuracy

**ingredient accuracy** — Editor flagged this category in 11 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: benefits-of-using-coconut-oil-lotion.json, best-clean-body-lotion-2025, best-natural-deodorant-for-sensitive-skin, best-natural-deodorant-for-women, best-natural-toothpaste-2025-refreshed.

## Added 2026-04-08 — formatting

**formatting** — Editor flagged this category in 6 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: benefits-of-using-coconut-oil-lotion.json, best-clean-body-lotion-2025, best-natural-deodorant-for-sensitive-skin, cinnamon-toothpaste, natural-lip-balm.

## Added 2026-04-08 — competitor names in faq

**competitor names in faq** — Editor flagged this category in 6 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: benefits-of-using-coconut-oil-lotion.json, best-coconut-oil-body-lotions-for-extremely-dry-skin-2025-clean-natural-picks-refreshed, best-natural-bar-soap-for-men, best-sls-free-toothpaste-2025, coconut-oil-body-lotion-that-actually-works-for-dry-skin-2025-roundup-refreshed.

## Added 2026-04-08 — overall quality

**overall quality** — Editor flagged this category in 7 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: benefits-of-using-coconut-oil-lotion.json, best-coconut-oil-body-lotions-for-extremely-dry-skin-2025-clean-natural-picks-refreshed, best-natural-bar-soap-for-men, best-sls-free-toothpaste-2025, coconut-oil-body-lotion-that-actually-works-for-dry-skin-2025-roundup-refreshed.

## Added 2026-04-08 — year accuracy

**year accuracy** — Editor flagged this category in 4 of the last 30 days of posts. Tighten on this dimension before submitting. Sample posts: best-coconut-oil-body-lotions-for-extremely-dry-skin-2025-clean-natural-picks-refreshed, best-sls-free-toothpaste-2025-refreshed, coconut-oil-body-lotion-that-actually-works-for-dry-skin-2025-roundup-refreshed, toothpaste-without-sodium-lauryl-sulfate.

## Added 2026-07-31 — product origin: USA only, never a city or state

**product origin** — Products are **made in the USA**. No city or state is ever named as the place of manufacture. The CAN-SPAM footer address (`1623 Central Ave STE 201, Cheyenne, WY 82001`, canonical in `data/brand/brand-kit.json` as `postal_address`) is a mailing address, **not** a manufacturing claim — and neither was the Blum, TX address it replaced on 2026-07-31, which was distribution.

Approved phrasing: **"made in the USA"**, **"handmade in the USA"**. Never name a city, state, or facility as where a product is made, and never write "small batches in <place>".

This is not a style preference — it is a factual accuracy rule. A 2026-07-30 email redesign wrote "Everything is made in small batches in Blum, Texas" into a live Winback email, and it sent before it was caught. The town name appears legitimately in every email footer, so reviewing for the word alone will not catch it; what matters is a manufacturing verb bound to a place.

Enforced mechanically for emails by `lib/email-render.js` (`assertNoOriginClaim`), which throws at build time. Blog posts, PDPs, and Amazon copy have no such guard — apply the rule by hand there.
