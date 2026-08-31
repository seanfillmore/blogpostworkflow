import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLAN,
  BLOCKED,
  NOT_INGREDIENTS,
  ref,
  escapedRef,
  findCardByTitle,
  objectSpan,
  replaceBlockImage,
  decideEntry,
} from '../../scripts/fix-ingredient-card-images.mjs';

// A miniature of the real live shape, including Shopify's escaped slashes and a
// body string carrying braces and an escaped quote — both of which broke naive
// implementations of objectSpan.
const LIVE = `{
  "sections": {
    "hero-ingredient-cards": {
      "type": "multicolumn",
      "blocks": {
        "ingredient-card-1": {
          "type": "column",
          "settings": {
            "image": "shopify:\\/\\/shop_images\\/Coconut_Oil_Extract.webp",
            "title": "Organic Virgin Coconut Oil",
            "text": "<p>Cold-pressed. Uses {braces} and a \\" quote.<\\/p>"
          }
        },
        "ingredient-card-2": {
          "type": "column",
          "settings": {
            "image": "shopify:\\/\\/shop_images\\/Spring_Water.webp",
            "title": "Organic Jojoba",
            "text": "<p>Jojoba.<\\/p>"
          }
        },
        "ingredient-card-3": {
          "type": "column",
          "settings": {
            "image": "shopify:\\/\\/shop_images\\/Wax.webp",
            "title": "Organic Red Palm Oil"
          }
        }
      },
      "block_order": ["ingredient-card-1", "ingredient-card-2", "ingredient-card-3"],
      "settings": { "image_ratio": "adapt", "heading": "Three ingredients, three jobs" }
    }
  },
  "order": ["hero-ingredient-cards"]
}
`;

const doc = () => JSON.parse(LIVE);
const entry = (over) => ({
  template: 'product.landing-page-lotion.json',
  title: 'Organic Jojoba',
  before: ['Spring_Water.webp'],
  after: 'Jojoba.webp',
  ...over,
});

test('the fixture parses and matches how Shopify escapes a file reference', () => {
  assert.equal(
    doc().sections['hero-ingredient-cards'].blocks['ingredient-card-2'].settings.image,
    ref('Spring_Water.webp'),
  );
  assert.ok(LIVE.includes(escapedRef('Spring_Water.webp')));
  // The whole reason this script splices bytes: stringify would drop the \/ .
  assert.ok(!JSON.stringify(ref('Spring_Water.webp')).includes('\\/'));
});

test('findCardByTitle keys on the card title, not its position', () => {
  const section = doc().sections['hero-ingredient-cards'];
  assert.equal(findCardByTitle(section, 'Organic Red Palm Oil').key, 'ingredient-card-3');
  assert.equal(findCardByTitle(section, 'Organic Jojoba').key, 'ingredient-card-2');
  assert.equal(findCardByTitle(section, 'Baking Soda'), null);
});

test('objectSpan is string-aware — braces and escaped quotes inside body copy do not unbalance it', () => {
  const [start, end] = objectSpan(LIVE, 'ingredient-card-1');
  const body = LIVE.slice(start, end);
  assert.ok(body.includes('Organic Virgin Coconut Oil'));
  assert.ok(body.includes('{braces}'));
  // It must stop before the next card, or a replace would hit the wrong block.
  assert.ok(!body.includes('Organic Jojoba'));
  assert.doesNotThrow(() => JSON.parse(body));
});

test('objectSpan needs the COLON — a key also appears in block_order and in order', () => {
  // Matching a bare quoted key reports every real template as ambiguous, since
  // each block key is repeated inside `block_order`. The fixture has that shape.
  assert.equal((LIVE.match(/"ingredient-card-2"/g) || []).length, 2);
  assert.doesNotThrow(() => objectSpan(LIVE, 'ingredient-card-2'));
});

test('objectSpan refuses a key it cannot uniquely locate rather than guessing', () => {
  const dupe = LIVE.replace('"block_order": [', '"ingredient-card-2": {}, "block_order": [');
  assert.throws(() => objectSpan(dupe, 'ingredient-card-2'), /not unique/);
  assert.throws(() => objectSpan(LIVE, 'ingredient-card-9'), /not found/);
});

