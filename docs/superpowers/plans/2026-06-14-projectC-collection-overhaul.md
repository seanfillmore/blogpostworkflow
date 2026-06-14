# Project C — Collection Overhaul

> TDD, subagent-driven. Branch: feature/collection-overhaul.

**Goal:** Make collection pages premium money-pages, not thin boilerplate — and stop the bad-output bug class (the "DISQUALIFIED" collection). Adds output validation, schema, depth (buying guide + FAQ), and safe empty-collection handling.

**Design (made):**
1. **Output validation** — new pure `lib/collection-validation.js` `validateCollectionSpec(spec, {existingHandles})` → `{ ok, errors[] }`. Rejects sentinel titles (DISQUALIFIED/NOT APPROVED/N/A/NONE), missing/duplicate/unslugifiable handle, bad seo_title/meta_description lengths, missing or thin body_html (< MIN words). Both collection agents call it and BLOCK (skip/queue-as-rejected) on failure. Kills the DISQUALIFIED-class bug.
2. **Collection schema** — extend pure `lib/schema-builders.js` with `buildCollectionPageSchema`, `buildItemListSchema`, `buildFaqSchema`. Collection agents embed CollectionPage + BreadcrumbList + FAQPage (when the body has Q&A) as `<script type="application/ld+json">` prepended to the collection body_html on publish. (schema-injector also adopts the shared `buildFaqSchema` to DRY.)
3. **Depth** — collection prompts (creator + optimizer) gain a buying-guide structure + a short FAQ section (5–7 Q&A). Raises target depth; the FAQ enables FAQPage schema.
4. **Empty-collection handling** — new collections are created as **drafts** (`published:false`) since products are assigned manually after; the report tells the user to assign products then publish. (No product-count I/O; avoids publishing a live empty grid.)

**Tasks:**
1. `lib/collection-validation.js` + tests; extend `lib/schema-builders.js` (collection + FAQ builders) + tests; schema-injector uses shared `buildFaqSchema`.
2. `collection-creator`: validate spec (block bad), create as draft, embed schema, buying-guide+FAQ prompt.
3. `collection-content-optimizer`: validate spec (block thin), embed schema, buying-guide+FAQ prompt.
