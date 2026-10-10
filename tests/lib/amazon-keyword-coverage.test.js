import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokens, isIndexed, productLine, aggregateSqp, exclusionReason, buildCoverage, renderDigest, gapCount,
} from '../../lib/amazon/keyword-coverage.js';
import { pickSqpFiles, isRsc, listingsByAsin, main } from '../../agents/amazon-keyword-coverage/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXCL = JSON.parse(readFileSync(join(ROOT, 'config', 'amazon-keyword-exclusions.json'), 'utf8'));

const row = (asin, q, week, vol, imp = 1, cart = 0) => ({
  asin, startDate: week,
  searchQueryData: { searchQuery: q, searchQueryVolume: vol },
  impressionData: { asinImpressionCount: imp }, clickData: { asinClickCount: 0 },
  cartAddData: { asinCartAddCount: cart }, purchaseData: { asinPurchaseCount: 0 },
});

test('tokens folds apostrophes and drops stopwords, English and Spanish', () => {
  assert.deepEqual(tokens("Men's deodorant for women"), ['mens', 'deodorant', 'women']);
  assert.deepEqual(tokens('crema de coco para el cuerpo'), ['crema', 'coco', 'cuerpo']);
});

test('isIndexed accepts singular/plural either way', () => {
  const s = new Set(['lotion', 'moisturizers', 'brushes']);
  assert.ok(isIndexed('lotions', s));
  assert.ok(isIndexed('moisturizer', s));
  assert.ok(isIndexed('brush', s));
  assert.ok(!isIndexed('cream', s));
  assert.ok(!isIndexed('mens', new Set(['men'])), 'a folded possessive is not a plural');
});

test('productLine: cream before lotion, toothpaste, deodorant', () => {
  assert.equal(productLine('REAL Coconut Oil Moisturizing Cream – Body Cream'), 'cream');
  assert.equal(productLine('Real Skin Care Coconut Body Lotion'), 'lotion');
  assert.equal(productLine('Coconut Oil Toothpaste'), 'toothpaste');
  assert.equal(productLine('Natural Deodorant Roll-On'), 'deodorant');
});

test('aggregateSqp counts a query\'s volume once per week, not once per ASIN', () => {
  const { volume, byAsin, weeks } = aggregateSqp([
    row('A', 'mens deodorant', 'w1', 100, 2), row('B', 'mens deodorant', 'w1', 100, 3),
    row('A', 'mens deodorant', 'w2', 50, 1),
  ]);
  assert.equal(volume.get('mens deodorant'), 150);
  assert.equal(byAsin.get('A').get('mens deodorant').impressions, 3);
  assert.deepEqual(weeks, ['w1', 'w2']);
});

test('exclusions: brands, the whitening ruling, absent ingredients, claims; ordinary demand passes', () => {
  assert.equal(exclusionReason('native deodorant', EXCL).kind, 'brand');
  assert.equal(exclusionReason('little seed farm deodorant', EXCL).kind, 'brand');
  assert.equal(exclusionReason('whitening toothpaste', EXCL).kind, 'never');
  assert.equal(exclusionReason('toothpaste for stains', EXCL).kind, 'never');
  assert.equal(exclusionReason('xylitol toothpaste', EXCL).kind, 'never');
  assert.equal(exclusionReason('lotion for eczema', EXCL).kind, 'never');
  assert.equal(exclusionReason('clinical strength deodorant for women', EXCL).kind, 'never');
  assert.equal(exclusionReason('bad breath treatment for adults', EXCL).kind, 'never');
  for (const ok of ['mens deodorant', 'kids toothpaste', 'lotion for women', 'desodorante sin aluminio mujer', 'wildcrafted frankincense deodorant']) {
    assert.equal(exclusionReason(ok, EXCL), null, ok);
  }
});

const LISTINGS = [
  { asin: 'D1', sku: 'd', title: 'Natural Deodorant Roll-On for Women & Men', bullets: ['Aluminum free'], keywords: 'travel' },
  { asin: 'T1', sku: 't', title: 'Coconut Oil Toothpaste', bullets: ['fluoride free'], keywords: '' },
];