test('objectSpan scopes a block to its own section, so two sections may share a block key', () => {
  const twoSections = LIVE.replace(
    '"order": ["hero-ingredient-cards"]',
    '"order": ["hero-ingredient-cards"]',
  ).replace(
    '  "sections": {\n',
    '  "sections": {\n    "other-row": { "type": "multicolumn", "blocks": { "ingredient-card-2": { "settings": { "image": "shopify:\\/\\/shop_images\\/Grapefruit.webp", "title": "Organic Jojoba" } } }, "block_order": ["ingredient-card-2"] },\n',
  );
  JSON.parse(twoSections); // the fixture must stay valid JSON
  assert.throws(() => objectSpan(twoSections, 'ingredient-card-2'), /not unique/);

  const out = replaceBlockImage(twoSections, 'hero-ingredient-cards', 'ingredient-card-2', 'Spring_Water.webp', 'Jojoba.webp');
  const doc2 = JSON.parse(out);
  assert.equal(doc2.sections['hero-ingredient-cards'].blocks['ingredient-card-2'].settings.image, ref('Jojoba.webp'));
  assert.equal(doc2.sections['other-row'].blocks['ingredient-card-2'].settings.image, ref('Grapefruit.webp'));
});

test('replaceBlockImage changes only that block, and leaves every other byte alone', () => {
  const out = replaceBlockImage(LIVE, 'hero-ingredient-cards', 'ingredient-card-2', 'Spring_Water.webp', 'Jojoba.webp');
  const after = JSON.parse(out).sections['hero-ingredient-cards'].blocks;

  assert.equal(after['ingredient-card-2'].settings.image, ref('Jojoba.webp'));
  assert.equal(after['ingredient-card-1'].settings.image, ref('Coconut_Oil_Extract.webp'));
  assert.equal(after['ingredient-card-3'].settings.image, ref('Wax.webp'));

  // The escaping style of the rest of the file survives untouched, and the diff
  // is exactly one substitution.
  assert.ok(out.includes(escapedRef('Jojoba.webp')));
  assert.ok(out.includes(escapedRef('Coconut_Oil_Extract.webp')));
  assert.ok(out.includes('<p>Cold-pressed. Uses {braces} and a \\" quote.<\\/p>'));
  assert.equal(
    out.replace(escapedRef('Jojoba.webp'), escapedRef('Spring_Water.webp')),
    LIVE,
  );
});

test('replaceBlockImage refuses when the live image is not what the plan expected', () => {
  assert.throws(
    () => replaceBlockImage(LIVE, 'hero-ingredient-cards', 'ingredient-card-2', 'Wax.webp', 'Jojoba.webp'),
    /expected/,
  );
});

test('decideEntry changes a card whose BEFORE state matches', () => {
  const v = decideEntry(entry(), doc());
  assert.equal(v.status, 'change');
  assert.equal(v.blockKey, 'ingredient-card-2');
  assert.equal(v.to, ref('Jojoba.webp'));
});

test('decideEntry is idempotent — an applied card is already-applied, never a re-write', () => {
  const applied = JSON.parse(replaceBlockImage(LIVE, 'hero-ingredient-cards', 'ingredient-card-2', 'Spring_Water.webp', 'Jojoba.webp'));
  assert.equal(decideEntry(entry(), applied).status, 'already-applied');
});

test('decideEntry SKIPS rather than overwrites when live has moved on', () => {
  const moved = doc();
  moved.sections['hero-ingredient-cards'].blocks['ingredient-card-2'].settings.image = ref('Grapefruit.webp');
  const v = decideEntry(entry(), moved);
  assert.equal(v.status, 'skip');
  assert.match(v.why, /live state has moved on/);

  const renamed = doc();
  renamed.sections['hero-ingredient-cards'].blocks['ingredient-card-2'].settings.title = 'Jojoba Oil';
  assert.equal(decideEntry(entry(), renamed).status, 'skip');

  assert.equal(decideEntry(entry(), { sections: {} }).status, 'skip');
});

