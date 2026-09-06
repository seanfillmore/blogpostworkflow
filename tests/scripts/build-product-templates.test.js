import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST, applyManifest, blockSource, templateNick, serialize, settingsKey, SUBSCRIPTION_CLAUSE, ladderTiers, isRedundantCrossSell } from '../../scripts/build-product-templates.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const tpl = (f) => JSON.parse(readFileSync(join(ROOT, 'theme', 'templates', f), 'utf8'));

test('every manifest entry names a template that exists', () => {
  for (const f of Object.keys(MANIFEST)) {
    assert.ok(existsSync(join(ROOT, 'theme', 'templates', f)), `${f} missing`);
  }
});

test('every shared block named in the manifest has a source file', () => {
  const names = new Set(Object.values(MANIFEST).flatMap((s) => [...s.shared, ...Object.keys(s.insertAfter)]));
  for (const n of names) {
    assert.ok(existsSync(join(ROOT, 'theme', 'blocks', `${n}.liquid`)), `theme/blocks/${n}.liquid missing`);
  }
});

test('a per-template extra is appended INSIDE the style wrapper', () => {
  // lotion's discount-callout is core CSS + rules only its page needs. Landing
  // them after </style> would make every extra rule inert.
  const out = blockSource('discount-callout', 'product.landing-page-lotion.json', read);
  assert.ok(out.trimEnd().endsWith('</style>'));
  assert.equal((out.match(/<\/style>/g) ?? []).length, 1);
  assert.ok(out.includes('testimonial-quotes'), 'lotion extras absent');
  // and the core is still whole
  assert.ok(out.includes(read('theme/blocks/discount-callout.liquid').replace('</style>', '')));
});

test('a template with no extras gets the core verbatim', () => {
  assert.equal(
    blockSource('discount-callout', 'product.landing-page-bar-soap.json', read),
    read('theme/blocks/discount-callout.liquid'),
  );
});

test('the ported guarantee carries NO product-specific testimonial', () => {
  // The guarantee is a store-wide promise already stated in every shipping
  // tab. The testimonial next to it on lotion is that product's, and copying
  // it onto five other PDPs would be fabricating an endorsement.
  const g = read('theme/blocks/trust-line.liquid');
  assert.match(g, /30 days/);
  assert.doesNotMatch(g, /&ldquo;|&rdquo;|ABSORBS|Ariel/);
  assert.equal((g.match(/<p\b/g) ?? []).length, 1);
  // lotion keeps its own, as an extra rather than a second copy of the promise
  const lotion = blockSource('trust-line', 'product.landing-page-lotion.json', read);
  assert.ok(lotion.startsWith(g));
  assert.match(lotion, /Ariel/);
});

test('applyManifest REFUSES to drop a block the page actually renders', () => {
  const t = tpl('product.landing-page-toothpaste.json');
  // Put an orphan back into block_order: it is live markup now, not dead weight.
  t.sections.main.blocks.vqr_live = { type: 'custom_liquid', settings: { custom_liquid: 'x' } };
  t.sections.main.block_order.push('vqr_live');
  const spec = MANIFEST['product.landing-page-toothpaste.json'];
  const saved = spec.drop;
  spec.drop = ['vqr_live'];
  try {
    assert.throws(() => applyManifest(t, 'product.landing-page-toothpaste.json', read), /IS in block_order/);
  } finally { spec.drop = saved; }
});

test('applyManifest is idempotent — a second pass changes nothing', () => {
  for (const f of Object.keys(MANIFEST)) {
    const a = tpl(f);
    applyManifest(a, f, read);
    const once = serialize(a);
    applyManifest(a, f, read);
    assert.equal(serialize(a), once, `${f} not idempotent`);
  }
});

test('the guarantee lands directly under the buy CTA on every page that gains it', () => {
  for (const [f, spec] of Object.entries(MANIFEST)) {
    const anchor = spec.insertAfter['trust-line'];
    if (!anchor) continue;
    const t = tpl(f);
    applyManifest(t, f, read);
    const order = t.sections.main.block_order;
    assert.equal(order[order.indexOf(anchor) + 1], 'trust-line', `${f}: not adjacent to ${anchor}`);
    // The anchor must be whatever carries the Add to cart on THAT page:
    // buy_buttons on variant-picker pages, the ladder where it owns the box.
    assert.ok(['buy_buttons', 'quantity-ladder'].includes(anchor), `${f}: odd anchor ${anchor}`);
    assert.ok(order.includes(anchor), `${f}: anchor missing`);
  }
});

