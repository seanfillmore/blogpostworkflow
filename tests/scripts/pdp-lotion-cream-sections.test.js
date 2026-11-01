/**
 * scripts/pdp-lotion-cream-sections.mjs — pins what may be published and how it
 * is applied, against the COMMITTED templates rather than fixtures written to
 * agree with the plan.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TEMPLATE_PLAN, METAFIELD_PLAN, REVIEWS,
  applyTemplateEntry, gateCopy, forbiddenEvenNegated, quoteHtml, planTexts,
} from '../../scripts/pdp-lotion-cream-sections.mjs';
import { ingredientTextFromTemplate } from '../../lib/ingredient-absence-claims.js';

const raw = (file) => readFileSync(`theme/templates/${file}`, 'utf8');
const parse = (file) => JSON.parse(raw(file).replace(/^\s*\/\*[\s\S]*?\*\//, ''));
const TEMPLATES = Object.fromEntries(
  [...new Set([...TEMPLATE_PLAN, ...METAFIELD_PLAN].map((e) => e.file))].map((f) => [f, raw(f)]),
);

describe('what may be published', () => {
  test('every AFTER clears every gate against the committed templates', () => {
    assert.deepEqual(gateCopy({ templates: TEMPLATES, forbidden: forbiddenEvenNegated() }), []);
  });

  test('the never-name list is read from the pdp-builder validator, not restated', () => {
    const f = forbiddenEvenNegated();
    for (const w of ['mineral oil', 'petrolatum', 'dimethicone']) assert.ok(f.includes(w), w);
    // Operator ruling 2026-09-11: "petroleum jelly" / "petroleum wax" are NOT covered.
    assert.ok(!f.includes('petroleum'), 'petroleum was removed from the never-name list');
  });

  test('a plan string naming a forbidden term would be refused', () => {
    const failures = gateCopy({ templates: TEMPLATES, forbidden: [...forbiddenEvenNegated(), 'coconut'] });
    assert.ok(failures.some((f) => /FORBIDDEN_EVEN_NEGATED/.test(f)));
  });

  test('the lotion contrast being replaced described the lotion\'s OWN ingredients', () => {
    const before = TEMPLATE_PLAN[0].edits.find((e) => e.block === 'hook-text').before;
    assert.match(before, /water and a thickener/);
    const list = ingredientTextFromTemplate(TEMPLATES['product.landing-page-lotion.json']);
    assert.match(list, /spring water/i);
    assert.match(list, /emulsifying wax/i);
  });

  test('the cream PRODUCT title is never in the plan — Klaviyo flows key on it', () => {
    assert.ok(METAFIELD_PLAN.every((m) => m.key === 'title_tag' || m.key === 'description_tag'));
    const specs = readFileSync('data/brand/email-rebuild/specs.js', 'utf8');
    assert.match(specs, /"Coconut Moisturizer" in items/);
  });

  test('every published string is accounted for', () => {
    assert.equal(planTexts().length, 7);
  });
});

describe('proof', () => {
  test('every quote appears on the page of the product it reviews', () => {
    for (const e of TEMPLATE_PLAN) {
      for (const key of e.reviews) {
        assert.equal(REVIEWS[key].handle, e.handle, key);
        assert.ok(e.insert.block.settings.text.includes(REVIEWS[key].excerpt), key);
      }
    }
  });

  test('the lotion buy-box quote is a coconut-lotion review, not the cream review it replaced', () => {
    const src = readFileSync('theme/blocks/trust-line.lotion.liquid', 'utf8');
    assert.equal(REVIEWS.lotionMike.handle, 'coconut-lotion');
    assert.ok(src.includes(REVIEWS.lotionMike.excerpt));
    assert.doesNotMatch(src, /ABSORBS|Ariel/);
  });

  test('only Judge.me-verified buyers are labelled verified', () => {
    assert.match(quoteHtml(REVIEWS.lotionNicole), /verified buyer/);
    assert.match(quoteHtml(REVIEWS.creamElla), /verified buyer/);
    assert.doesNotMatch(quoteHtml(REVIEWS.lotionSuzy), /verified/);
    assert.doesNotMatch(quoteHtml(REVIEWS.lotionMike), /verified/);
  });
});

describe('applyTemplateEntry', () => {
  for (const e of TEMPLATE_PLAN) {
    test(`${e.file}: the committed mirror is at BEFORE or AFTER, never a third value`, () => {
      const r = applyTemplateEntry(parse(e.file), e);
      assert.notEqual(r.outcome, 'drifted', JSON.stringify(r.drift));
    });

    test(`${e.file}: idempotent, and the proof block lands right after its anchor`, () => {
      const parsed = parse(e.file);
      applyTemplateEntry(parsed, e);
      assert.equal(applyTemplateEntry(parsed, e).outcome, 'already-applied');
      const order = parsed.sections[e.section].block_order;
      assert.equal(order[order.indexOf(e.insert.after) + 1], e.insert.id);
    });
  }

  test('a live value matching neither side is drift, and nothing is mutated', () => {
    const e = TEMPLATE_PLAN[0];
    const parsed = parse(e.file);
    parsed.sections[e.section].blocks['hook-heading'].settings.heading = 'Somebody else edited this';
    const snapshot = JSON.stringify(parsed);
    const r = applyTemplateEntry(parsed, e);
    assert.equal(r.outcome, 'drifted');
    assert.equal(JSON.stringify(parsed), snapshot);
  });
});
