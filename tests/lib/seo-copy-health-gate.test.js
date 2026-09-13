/**
 * The health-claim gate for SEO copy — page titles and meta descriptions.
 *
 * These tests exist as much to pin what the gate must NOT block as what it must.
 * The failure this gate was built to prevent is a live drug claim in a SERP
 * snippet; the failure it is most likely to CAUSE is silently deleting CTR work
 * on a page whose own topic is an ingredient-avoidance headline. Both are tested.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  checkSeoCopy,
  findSeoCopyClaims,
  seoCopyConstraint,
  BLOCKING_CATEGORIES,
  ADVISORY_CATEGORIES,
  checkSeoCopyFields,
  PRODUCT_CATEGORY_CATEGORY,
  SEO_COPY_COMPLIANCE_RULE,
} from '../../lib/seo-copy-health-gate.js';

describe('seo-copy-health-gate — the live 2026-08-22 incident', () => {
  test('blocks the published title', () => {
    const r = checkSeoCopy({ title: 'Best Soap for Tattoos: Clean Ingredients That Heal' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking.length, 1);
    assert.equal(r.blocking[0].field, 'title');
    assert.equal(r.blocking[0].category, 'therapeutic');
    assert.match(r.blocking[0].match, /Heal/i);
  });

  test('blocks the published meta description', () => {
    const r = checkSeoCopy({
      meta: 'The best soap for tattoos skips harsh chemicals and supports real healing. See which natural ingredients protect new ink—and what to avoid entirely.',
    });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].field, 'meta');
    assert.equal(r.blocking[0].category, 'therapeutic');
  });

  test('passes the hand-written replacement the operator shipped', () => {
    const r = checkSeoCopy({
      title: 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free',
      meta: 'Washing new ink calls for a fragrance-free, dye-free bar. See which clean ingredients to look for in a soap for tattoos — and which to skip.',
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.blocking, []);
  });

  test('both fields are checked, not just the title', () => {
    const r = checkSeoCopy({
      title: 'Best Body Cream for Very Dry Skin',
      meta: 'Body cream keeps skin soft and hydrated while treating and preventing dry, cracked skin.',
    });
    assert.equal(r.ok, false);
    // Every occurrence is reported, not just the first per category — "treating"
    // AND "preventing". seoCopyConstraint names both to the retry prompt.
    assert.deepEqual(r.blocking.map((v) => v.field), ['meta', 'meta']);
    assert.deepEqual(r.blocking.map((v) => v.match.toLowerCase()), ['treating', 'preventing']);
  });
});

describe('seo-copy-health-gate — what must NOT be blocked', () => {
  // Every string below is real live copy on this site, measured 2026-08-23.
  // Blocking any of them removes a page from CTR work over language that is
  // this brand's whole editorial position and is not a drug claim.
  const allowed = [
    'Toxic Chemicals In Soap To Keep An Eye On',
    'Best Clean Body Lotion: Soft Skin, Zero Toxins | Real Skin Care',
    'Discover 7 harmful ingredients hiding in natural toothpaste. Learn what to avoid and find truly safe, clean oral care with Real Skin Care.',
    'To shield your skin and overall health, here are the most toxic ingredients to watch for when buying soaps.',
    'Discover what makes the healthiest deodorant and find natural alternatives free from harmful chemicals.',
    'Looking for the best unscented lotion? Discover fragrance-free, clean-ingredient body lotions that hydrate sensitive, dry skin — without synthetic scents or toxins.',
    'Discover the truth about coconut oil and stretch marks. Learn if this natural remedy works.',
    'Discover why you have itchy armpits and learn natural remedies to soothe irritation.',
  ];

  for (const text of allowed) {
    test(`allows: ${text.slice(0, 52)}…`, () => {
      assert.equal(checkSeoCopy({ title: text }).ok, true, `blocked: ${text}`);
      assert.equal(checkSeoCopy({ meta: text }).ok, true, `blocked: ${text}`);
    });
  }

  test('ordinary cosmetic performance language is untouched', () => {
    const r = checkSeoCopy({
      title: 'Best Coconut Oil Lotion for Dry, Sensitive Skin',
      meta: 'A fast-absorbing coconut oil lotion that softens flaky, itchy skin and supports the skin barrier. Non-greasy, unscented, made in the USA.',
    });
    assert.equal(r.ok, true);
  });

  test('word boundaries hold — healthy is not heal, manicure is not cure', () => {
    assert.equal(checkSeoCopy({ title: 'Healthy Skin Starts With a Clean Manicure' }).ok, true);
  });

  test('naming an ingredient the product omits is an absence, not a verdict', () => {
    assert.equal(
      checkSeoCopy({ meta: 'No SLS, no parabens, no added fragrance — just coconut oil and shea butter.' }).ok,
      true,
    );
  });
});

describe('seo-copy-health-gate — category tiers', () => {
  test('the unconditional blocking categories are the unapproved-drug ones', () => {
    // `disease` is deliberately NOT here since 2026-09-07: naming a condition is
    // advisory, claiming to fix it is blocking, and that is decided per string
    // by CURE_CONTEXT rather than by category membership.
    // `oral-drug-claim` joined 2026-09-13: enamel repair and anticavity are the fluoride
    // monograph's OTC drug claims — see tests/lib/seo-copy-oral-care-gate.test.js.
    assert.deepEqual(
      [...BLOCKING_CATEGORIES].sort(),
      ['drug', 'oral-drug-claim', 'substantiation', 'systemic-absorption', 'therapeutic'].sort(),
    );
    assert.ok(!BLOCKING_CATEGORIES.has('disease'));
  });

  test('toxicity is advisory, never blocking', () => {
    assert.ok(ADVISORY_CATEGORIES.has('toxicity'));
    assert.ok(!BLOCKING_CATEGORIES.has('toxicity'));
  });

  test('a disease name WITHOUT a cure claim is advisory, not blocking', () => {
    // Changed deliberately on 2026-09-07. "helps with" is the operator's own
    // framing ("our products can help") and is not a claim to fix anything.
    const r = checkSeoCopy({ meta: 'It also helps several skin disorders, including eczema and psoriasis.' }, { surface: 'editorial' });
    assert.equal(r.ok, true);
    assert.ok(r.advisory.some((a) => a.match.toLowerCase() === 'eczema'),
      'the condition is still REPORTED, just not blocked');
  });

  test('a disease name WITH a cure claim blocks', () => {
    const r = checkSeoCopy({ meta: 'Clears up eczema and psoriasis in days.' });
    assert.equal(r.ok, false);
    assert.ok(r.blocking.some((b) => b.category === 'disease'));
  });

  test('drug language blocks', () => {
    const r = checkSeoCopy({ meta: 'Vanilla has medicinal properties that can help with skin problems.' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].category, 'drug');
  });

  test('substantiation language blocks', () => {
    assert.equal(checkSeoCopy({ title: 'Clinically Proven Lotion, Dermatologist Approved' }).ok, false);
  });

  test('systemic absorption blocks, but plain "absorbs" does not', () => {
    assert.equal(checkSeoCopy({ meta: 'Ingredients absorbed into the bloodstream.' }).ok, false);
    assert.equal(checkSeoCopy({ meta: 'A light lotion that absorbs quickly, never greasy.' }).ok, true);
  });

  test('advisory hits are reported, and do not make the copy not-ok', () => {
    const r = checkSeoCopy({ title: 'Toxic Chemicals In Soap To Keep An Eye On' });
    assert.equal(r.ok, true);
    assert.equal(r.advisory.length, 1);
    assert.equal(r.advisory[0].category, 'toxicity');
    assert.equal(r.advisory[0].field, 'title');
  });

  test('"remedy"/"remedies" is demoted out of therapeutic to advisory', () => {
    const r = checkSeoCopy({ meta: 'Learn if this natural remedy works.' });
    assert.equal(r.ok, true);
    assert.equal(r.advisory[0].category, 'therapeutic-noun');
  });

  test('demoting the noun does not hide a real verb in the same string', () => {
    // findHealthClaims reports only the FIRST match per category, so a string
    // carrying "remedy" before "heals" would demote the whole category and let
    // the verb through. This gate matches every occurrence for that reason.
    const r = checkSeoCopy({ meta: 'This natural remedy heals cracked skin fast.' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking.length, 1);
    assert.match(r.blocking[0].match, /heals/i);
    assert.equal(r.advisory.length, 1);
    assert.match(r.advisory[0].match, /remedy/i);
  });
});

describe('seo-copy-health-gate — mechanics', () => {
  test('empty / missing fields are fine', () => {
    assert.equal(checkSeoCopy({}).ok, true);
    assert.equal(checkSeoCopy({ title: '', meta: null }).ok, true);
    assert.equal(checkSeoCopy(null).ok, true);
  });

  test('findSeoCopyClaims splits one string into the two tiers', () => {
    const r = findSeoCopyClaims('Toxic chemicals that heal nothing');
    assert.equal(r.blocking.length, 1);
    assert.equal(r.advisory.length, 1);
  });

  test('every blocking hit carries a why a human and a prompt can both use', () => {
    const r = checkSeoCopy({ title: 'Ingredients That Heal' });
    assert.ok(r.blocking[0].why.length > 20);
  });

  test('seoCopyConstraint names the offending words so the retry can avoid them', () => {
    const r = checkSeoCopy({ title: 'Ingredients That Heal', meta: 'Treats eczema fast.' });
    const c = seoCopyConstraint(r.blocking);
    assert.match(c, /Heal/i);
    assert.match(c, /eczema/i);
    assert.match(c, /cosmetic/i);
  });

  test('seoCopyConstraint on no violations is an empty string', () => {
    assert.equal(seoCopyConstraint([]), '');
  });
});

// ── product-category accuracy — the second, non-health-claim blocking source ─────
//
// Added 2026-08-24. `BLOCKING_CATEGORIES` still describes only the health-claim
// tiering, so these assertions read `result.blocking`, which is what actually decides
// whether a write is refused.

describe('seo-copy-health-gate — product-category accuracy', () => {
  test('describing our product as an antiperspirant blocks', () => {
    const r = checkSeoCopy({ meta: "Try Real Skin Care's natural antiperspirant." });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].category, PRODUCT_CATEGORY_CATEGORY);
    assert.match(r.blocking[0].match, /antiperspirant/i);
  });

  test('"our antiperspirant" blocks and names the field', () => {
    const r = checkSeoCopyFields({ 'product title': 'Our antiperspirant, aluminum-free' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].field, 'product title');
  });

  test('the CATEGORY reference never blocks — these pages rank for the query', () => {
    for (const meta of [
      'Natural Deodorant vs. Antiperspirant: What is the Actual Difference?',
      // NB: the FDA sentence is written without "over-the-counter" on purpose — that
      // phrase is already blocked by the pre-existing `drug` health-claim pattern, and
      // this case is here to isolate the product-category rule.
      'The FDA classifies antiperspirants as drugs, not cosmetics.',
      'Switching away from aluminum-based antiperspirants cuts yellow stains.',
      'Travel Size Antiperspirant: What to Know Before You Pack',
    ]) {
      assert.equal(checkSeoCopy({ meta }).ok, true, meta);
    }
  });

  test('it is a separate source from the health-claim tiers', () => {
    assert.ok(!BLOCKING_CATEGORIES.has(PRODUCT_CATEGORY_CATEGORY));
    assert.ok(!ADVISORY_CATEGORIES.has(PRODUCT_CATEGORY_CATEGORY));
  });

  test('a bare string still returns ok:true — the trap this gate already documents', () => {
    assert.equal(checkSeoCopy('our antiperspirant').ok, true);
  });

  test('markup is stripped before matching, so an href cannot trigger it', () => {
    const html = '<p>Read <a href="/blogs/news/our-antiperspirant-guide" '
      + 'title="Our Antiperspirant Guide">the guide</a>.</p>';
    assert.equal(checkSeoCopyFields({ body: html }).ok, true);
  });

  test('the retry constraint tells the model the category reference is allowed', () => {
    const r = checkSeoCopy({ meta: 'Our antiperspirant is clean.' });
    const c = seoCopyConstraint(r.blocking);
    assert.match(c, /antiperspirant/i);
    assert.match(c, /categor/i);
  });

  test('SEO_COPY_COMPLIANCE_RULE carries the rule into the first generation', () => {
    assert.match(SEO_COPY_COMPLIANCE_RULE, /antiperspirant/i);
    assert.match(SEO_COPY_COMPLIANCE_RULE, /deodorant/i);
  });
});

// ── NAMING a condition vs CLAIMING TO CURE IT (operator rule, 2026-09-07) ──────
//
// "We shouldn't outright reject eczema as a topic, our products can help. We
// just need to limit the conversation to prevent it from talking about curing."
//
// Measured before the change: of 447 live sentences naming a condition, 406
// (91%) were editorial or positional and only 35 (8%) carried a therapeutic
// verb — and most of THOSE were hedges ("It's not a cure", "Not a medical
// treatment"). Blocking the noun forbade the 91% to catch a 9% the therapeutic
// category already blocks.

const EDITORIAL = { surface: 'editorial' };

test('naming a condition is ADVISORY on an EDITORIAL surface — the topic is allowed', () => {
  for (const t of [
    'Best Body Lotion for Eczema',
    'Can I use unscented products if I have eczema?',
    'Gentle Soap for Psoriasis-Prone Skin',
    'What Dermatitis Does to Your Skin Barrier',
  ]) {
    assert.equal(checkSeoCopy({ title: t }, EDITORIAL).ok, true, `${t} should pass`);
  }
});

test('CLAIMING TO CURE it still BLOCKS — that is the whole line', () => {
  for (const t of [
    'Body Lotion That Heals Eczema',
    'Eczema Treatment Lotion',
    'Clears Up Psoriasis Fast',
    'Prevents Dermatitis Flare-Ups',
  ]) {
    assert.equal(checkSeoCopy({ title: t }, EDITORIAL).ok, false, `${t} should block even editorially`);
  }
});

test('"remedy" beside a named condition is re-promoted to BLOCKING', () => {
  // The one leak that opened when `disease` became advisory: "remedy" is
  // demoted to advisory, so "eczema remedy" would have been fully advisory and
  // shipped — exactly the cure-talk the rule forbids.
  assert.equal(checkSeoCopy({ title: 'Natural Eczema Remedy' }, EDITORIAL).ok, false);
  // …but "remedy" on its own keeps its documented demotion.
  assert.equal(checkSeoCopy({ title: 'A remedy shoppers often ask about' }, EDITORIAL).ok, true);
});

test('the 2026-08-22 incident still blocks — this change must not reopen it', () => {
  assert.equal(checkSeoCopy({
    title: 'Best Soap for Tattoos: Clean Ingredients That Heal',
    meta: 'A gentle bar that supports real healing on new ink.',
  }).ok, false);
});

test('the compliance prompt tells the writer the RULE, not the old blanket ban', () => {
  // The prompt used to say "never name a skin disease", which contradicted the
  // tier it now ships with — a gate that instructs one thing and enforces
  // another teaches the retry to delete the wrong half.
  assert.ok(!/never name a skin disease/i.test(SEO_COPY_COMPLIANCE_RULE));
  assert.match(SEO_COPY_COMPLIANCE_RULE, /You MAY name a skin condition/);
  assert.match(SEO_COPY_COMPLIANCE_RULE, /claiming to cure it is/i);
});


test('COMMERCIAL is the default, and it still blocks a named condition', () => {
  // The three prior remediations this tier had to keep valid. All are the
  // PRODUCT speaking, none contains a cure verb, and all must still block.
  for (const t of [
    'For dry patches, eczema, and overnight repair.',
    'It also helps several skin disorders, including eczema and psoriasis.',
  ]) {
    assert.equal(checkSeoCopy({ meta: t }).ok, false, `${t} must block on a commercial surface`);
    // …and the SAME string is allowed when an article is discussing it.
    assert.equal(checkSeoCopy({ meta: t }, { surface: 'editorial' }).ok, true, `${t} should be editorial-safe`);
  }
});

test('an undeclared surface gets the STRICT answer', () => {
  // Fail-closed: a caller that forgets to declare itself must not silently get
  // the permissive tier on a page with a buy button.
  assert.equal(checkSeoCopy({ title: 'Best Body Lotion for Eczema' }).ok, false);
  assert.equal(checkSeoCopy({ title: 'Best Body Lotion for Eczema' }, { surface: 'editorial' }).ok, true);
});