test('the two landers are deliberately excluded from the guarantee line', () => {
  for (const f of ['product.bundle-landing.json', 'product.landing-page-sensitive-skin-set-lander.json']) {
    assert.equal(MANIFEST[f].insertAfter['trust-line'], undefined);
    // ...because their trust-row already promises it, and twice is not twice as good.
    assert.match(tpl(f).sections.main.blocks['trust-row'].settings.custom_liquid, /30-Day Money-Back Guarantee/);
  }
});

test('Recurpay is never unified — they are two DIFFERENT app blocks', () => {
  // recurpay-widget (7 pages) and recurpay-app-block-widget (cream, lotion)
  // differ by `type`, not just id. Collapsing them changes which subscription
  // widget renders on lotion, which is 72% of revenue.
  for (const spec of Object.values(MANIFEST)) {
    for (const n of [...spec.shared, ...spec.drop, ...Object.keys(spec.insertAfter)]) {
      assert.ok(!/recurpay/i.test(n), `recurpay must not be unified: ${n}`);
    }
  }
});

test('tab-shipping is one paragraph with ONE token, not two forked copies', () => {
  // The clause is a CLAIM, so the two variants must never be two hand-kept
  // strings that can drift apart in wording while differing in claim.
  const src = read('theme/blocks/tab-shipping.liquid');
  assert.equal((src.match(/%%SUBSCRIPTION%%/g) ?? []).length, 1);
  assert.doesNotMatch(src, /subscription order/);
  const on = blockSource('tab-shipping', 'product.landing-page-lotion.json', read);
  const off = blockSource('tab-shipping', 'product.landing-page-lip-balm.json', read);
  assert.match(on, /\$45\+ and on every subscription order\./);
  assert.match(off, /\$45\+\. Standard/);
  // Identical everywhere else: the ONLY difference is the clause.
  assert.equal(on.replace(SUBSCRIPTION_CLAUSE, ''), off);
  // No token may survive into shipped copy.
  for (const f of Object.keys(MANIFEST)) {
    for (const n of MANIFEST[f].shared) {
      assert.doesNotMatch(blockSource(n, f, read), /%%\w+%%/, `${f}/${n}`);
    }
  }
});

test('the subscription claim appears exactly where something IS subscribable', () => {
  // Measured live 2026-09-05 per page, across EVERY tier the page sells --
  // the three ladder pages qualify only because a multipack TIER carries the
  // selling plan while the single unit does not.
  const SUBSCRIBABLE = {
    toothpaste: true,          // coconut-toothpaste-3-pack
    deodorant: true,           // coconut-deodorant-4-pack
    'bar-soap': true,          // coconut-bar-soap-4-pack
    lotion: true,
    cream: true,
    'sensitive-skin-set-lander': true,
    'lip-balm': false,         // no tier has a plan
    'liquid-soap': false,      // neither pump nor refill
    'bundle-landing': false,   // none of its six bundles
  };
  for (const [f, spec] of Object.entries(MANIFEST)) {
    assert.equal(spec.subscribable, SUBSCRIBABLE[templateNick(f)], `${f} subscribable flag`);
    if (!spec.shared.includes('tab-shipping')) continue;
    const out = blockSource('tab-shipping', f, read);
    assert.equal(/subscription order/.test(out), spec.subscribable, `${f} claim/flag mismatch`);
  }
});

test('bundle-landing has no tab-shipping to unify', () => {
  // It uses a single `tabs` block and carries no shipping copy at all, so the
  // flag there governs nothing -- stated as a test so a later reader does not
  // "fix" the omission.
  assert.ok(!MANIFEST['product.bundle-landing.json'].shared.includes('tab-shipping'));
  assert.equal(tpl('product.bundle-landing.json').sections.main.blocks['tab-shipping'], undefined);
});

