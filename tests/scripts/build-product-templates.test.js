import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST, applyManifest, blockSource, templateNick, serialize } from '../../scripts/build-product-templates.mjs';

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

test('neither Recurpay nor tab-shipping is unified anywhere', () => {
  // Both were mistaken for drift. recurpay-widget and recurpay-app-block-widget
  // are DIFFERENT app blocks; tab-shipping differs by a real shipping claim.
  for (const spec of Object.values(MANIFEST)) {
    const touched = [...spec.shared, ...spec.drop, ...Object.keys(spec.insertAfter)];
    for (const n of touched) {
      assert.ok(!/recurpay/i.test(n), `recurpay must not be unified: ${n}`);
      assert.notEqual(n, 'tab-shipping');
    }
  }
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
