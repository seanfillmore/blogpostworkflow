import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyResolvedUrls,
  unresolvedRedirects,
  detectBrandCited,
  detectCompetitorCitations,
  redirectResolutionBanner,
} from '../../lib/citation-detect.js';

const R = (t) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${t}`;
const BRAND = { name: 'Real Skin Care', domain: 'realskincare.com' };
const COMPETITORS = [
  { name: 'Native', domain: 'nativecos.com' },
  { name: "Tom's of Maine", domain: 'tomsofmaine.com' },
  { name: 'Primally Pure', domain: 'primallypure.com' },
];

// ── The bug itself ───────────────────────────────────────────────────────────

test('THE BUG: an unresolved grounding redirect can never match the brand', () => {
  const urls = [R('abc'), R('def')];
  assert.equal(detectBrandCited(urls, BRAND), false,
    'this is the pre-fix behaviour and must stay the degraded fallback');
  assert.deepEqual(detectCompetitorCitations(urls, COMPETITORS), []);
});

test('THE FIX: resolving the redirect makes the brand citation visible', () => {
  const urls = [R('abc'), R('def')];
  const resolved = new Map([
    [R('abc'), 'https://www.realskincare.com/blogs/news/coconut-toothpaste-benefits'],
    [R('def'), 'https://www.tomsofmaine.com/products/toothpaste'],
  ]);
  const effective = applyResolvedUrls(urls, resolved);
  assert.equal(detectBrandCited(effective, BRAND), true);
  assert.deepEqual(detectCompetitorCitations(effective, COMPETITORS), ["Tom's of Maine"]);
});

// ── applyResolvedUrls ────────────────────────────────────────────────────────

test('applyResolvedUrls preserves order and length, passing unresolved through', () => {
  const urls = [R('a'), 'https://www.gq.com/story/x', R('b')];
  const resolved = new Map([[R('a'), 'https://example.com/one']]);
  assert.deepEqual(applyResolvedUrls(urls, resolved), [
    'https://example.com/one',
    'https://www.gq.com/story/x',
    R('b'),
  ]);
});

test('applyResolvedUrls accepts a plain object as well as a Map', () => {
  assert.deepEqual(
    applyResolvedUrls([R('a')], { [R('a')]: 'https://example.com/one' }),
    ['https://example.com/one'],
  );
});

test('applyResolvedUrls tolerates null inputs', () => {
  assert.deepEqual(applyResolvedUrls(null, null), []);
  assert.deepEqual(applyResolvedUrls([R('a')], null), [R('a')]);
});

test('a partial resolution degrades to a partial answer, never a short list', () => {
  const urls = [R('a'), R('b'), R('c')];
  const effective = applyResolvedUrls(urls, new Map([[R('b'), 'https://www.realskincare.com/x']]));
  assert.equal(effective.length, 3);
  assert.equal(detectBrandCited(effective, BRAND), true);
  assert.equal(unresolvedRedirects(effective).length, 2, 'the two that failed are still countable');
});

// ── unresolvedRedirects ──────────────────────────────────────────────────────

test('unresolvedRedirects counts only grounding redirects', () => {
  assert.equal(unresolvedRedirects([R('a'), 'https://www.gq.com/x', R('b')]).length, 2);
  assert.equal(unresolvedRedirects(['https://www.realskincare.com/x']).length, 0);
  assert.equal(unresolvedRedirects(undefined).length, 0);
});

// ── detectBrandCited / detectCompetitorCitations ─────────────────────────────

test('brand detection keeps the ORIGINAL loose substring basis, case-insensitively', () => {
  assert.equal(detectBrandCited(['https://WWW.REALSKINCARE.COM/products/x'], BRAND), true);
  assert.equal(detectBrandCited(['https://www.nativecos.com/x'], BRAND), false);
});

test('brand detection with no domain configured returns false rather than matching everything', () => {
  assert.equal(detectBrandCited(['https://www.realskincare.com/x'], {}), false);
  assert.equal(detectBrandCited(['https://www.realskincare.com/x'], null), false);
});

test('competitor detection returns names in config order and dedupes by competitor', () => {
  const urls = [
    'https://www.primallypure.com/a',
    'https://www.nativecos.com/b',
    'https://www.primallypure.com/c',
  ];
  assert.deepEqual(detectCompetitorCitations(urls, COMPETITORS), ['Native', 'Primally Pure']);
});

test('competitor detection skips entries with no domain and tolerates empty input', () => {
  assert.deepEqual(detectCompetitorCitations(['https://x.com/a'], [{ name: 'Broken' }]), []);
  assert.deepEqual(detectCompetitorCitations(null, COMPETITORS), []);
  assert.deepEqual(detectCompetitorCitations(['https://x.com/a'], null), []);
});

// ── the banner: a disarmed check must never look like a clean one ────────────

test('banner says OFF loudly when redirects were seen and resolution was disabled', () => {
  const s = redirectResolutionBanner({ mode: 'off', redirects_seen: 1066, redirects_resolved: 0, redirects_unresolved: 1066 });
  assert.match(s, /OFF/);
  assert.match(s, /1066/);
  assert.match(s, /reads 0 by construction/);
});

test('banner still says OFF when nothing was seen — never an empty string', () => {
  const s = redirectResolutionBanner({ mode: 'off', redirects_seen: 0 });
  assert.match(s, /OFF/);
  assert.ok(s.length > 0);
});

test('banner distinguishes a clean ON run from one with unresolved redirects', () => {
  const clean = redirectResolutionBanner({ mode: 'on', redirects_seen: 10, redirects_resolved: 10, redirects_unresolved: 0 });
  assert.match(clean, /^Redirect resolution ON/);
  assert.doesNotMatch(clean, /⚠/);

  const partial = redirectResolutionBanner({ mode: 'on', redirects_seen: 10, redirects_resolved: 7, redirects_unresolved: 3 });
  assert.match(partial, /⚠/);
  assert.match(partial, /3 unresolved/);
});

test('banner reports an ON run with nothing to resolve without claiming a resolution', () => {
  const s = redirectResolutionBanner({ mode: 'on', redirects_seen: 0 });
  assert.match(s, /no grounding redirects/);
});

test('banner tolerates a missing block (a pre-2026-09-21 snapshot)', () => {
  assert.match(redirectResolutionBanner(undefined), /OFF/);
});
