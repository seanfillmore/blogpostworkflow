/**
 * The health-claim gate at the LAST LINE BEFORE A LIVE WRITE.
 *
 * `lib/queue-apply.js` applies copy some other agent generated, possibly days
 * earlier. There is no prompt at that layer, so — unlike every other gated
 * writer — it cannot regenerate. The behaviour these tests pin is the decision
 * that follows from that:
 *
 *   - it REFUSES the write (writing a drug claim is the worse outcome),
 *   - it does NOT dismiss or delete the item (this repo destroyed three paid-for
 *     briefs on 2026-08-19 by letting an automated verdict remove work), and
 *   - `agents/queue-autoapply` catches it in the PURE planner, before the item
 *     reaches the editor gate, the repair loop or the per-run cap — so a gated
 *     item costs no model calls and does not eat a slot that an applicable item
 *     could have used. Same "gate before the cap" rule as lib/cluster-hold.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import { seoCopyFieldsForItem, decide, planRun, MAX_APPLIES_PER_RUN } from '../../lib/queue-autoapply.js';
import { assertItemCopyIsCompliant, applyItem, SeoCopyClaimError } from '../../lib/queue-apply.js';

const cleanPageMeta = () => ({
  slug: 'faqs',
  trigger: 'page-meta-rewrite',
  status: 'pending',
  resource_id: 1,
  created_at: '2026-08-01T00:00:00Z',
  proposed_meta: {
    seo_title: 'Natural Skincare FAQ | Real Skin Care',
    seo_description: 'Answers on ingredients, scents and shipping for our coconut-oil body care.',
  },
});

const dirtyPageMeta = () => {
  const i = cleanPageMeta();
  i.proposed_meta.seo_description = 'Soothes and heals eczema-prone skin fast.';
  return i;
};

describe('seoCopyFieldsForItem — which stored fields are copy', () => {
  test('reads product/page meta title, description and summary under honest names', () => {
    const f = seoCopyFieldsForItem({
      trigger: 'page-meta-rewrite',
      proposed_meta: { seo_title: 'T', seo_description: 'D', summary: 'S' },
    });
    assert.deepEqual(f, { 'meta title_tag': 'T', 'meta description_tag': 'D', 'page summary': 'S' });
  });

  test('reads a product TITLE rewrite — the most direct product claim there is', () => {
    const f = seoCopyFieldsForItem({ trigger: 'product-title-rewrite', proposed_title: { new_title: 'X' } });
    assert.deepEqual(f, { 'product title': 'X' });
  });

  test('reads an inline product description body', () => {
    const f = seoCopyFieldsForItem({ trigger: 'product-description-rewrite', proposed_body_html: '<p>hi</p>' });
    assert.deepEqual(f, { 'product body': '<p>hi</p>' });
  });

  test('reads every copy-facing field of a proposed collection', () => {
    const f = seoCopyFieldsForItem({
      trigger: 'collection-gap',
      proposed_collection: { title: 'A', seo_title: 'B', seo_description: 'C', body_html: 'D' },
    });
    assert.deepEqual(f, {
      'collection title': 'A', 'meta title_tag': 'B', 'meta description_tag': 'C', 'collection body': 'D',
    });
  });

  test('an item carrying no inline copy yields no fields — not a free pass, nothing to check', () => {
    assert.deepEqual(seoCopyFieldsForItem({ trigger: 'seo-opportunity', slug: 'seo-opp-x' }), {});
    assert.deepEqual(seoCopyFieldsForItem(null), {});
  });
});

describe('decide — the gate runs before anything that spends', () => {
  test('a clean auto-apply item still applies', () => {
    const d = decide(cleanPageMeta(), {});
    assert.equal(d.action, 'apply');
  });

  test('a blocking claim in stored copy is skipped, not applied and not dismissed', () => {
    const d = decide(dirtyPageMeta(), {});
    assert.equal(d.action, 'skip');
    assert.equal(d.gate, 'health-claim');
    assert.ok(d.violations.length >= 1);
    assert.match(d.reason, /health-claim/i);
  });

  test('the reason names the field and the exact word, so the digest is actionable', () => {
    const d = decide(dirtyPageMeta(), {});
    assert.match(d.reason, /description_tag/);
    assert.match(d.reason, /heals|eczema/i);
  });

  test('advisory-tier language does not block — a $0 page whose query IS "toxic" stays workable', () => {
    const i = cleanPageMeta();
    i.proposed_meta.seo_title = 'Toxic Chemicals In Soap To Keep An Eye On';
    const d = decide(i, {});
    assert.equal(d.action, 'apply');
  });

  test('a gated item never reaches the per-run cap, and never consumes a slot', () => {
    const items = [dirtyPageMeta(), ...Array.from({ length: MAX_APPLIES_PER_RUN }, (_, n) => {
      const c = cleanPageMeta();
      c.slug = `clean-${n}`;
      c.created_at = `2026-08-0${n + 2}T00:00:00Z`;
      return c;
    })];
    const plan = planRun(items, {}, { cap: MAX_APPLIES_PER_RUN });
    assert.equal(plan.apply.length, MAX_APPLIES_PER_RUN);
    assert.ok(plan.apply.every((p) => p.item.slug.startsWith('clean-')));
    assert.equal(plan.dismiss.length, 0, 'a gated item must never be dismissed — that destroys queued work');
    const gated = plan.skip.filter((s) => s.gate === 'health-claim');
    assert.equal(gated.length, 1);
    assert.equal(gated[0].item.slug, 'faqs');
  });

  test('a collection-gap carrying a drug claim is gated, not dismissed as a revenue decision', () => {
    const item = {
      slug: 'best-soap-for-tattoos', trigger: 'collection-gap', status: 'pending',
      signal_source: { keyword: 'best soap for tattoos' },
      proposed_collection: { title: 'Tattoo Soap', body_html: '<p>Helps new ink heal faster.</p>' },
    };
    const d = decide(item, { productCounts: new Map([['best-soap-for-tattoos', 4]]) });
    assert.equal(d.action, 'skip');
    assert.equal(d.gate, 'health-claim');
  });
});

describe('assertItemCopyIsCompliant — the write refuses', () => {
  test('clean copy passes silently', () => {
    assert.doesNotThrow(() => assertItemCopyIsCompliant(cleanPageMeta()));
  });

  test('a blocking claim throws a typed error naming the words', () => {
    let err;
    try { assertItemCopyIsCompliant(dirtyPageMeta()); } catch (e) { err = e; }
    assert.ok(err instanceof SeoCopyClaimError);
    assert.match(err.message, /heals|eczema/i);
    assert.ok(err.violations.length >= 1);
  });

  test('applyItem refuses before it touches Shopify', async () => {
    const calls = [];
    const deps = new Proxy({}, { get: (_t, k) => (...a) => { calls.push(String(k)); return a; } });
    await assert.rejects(() => applyItem(dirtyPageMeta(), deps), SeoCopyClaimError);
    assert.deepEqual(calls, [], 'no Shopify call may happen once the gate has refused');
  });

  test('a clean item still reaches its publisher', async () => {
    const calls = [];
    const deps = { upsertMetafield: async (...a) => { calls.push(a); } };
    await applyItem(cleanPageMeta(), deps);
    assert.equal(calls.length, 2);
  });
});