test('buildCoverage: a covered query, a gap with the missing words, an excluded query', () => {
  const r = buildCoverage({
    rows: [
      row('D1', 'deodorant women', 'w1', 600),
      row('D1', 'mens deodorant', 'w1', 100, 6, 1),
      row('D1', 'native deodorant', 'w1', 50),
      row('T1', 'kids toothpaste', 'w1', 80),
      row('ZZ', 'unknown', 'w1', 5),
    ],
    listings: LISTINGS,
    exclusions: EXCL,
  });
  const deo = r.lines.deodorant;
  assert.equal(deo.covered, 1);
  assert.deepEqual(deo.gaps.map((g) => [g.query, g.missingWords]), [['mens deodorant', ['mens']]]);
  assert.deepEqual(deo.excluded.map((x) => x.query), ['native deodorant']);
  assert.deepEqual(r.lines.toothpaste.gaps[0].missingWords, ['kids']);
  assert.deepEqual(r.unlisted, ['ZZ']);
  assert.equal(gapCount(r), 2);
  assert.match(renderDigest(r), /mens deodorant/);
});

test('backend search terms count as indexed', () => {
  const r = buildCoverage({ rows: [row('D1', 'travel deodorant', 'w1', 10)], listings: LISTINGS, exclusions: EXCL });
  assert.equal(r.lines.deodorant.gaps.length, 0);
});

test('agent helpers: newest N dumps, CLAUDE.md brand rule, one listing per ASIN preferring the SKU with bullets', () => {
  assert.deepEqual(pickSqpFiles(['2026-09-27-search-query-performance-production.json', 'x.json', '2026-10-04-search-query-performance-production.json', '2026-09-20-search-query-performance-production.json'], 2),
    ['2026-09-27-search-query-performance-production.json', '2026-10-04-search-query-performance-production.json']);
  assert.equal(isRsc('Culina Cast Iron Soap'), false);
  assert.equal(isRsc('Real Skin Care Toothpaste'), true);
  const v = (value) => [{ value, marketplace_id: 'M', language_tag: 'en_US' }];
  const got = listingsByAsin([
    { sku: 'FBM', summaries: [{ asin: 'A' }], attributes: { item_name: v('Real Toothpaste') } },
    { sku: 'MAIN', summaries: [{ asin: 'A' }], attributes: { item_name: v('Real Toothpaste'), bullet_point: [...v('b1'), ...v('b2')], generic_keyword: v('kids') } },
    { sku: 'C', summaries: [{ asin: 'B' }], attributes: { item_name: v('Culina Cast Iron Oil') } },
  ], 'M');
  assert.deepEqual(got.map((l) => [l.asin, l.sku, l.keywords]), [['A', 'MAIN', 'kids']]);
});

test('stale or missing search data reports an error and computes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwc-'));
  const notes = [];
  const say = async (n) => notes.push(n);
  let r = await main({ argv: [], notify: say, dumpDir: dir, outDir: dir, log: () => {} });
  assert.equal(r.reason, 'no-sqp');
  writeFileSync(join(dir, '2026-08-01-search-query-performance-production.json'), JSON.stringify({ rows: [] }));
  r = await main({ argv: [], notify: say, dumpDir: dir, outDir: dir, now: new Date('2026-10-01T00:00:00Z'), log: () => {} });
  assert.equal(r.reason, 'stale-sqp');
  assert.deepEqual(notes.map((n) => n.status), ['error', 'error']);
});

test('a normal run writes the report, never PATCHes, and files a deferred info row', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kwc-'));
  writeFileSync(join(dir, '2026-10-04-search-query-performance-production.json'), JSON.stringify({ rows: [row('D1', 'mens deodorant', '2026-09-20', 100)] }));
  const calls = [];
  const v = (value) => [{ value, marketplace_id: 'M', language_tag: 'en_US' }];
  const spapi = {
    getClient: async () => ({}), getMarketplaceId: () => 'M',
    request: async (_c, method, path) => {
      calls.push(method);
      return { items: [{ sku: 'd', summaries: [{ asin: 'D1' }], attributes: { item_name: v('Natural Deodorant Roll-On'), bullet_point: v('b') } }] };
    },
  };
  process.env.AMAZON_SPAPI_SELLER_ID ??= 'S';
  const notes = [];
  const r = await main({ argv: [], spapi, notify: async (n) => notes.push(n), dumpDir: dir, outDir: dir, now: new Date('2026-10-10T00:00:00Z'), log: () => {} });
  assert.equal(r.gaps, 1);
  assert.deepEqual([...new Set(calls)], ['GET']);
  assert.equal(notes[0].status, 'info');
  assert.ok(!notes[0].immediate);
  assert.ok(existsSync(join(dir, 'latest.json')) && existsSync(join(dir, '2026-10-10.md')));
});

test('the agent source never imports a listing writer', () => {
  const src = readFileSync(join(ROOT, 'agents', 'amazon-keyword-coverage', 'index.js'), 'utf8');
  assert.doesNotMatch(src, /'PATCH'|"PATCH"|patchPath|buildPatch|remediate-/);
});
