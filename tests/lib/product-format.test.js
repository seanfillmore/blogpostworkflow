import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, soapFormatFromText, productKeyFromLinks, resolveProductKey,
} from '../../lib/product-format.js';

const INGREDIENTS = {
  lotion:      { name: 'Body Lotion', handle: 'coconut-lotion', format: 'squeeze bottle' },
  bar_soap:    { name: 'Bar Soap', handle: 'coconut-soap', format: 'bar' },
  liquid_soap: { name: 'Foaming Liquid Soap', handle: 'organic-foaming-hand-soap', format: 'foaming pump bottle' },
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