test('no incoming image is WIDER than the incumbent max, so the row keeps its height', () => {
  // sections/multicolumn.liquid under `image_ratio: adapt` renders ONE
  // `--image-ratio-percent: 1 / max(aspect_ratio)` across every card. Card
  // POSITION is irrelevant; only an image wider than the current maximum
  // changes the row, and it would shorten it and crop every sibling harder.
  const ASPECT = { // measured, width / height
    'Coconut_Oil_Extract.webp': 1200 / 794, // 1.5113 — the incumbent max
    'Spring_Water.webp': 1200 / 801,
    'Wax.webp': 1200 / 800,
    'red-palm-oil.webp': 1200 / 800,
    'Jojoba.webp': 1200 / 900, // 1.3333, the tallest
    // Prepared 2026-08-31 at the incumbent geometry exactly, so the max cannot move.
    'baking-soda.webp': 1200 / 794,
    'myrrh-resin.webp': 1200 / 794,
    'red-palm-fruit.webp': 1200 / 794,
    'essential-oils.webp': 1200 / 794,
  };
  const incumbentMax = ASPECT['Coconut_Oil_Extract.webp'];
  assert.equal((1 / incumbentMax * 100).toFixed(4), '66.1667'); // what the PDPs render

  for (const e of PLAN) {
    assert.ok(ASPECT[e.after] !== undefined, `${e.after} has no measured aspect ratio`);
    assert.ok(
      ASPECT[e.after] <= incumbentMax,
      `${e.after} (${ASPECT[e.after].toFixed(4)}) is wider than ${incumbentMax.toFixed(4)} and would shorten the row`,
    );
    for (const b of e.before) assert.ok(ASPECT[b] !== undefined, `${b} has no measured aspect ratio`);
  }
});

test('the four prepared assets exist on disk at exactly the incumbent geometry', async () => {
  // They arrived as 1024x1024 and are pre-cropped rather than uploaded square,
  // so what was reviewed is what ships instead of a sight-unseen 34% cover-crop.
  const { default: sharp } = await import('sharp');
  for (const f of ['baking-soda.webp', 'myrrh-resin.webp', 'red-palm-fruit.webp', 'essential-oils.webp']) {
    const m = await sharp(new URL(`../../data/brand/pdp-sections/${f}`, import.meta.url).pathname).metadata();
    assert.equal(`${m.width}x${m.height}`, '1200x794', `${f} is ${m.width}x${m.height}`);
  }
});

test('the rejected essential-oils source is KEPT beside the one that shipped', async () => {
  // The first shot had "FRANKINCENBE" plus gibberish binomials and could not be
  // cropped clean, because the LABELLED bottles were the subject. The fix was to
  // remove the labels, not to fix the words. Both files stay: one records why
  // the brief says "unlabelled", the other is what ships.
  const { existsSync } = await import('node:fs');
  const at = (f) => new URL(`../../data/brand/pdp-sections/${f}`, import.meta.url).pathname;
  assert.ok(existsSync(at('essential-oils.REJECTED.source.jpg')), 'the rejected shot must be kept');
  assert.ok(existsSync(at('essential-oils.source.jpg')), 'the shipped source must be kept');
  assert.ok(existsSync(at('essential-oils.webp')), 'the prepared asset must be kept');
});

test('BLOCKED is empty — every ingredient card shows its own ingredient', () => {
  // Kept rather than deleted: an empty list is a measured state the run prints,
  // and the next card added to a template starts here. Any future entry must
  // still name what it NEEDS rather than carrying a near-miss substitution.
  assert.equal(BLOCKED.length, 0);
  for (const b of BLOCKED) {
    assert.ok(!('after' in b), `${b.title} must not carry a substitution`);
    assert.ok(b.needs, `${b.title} must name what it needs`);
  }
});

