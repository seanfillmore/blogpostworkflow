// tests/lib/injected-schema.test.js
//
// `hasInjectedSchema` replaced `!html.includes('FAQPage')` as the answer to
// "has this post been through agents/schema-injector?", and the reason it had
// to is that the injector stopped emitting FAQPage at all (Google removed the
// FAQ rich result). Left alone, `agents/legacy-rebuilder` would have read every
// post the new pipeline writes as legacy and queued a PAID full rebuild for it,
// five a day, unattended.
//
// The property that makes the swap safe is one-directional and is asserted
// below: anything the old rule called NOT legacy, the new rule also calls not
// legacy. The set can only shrink, so no post can be newly enrolled into spend.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hasInjectedSchema, schemaRegression } from '../../lib/injected-schema.js';

const LD = (type) => `<script type="application/ld+json">\n{"@type":"${type}"}\n</script>`;
const PROSE = '<p>A paragraph that carries no structured data whatsoever.</p>';

test('hasInjectedSchema is true for any JSON-LD block, whatever its @type', () => {
  for (const t of ['BreadcrumbList', 'Article', 'FAQPage', 'HowTo', 'ItemList']) {
    assert.equal(hasInjectedSchema(LD(t) + PROSE), true, `${t} must count`);
  }
});

test('hasInjectedSchema is false for a post with no JSON-LD', () => {
  assert.equal(hasInjectedSchema(PROSE), false);
  assert.equal(hasInjectedSchema(''), false);
  assert.equal(hasInjectedSchema(null), false);
  assert.equal(hasInjectedSchema(undefined), false);
});

test('hasInjectedSchema tolerates single quotes and extra attributes', () => {
  assert.equal(hasInjectedSchema(`<script data-x="1" type='application/ld+json'>{}</script>`), true);
  assert.equal(hasInjectedSchema(`<SCRIPT TYPE="APPLICATION/LD+JSON">{}</SCRIPT>`), true);
});

test('a plain <script> is not structured data', () => {
  assert.equal(hasInjectedSchema('<script>var a = 1;</script>' + PROSE), false);
});

test('the word FAQPage in prose is NOT injected schema', () => {
  // The old rule was a bare substring search, so an article ABOUT schema markup
  // exempted itself from the rebuilder by mentioning the type. This one reads
  // the script tag, not the vocabulary.
  assert.equal(hasInjectedSchema('<p>Google removed the FAQPage rich result.</p>'), false);
});

test('MIGRATION SAFETY: every post the old rule spared, the new rule spares', () => {
  // The old rule: legacy ⟺ !html.includes('FAQPage'). The new rule: legacy ⟺
  // no JSON-LD at all. FAQPage can only reach a post body inside a JSON-LD
  // block, so "had FAQPage" implies "has JSON-LD" — the legacy set shrinks and
  // can never grow. Growing it is the failure that costs money.
  const corpus = [
    LD('FAQPage') + PROSE,
    LD('FAQPage') + LD('HowTo') + PROSE,
    LD('Article') + LD('FAQPage') + PROSE,
  ];
  for (const html of corpus) {
    const oldLegacy = !html.includes('FAQPage');
    const newLegacy = !hasInjectedSchema(html);
    assert.equal(oldLegacy, false, 'precondition: the old rule spared this post');
    assert.equal(newLegacy, false, 'the new rule must spare it too');
  }
});

test('MIGRATION: a post with injector schema but no FAQ stops being legacy forever', () => {
  // The live defect the old proxy carried. FAQPage was CONDITIONAL — the
  // injector only emitted it when a body held 2+ question headings — while the
  // injector itself ran on every post. So a post it had processed, but which had
  // one question heading or none, was permanently legacy and was rebuilt,
  // re-checked, and re-queued every morning. `best-natural-bar-soap-for-men` is
  // the case CLAUDE.md records; measured 2026-08-24, 3 of 93 eligible posts are
  // in this shape.
  const processedButNoFaq = LD('BreadcrumbList') + PROSE;
  assert.equal(!processedButNoFaq.includes('FAQPage'), true, 'the old rule called this legacy forever');
  assert.equal(hasInjectedSchema(processedButNoFaq), true, 'the new rule sees it was processed');
});

test('schemaRegression fires only when schema was present before and is gone after', () => {
  assert.equal(schemaRegression(LD('BreadcrumbList') + PROSE, PROSE), true);
  assert.equal(schemaRegression(LD('FAQPage') + PROSE, LD('BreadcrumbList') + PROSE), false);
  assert.equal(schemaRegression(PROSE, PROSE), false);
  // Gaining schema is never a regression.
  assert.equal(schemaRegression(PROSE, LD('BreadcrumbList') + PROSE), false);
});

test('schemaRegression does NOT fire when a dead type is swapped for a live one', () => {
  // This is the whole point of moving off the FAQPage key. Re-running the
  // injector over an old mirror now REPLACES its FAQPage/HowTo/Article with a
  // BreadcrumbList. Under the old predicate that read as a regression and the
  // reconciler rolled the file back and held the post.
  const before = LD('FAQPage') + LD('HowTo') + LD('Article') + PROSE;
  const after = LD('BreadcrumbList') + PROSE;
  assert.equal(schemaRegression(before, after), false);
});