test('serialize round-trips every committed template byte-identically', () => {
  // This is the property that keeps a two-line edit from rewriting 588 lines
  // and making the pre-apply diff useless as a safety check.
  for (const f of Object.keys(MANIFEST)) {
    const raw = readFileSync(join(ROOT, 'theme', 'templates', f), 'utf8');
    assert.equal(serialize(JSON.parse(raw)), raw, `${f} does not round-trip`);
  }
});

test('templateNick maps both template naming shapes', () => {
  assert.equal(templateNick('product.landing-page-lotion.json'), 'lotion');
  assert.equal(templateNick('product.bundle-landing.json'), 'bundle-landing');
});

// The `complete-the-routine` card. Removing it from four pages is the one
// change here a shopper sees, so what governs it is a RULE derived from each
// template, never a hand-kept list that can drift from the ladders.

test('redundancy is judged from the template, not asserted', () => {
  // Redundant exactly when the card points at a product the page's own ladder
  // already sells as a tier. This has to hold BOTH before the drop has been
  // applied and after it, because the repo templates are the builder's own
  // output — an assertion that only holds pre-apply fails the moment it works.
  for (const [f, spec] of Object.entries(MANIFEST)) {
    const t = tpl(f);
    const dropping = (spec.dropSections ?? []).includes('complete-the-routine');
    if (t.sections['complete-the-routine']) {
      // Still present: the manifest must agree with the rule about it.
      assert.equal(dropping, isRedundantCrossSell(t, 'complete-the-routine'),
        `${f}: dropSections disagrees with the redundancy rule`);
    } else if (dropping) {
      // Already applied. The only thing left to check is that nothing dangles:
      // a key left in `order` renders nothing and shows as a broken section in
      // the theme editor.
      assert.ok(!(t.order ?? []).includes('complete-the-routine'),
        `${f}: section removed but still referenced in order`);
    }
  }
});

test('a page that keeps its card still sells something the ladder does not', () => {
  // The positive half of the rule, stated independently of the manifest: every
  // surviving card points OUTSIDE its page's ladder.
  for (const f of Object.keys(MANIFEST)) {
    const t = tpl(f);
    const card = t.sections['complete-the-routine'];
    if (!card) continue;
    const target = card.settings?.product;
    assert.ok(target, `${f}: card with no product`);
    assert.ok(!ladderTiers(t).includes(target),
      `${f}: card points at "${target}", which the ladder already sells`);
  }
});

test('the genuine cross-sells are KEPT', () => {
  // cream and lotion both point at the Sensitive Skin Set, which neither page
  // sells — that is a real conversion path, not a duplicate.
  for (const f of ['product.landing-page-cream.json', 'product.landing-page-lotion.json']) {
    const t = tpl(f);
    assert.equal(t.sections['complete-the-routine'].settings.product, 'sensitive-skin-starter-set');
    assert.equal(isRedundantCrossSell(t, 'complete-the-routine'), false);
    assert.ok(!(MANIFEST[f].dropSections ?? []).includes('complete-the-routine'));
    applyManifest(t, f, read);
    assert.ok(t.sections['complete-the-routine'], `${f}: cross-sell was removed`);
    assert.ok(t.order.includes('complete-the-routine'));
  }
});

test('applyManifest REFUSES to drop a section that is not redundant', () => {
  const f = 'product.landing-page-lotion.json';
  const spec = MANIFEST[f];
  const saved = spec.dropSections;
  spec.dropSections = ['complete-the-routine'];   // lotion's card is a real cross-sell
  try {
    assert.throws(() => applyManifest(tpl(f), f, read), /does not point at a ladder tier/);
  } finally { spec.dropSections = saved; }
});

test('dropping a section removes it from BOTH sections and order', () => {
  // Leaving the key in `order` renders nothing but leaves a dangling reference
  // the theme editor then shows as a broken section.
  const f = 'product.landing-page-bar-soap.json';
  const t = tpl(f);
  applyManifest(t, f, read);
  assert.equal(t.sections['complete-the-routine'], undefined);
  assert.ok(!t.order.includes('complete-the-routine'));
});

test('ladderTiers reads the baked handles, and is empty without a ladder', () => {
  assert.deepEqual(
    ladderTiers(tpl('product.landing-page-toothpaste.json')),
    ['coconut-oil-toothpaste', 'coconut-toothpaste-3-pack'],
  );
  assert.deepEqual(ladderTiers(tpl('product.landing-page-lotion.json')), []);
});
