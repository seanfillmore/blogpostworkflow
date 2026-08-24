import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, soapFormatFromText, productKeyFromLinks, resolveProductKey,
} from '../../lib/product-format.js';

const INGREDIENTS = {
  lotion:      { name: 'Body Lotion', shopify_handle: 'coconut-lotion', format: 'squeeze bottle' },
  bar_soap:    { name: 'Bar Soap', shopify_handle: 'coconut-soap', format: 'bar' },
  liquid_soap: { name: 'Foaming Liquid Soap', shopify_handle: 'organic-foaming-hand-soap', format: 'foaming pump bottle' },
};

// ── normalizeText: the hyphen bug ─────────────────────────────────────────────
test('hyphens become separators so a phrase can match a SLUG', () => {
  // "hand soap" could never match "liquid-hand-soap" before this.
  assert.equal(normalizeText('bar-soap-vs-liquid-hand-soap'), 'bar soap vs liquid hand soap');
  assert.equal(normalizeText('A__B  c'), 'a b c');
  assert.equal(normalizeText(null), '');
});

// ── soapFormatFromText ────────────────────────────────────────────────────────
test('explicit liquid signals classify as liquid_soap', () => {
  for (const t of ['foaming hand soap', 'best liquid soap', 'organic hand wash', 'foaming pump soap']) {
    assert.equal(soapFormatFromText(t), 'liquid_soap', t);
  }
});

test('explicit bar signals classify as bar_soap', () => {
  for (const t of ['natural bar soap for men', 'moisturizing soap bar']) {
    assert.equal(soapFormatFromText(t), 'bar_soap', t);
  }
});

test('BOTH signals -> bar wins (a comparison post, and bar is the safe default)', () => {
  assert.equal(soapFormatFromText('bar-soap-vs-liquid-hand-soap-which-is-better'), 'bar_soap');
});

test('generic "soap" stays bar_soap — this change moves nothing already correct', () => {
  for (const t of ['natural soap', 'how does soap work', 'what is castile soap', 'best soap to use on new tattoo']) {
    assert.equal(soapFormatFromText(t), 'bar_soap', t);
  }
});

test('plural "soaps" is matched (the \\b-after-noun gap)', () => {
  assert.equal(soapFormatFromText('best soaps for tattoos'), 'bar_soap');
});

test('non-soap text returns null', () => {
  assert.equal(soapFormatFromText('best natural deodorant'), null);
  assert.equal(soapFormatFromText(''), null);
});

// ── productKeyFromLinks ───────────────────────────────────────────────────────
test('reads the handle from the ingredients config, not a hardcoded map', () => {
  assert.equal(
    productKeyFromLinks(['https://www.realskincare.com/products/organic-foaming-hand-soap'], INGREDIENTS),
    'liquid_soap',
  );
  assert.equal(productKeyFromLinks(['/products/coconut-soap'], INGREDIENTS), 'bar_soap');
});

test('several links to the SAME product still resolve', () => {
  assert.equal(productKeyFromLinks(
    ['/products/coconut-soap', '/products/coconut-soap?variant=1'], INGREDIENTS), 'bar_soap');
});

test('links to TWO different products are ambiguous -> null, never a guess', () => {
  assert.equal(productKeyFromLinks(['/products/coconut-soap', '/products/coconut-lotion'], INGREDIENTS), null);
});

test('unknown or absent product links -> null', () => {
  assert.equal(productKeyFromLinks(['/products/not-ours'], INGREDIENTS), null);
  assert.equal(productKeyFromLinks(['/collections/soap'], INGREDIENTS), null);
  assert.equal(productKeyFromLinks([], INGREDIENTS), null);
  assert.equal(productKeyFromLinks(null, null), null);
});

// ── resolveProductKey ─────────────────────────────────────────────────────────
test('the LINKED product wins — it is what the page sells', () => {
  // The tattoo case: text says bar, the CTA sells the foaming pump.
  const r = resolveProductKey({ textKey: 'bar_soap', linkKey: 'liquid_soap' });
  assert.equal(r.key, 'liquid_soap');
  assert.equal(r.source, 'link');
  assert.deepEqual(r.mismatch, { fromText: 'bar_soap', fromLink: 'liquid_soap' });
});

test('agreement reports no mismatch', () => {
  const r = resolveProductKey({ textKey: 'bar_soap', linkKey: 'bar_soap' });
  assert.equal(r.key, 'bar_soap');
  assert.equal(r.mismatch, null);
});

test('no link falls back to text, and that is not a mismatch', () => {
  const r = resolveProductKey({ textKey: 'bar_soap', linkKey: null });
  assert.equal(r.key, 'bar_soap');
  assert.equal(r.source, 'text');
  assert.equal(r.mismatch, null);
});

test('neither signal -> null (a topical-authority post)', () => {
  assert.deepEqual(resolveProductKey({ textKey: null, linkKey: null }),
    { key: null, source: 'none', mismatch: null });
});

// ── the REAL config, because a synthetic fixture cannot catch a wrong field name ──
//
// The first cut of productKeyFromLinks read `p.handle`. Every product in
// config/ingredients.json uses `shopify_handle`, so it matched nothing in
// production while every synthetic test passed. These load the actual file.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'ingredients.json'), 'utf8'));

test('REAL CONFIG: every product resolves from its own product URL', () => {
  const entries = Object.entries(REAL).filter(([, p]) => p?.shopify_handle || p?.handle);
  assert.ok(entries.length >= 5, `expected several products, got ${entries.length}`);
  for (const [key, p] of entries) {
    const handle = p.shopify_handle || p.handle;
    assert.equal(
      productKeyFromLinks([`https://www.realskincare.com/products/${handle}`], REAL),
      key,
      `${key} (/products/${handle}) must resolve back to ${key}`,
    );
  }
});

test('REAL CONFIG: the two soaps are distinct and both resolve', () => {
  const bar = productKeyFromLinks(['/products/coconut-soap'], REAL);
  const liquid = productKeyFromLinks(['/products/organic-foaming-hand-soap'], REAL);
  assert.equal(bar, 'bar_soap');
  assert.equal(liquid, 'liquid_soap');
  assert.notEqual(bar, liquid);
});

test('REAL CONFIG: the tattoo post\'s actual CTA resolves to the foaming soap', () => {
  // This is the case the whole change exists for.
  assert.equal(
    productKeyFromLinks(['https://www.realskincare.com/products/organic-foaming-hand-soap'], REAL),
    'liquid_soap',
  );
});
