// lib/injected-schema.js
//
// One question, one answer: HAS THIS POST BEEN THROUGH `agents/schema-injector`?
//
// It used to be answered by `!html.includes('FAQPage')`, hand-rolled in
// `agents/legacy-rebuilder` and again (as `hasFaqPage`) in
// `lib/content-reconcile.js`. That proxy died on 2026-08-24, when the injector
// stopped emitting `FAQPage` at all — Google REMOVED the FAQ rich result from
// Search (the docs page 301s to /search/updates#removing-faq-rich-result) and
// `HowTo` went the same way in 2023 (404). Emitting either was work nothing
// consumes.
//
// WHY THE TWO CHANGES HAD TO LAND TOGETHER
// ────────────────────────────────────────
// `agents/legacy-rebuilder` runs daily from `scheduler.js` at `--limit 5
// --apply`, and a "legacy" verdict is a full paid pipeline rebuild of a live
// page. Stop emitting FAQPage without moving that key and EVERY post the
// pipeline writes from that day on reads as legacy, forever, unattended. The
// same string is the rollback condition in `lib/content-reconcile.js`, which
// would then roll back and hold every mirror it reconciled.
//
// WHY THIS PREDICATE, AND WHY IT IS SAFE
// ──────────────────────────────────────
// The injector's job has always been "put JSON-LD in this body", so the presence
// of ANY JSON-LD block is the direct statement of what the FAQPage substring was
// only ever a proxy for. `lib/content-reconcile.js` already used exactly this
// test as the broader half of its own trigger.
//
// The swap is one-directional by construction: `FAQPage` can only reach a post
// body inside a JSON-LD block, so every post the old rule spared the new rule
// spares too. The legacy set can only SHRINK, never grow — no post is newly
// enrolled into unattended spend. Measured over the 93 eligible local posts on
// 2026-08-24: 39 legacy before, 36 after, 0 newly legacy.
//
// The 3 that fall out were a live defect, not a loss. `FAQPage` was CONDITIONAL
// (2+ question headings) while the injector ran unconditionally, so a post it
// had processed but which had too few question headings was legacy forever and
// was rebuilt, re-checked and re-queued every morning without ever being able to
// satisfy the test. CLAUDE.md already records that shape under
// `best-natural-bar-soap-for-men`.
//
// Pure — no I/O, no Shopify, no process. Both readers import it; a third copy is
// a bug, not a shortcut.

/**
 * Every JSON-LD block, in the one shape the fleet writes and reads them.
 *
 * Deliberately the same expression as `lib/content-reconcile.js`'s
 * `stripLdJson` and `agents/schema-injector`'s `stripExistingSchemas`: "does
 * this body carry injected schema" and "strip the injected schema" have to mean
 * the same thing on both sides of the injector's write.
 */
const LD_JSON_TAG_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>/i;

/**
 * Has `agents/schema-injector` (or any schema writer) put JSON-LD in this body?
 *
 * This is the predicate `agents/legacy-rebuilder` routes a paid rebuild on, so
 * read it as "has this post been through the pipeline", not as "is its schema
 * any good".
 *
 * @param {string|null|undefined} html
 * @returns {boolean}
 */
export function hasInjectedSchema(html) {
  return LD_JSON_TAG_RE.test(String(html ?? ''));
}

/**
 * Did a rewrite LOSE structured data the body had before?
 *
 * True is a rollback, not a warning: a mirror left without JSON-LD is one
 * `agents/legacy-rebuilder` enqueues for a paid rebuild the next morning.
 *
 * Note what this deliberately does NOT fire on: swapping a dead type for a live
 * one. Re-running the injector over an old mirror replaces its
 * FAQPage/HowTo/Article with a BreadcrumbList, which is the migration working,
 * not a regression. Keyed on `FAQPage` that was indistinguishable from a loss.
 *
 * @param {string|null|undefined} beforeHtml
 * @param {string|null|undefined} afterHtml
 * @returns {boolean}
 */
export function schemaRegression(beforeHtml, afterHtml) {
  return hasInjectedSchema(beforeHtml) && !hasInjectedSchema(afterHtml);
}