test('every ingredient-naming card in every template is covered by the plan', () => {
  // The real completeness statement: each (template, title) pair that names an
  // ingredient is either in PLAN or explicitly recorded as a mechanism card.
  const covered = new Set([...PLAN, ...NOT_INGREDIENTS].map((e) => `${e.template}::${e.title}`));
  const expected = [
    ['product.landing-page-lotion.json', 'Organic Jojoba'],
    ['product.landing-page-lotion.json', 'Organic Red Palm Oil'],
    ['product.landing-page-cream.json', 'Organic Red Palm Oil'],
    ['product.landing-page-lip-balm.json', 'Organic Red Palm Oil'],
    ['product.landing-page-deodorant.json', 'Organic Jojoba'],
    ['product.landing-page-deodorant.json', 'Baking Soda'],
    ['product.landing-page-toothpaste.json', 'Baking Soda'],
    ['product.landing-page-toothpaste.json', 'Wildcrafted Myrrh'],
    ['product.landing-page-bar-soap.json', 'Variation Essential Oils'],
    ['product.landing-page-liquid-soap.json', 'Variation Essential Oils'],
    ['product.landing-page-bar-soap.json', 'Naturally Lathering'],
    ['product.landing-page-liquid-soap.json', 'Built for the Foaming Dispenser'],
  ];
  for (const [t, title] of expected) assert.ok(covered.has(`${t}::${title}`), `${t} "${title}" is uncovered`);
});

test('the essential-oils card stays UNLABELLED, not re-labelled with named oils', () => {
  // The copy beside it lists a different blend per variation (Orange Zest is
  // five oils; Calming Lavender is one; Pure Unscented has none), so any set of
  // NAMED bottles is wrong for most variations even spelled perfectly.
  const soaps = PLAN.filter((e) => e.title === 'Variation Essential Oils');
  assert.equal(soaps.length, 2, 'bar soap and liquid soap');
  assert.ok(soaps.every((e) => e.after === 'essential-oils.webp'));
});

test('a per-entry section is honoured, so a non-PDP template can be swept', () => {
  const pageEntry = PLAN.find((e) => e.template.startsWith('page.'));
  assert.ok(pageEntry, 'the draft ingredient page should be in the plan');
  assert.equal(pageEntry.section, 'landing_ingredients_nd9fBX');

  const doc = JSON.parse(LIVE.replace('"hero-ingredient-cards"', '"landing_ingredients_nd9fBX"'));
  const v = decideEntry({ ...entry(), section: 'landing_ingredients_nd9fBX' }, doc);
  assert.equal(v.status, 'change');
  assert.equal(v.sectionKey, 'landing_ingredients_nd9fBX');
  // …and the default section is still used when none is named.
  assert.equal(decideEntry(entry(), doc).status, 'skip');
});

test('`before` accepts any prior value the card has held, so an entry survives its own history', () => {
  const e = { ...entry(), before: ['Wax.webp', 'Spring_Water.webp'], after: 'Jojoba.webp' };
  const v = decideEntry(e, doc());
  assert.equal(v.status, 'change');
  assert.equal(v.matched, 'Spring_Water.webp', 'reports WHICH prior value it found');

  // Still refuses a value the plan never listed.
  const other = doc();
  other.sections['hero-ingredient-cards'].blocks['ingredient-card-2'].settings.image = ref('Grapefruit.webp');
  assert.equal(decideEntry(e, other).status, 'skip');
});

test('the plan only moves images ONTO an ingredient that matches the card title', () => {
  const expected = {
    'Organic Jojoba': 'Jojoba.webp',
    'Organic Red Palm Oil': 'red-palm-fruit.webp',
    'Red Palm Oil': 'red-palm-fruit.webp',
    'Baking Soda': 'baking-soda.webp',
    'Wildcrafted Myrrh': 'myrrh-resin.webp',
    'Variation Essential Oils': 'essential-oils.webp',
  };
  for (const e of PLAN) assert.equal(e.after, expected[e.title], `${e.title} → ${e.after}`);
});

test('the retired teal red-palm image is left with no referrer anywhere', () => {
  // It is accurate but a mint/teal lab flask against warm-natural siblings.
  // Sweeping the draft page too is what stops it surviving on the one surface
  // nobody looks at.
  const swaps = PLAN.filter((e) => e.before.includes('red-palm-oil.webp'));
  assert.equal(swaps.length, 4, 'lotion, cream, lip-balm and the draft page');
  assert.ok(swaps.some((e) => e.template.startsWith('page.')), 'the draft page must be included');
  assert.ok(swaps.every((e) => e.after === 'red-palm-fruit.webp'));
});

test('the three lists are disjoint — a card is fixable, blocked, or not an ingredient', () => {
  const id = (r) => `${r.template}::${r.title}`;
  const all = [...PLAN, ...BLOCKED, ...NOT_INGREDIENTS].map(id);
  assert.equal(new Set(all).size, all.length);
});
