import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseLibraryResponse, daysRunning, isBodyCareAd, rankCandidates, parseTagResponse,
  libraryUrl, collect, approveCandidate, WallError, scrollUntilStable,
} from '../../agents/ad-concepts/research.js';
import { loadLibrary } from '../../agents/ad-concepts/structures.js';

const fixture = readFileSync(new URL('../fixtures/ad-library-response.txt', import.meta.url), 'utf8');

test('parseLibraryResponse walks the blob, skips junk, normalizes ads', () => {
  const ads = parseLibraryResponse(fixture);
  assert.deepEqual(ads.map(a => a.id).sort(), ['111', '222']);
  const a = ads.find(x => x.id === '111');
  assert.equal(a.pageName, 'Test Brand');
  assert.equal(a.body, 'Rich body butter for dry skin');
  assert.equal(a.start, 1733000000);
  assert.deepEqual(a.images, ['https://img/1.jpg']);
  const c = ads.find(x => x.id === '222');
  assert.equal(c.body, 'Card body');
  assert.deepEqual(c.images, ['https://img/c.jpg']);
});

test('daysRunning floors whole days from epoch seconds', () => {
  const now = Date.UTC(2026, 9, 3);
  assert.equal(daysRunning(now / 1000 - 90 * 86400 - 5, now), 90);
  assert.equal(daysRunning(now / 1000 + 100, now), 0);
});

test('isBodyCareAd keeps lotion/cream/butter/balm, excludes serum, fragrance, deodorant, soap', () => {
  assert.equal(isBodyCareAd({ body: 'Our whipped body butter', title: '' }), true);
  assert.equal(isBodyCareAd({ body: '', title: 'Tallow balm for dry skin' }), true);
  assert.equal(isBodyCareAd({ body: 'Face serum cream', title: '' }), false);
  assert.equal(isBodyCareAd({ body: 'Body lotion fragrance mist', title: '' }), false);
  assert.equal(isBodyCareAd({ body: 'natural deodorant cream', title: '' }), false);
  assert.equal(isBodyCareAd({ body: 'moisturizing soap bar', title: '' }), false);
  assert.equal(isBodyCareAd({ body: 'shoes', title: '' }), false);
});

test('rankCandidates: static, body care, >= minDays, de-duplicated, longest first', () => {
  const now = Date.UTC(2026, 9, 3);
  const mk = (id, days, o = {}) => ({ id, start: now / 1000 - days * 86400, body: 'body lotion', title: '', images: ['u'], videos: 0, displayFormat: 'IMAGE', ...o });
  const r = rankCandidates([mk('a', 100), mk('b', 400), mk('c', 30), mk('d', 200, { videos: 1 }), mk('e', 200, { images: [] }), mk('f', 200, { displayFormat: 'DPA' }), mk('b', 400), mk('g', 200, { body: 'serum' })], { minDays: 90, now });
  assert.deepEqual(r.map(x => x.id), ['b', 'a']);
  assert.equal(r[0].days, 400);
});

test('parseTagResponse is fail-closed', () => {
  const ok = parseTagResponse('{"format":"comment-card","nonTransferable":[],"summary":"s"}');
  assert.equal(ok.format, 'comment-card');
  assert.deepEqual(ok.nonTransferable, []);
  assert.throws(() => parseTagResponse('nope'));
  assert.throws(() => parseTagResponse('{"format":"x"}'), /nonTransferable/);
  assert.throws(() => parseTagResponse('{"format":"","nonTransferable":[]}'));
  assert.throws(() => parseTagResponse('{"format":"a","nonTransferable":"no"}'));
});

test('libraryUrl uses page id when known, else keyword search', () => {
  assert.match(libraryUrl({ pageId: '123' }), /view_all_page_id=123/);
  assert.match(libraryUrl({ name: "Kiehl's" }), /q=Kiehl%27s/);
  assert.match(libraryUrl({ keyword: 'body lotion' }), /q=body%20lotion/);
});

function fakeBrowser({ wallOn = null } = {}) {
  const visited = [];
  return {
    visited,
    factory: async () => ({
      visit: async (url) => {
        visited.push(url);
        if (wallOn && url.includes(wallOn)) throw new WallError('login wall');
        return parseLibraryResponse(fixture);
      },
      close: async () => {},
    }),
  };
}

test('collect paces between page loads and merges brands + keywords', async () => {
  const b = fakeBrowser(); const sleeps = [];
  const r = await collect({ brands: [{ key: 'x', name: 'X', pageId: '1' }, { key: 'y', name: 'Y' }], keywords: ['body lotion'], browserFactory: b.factory, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(b.visited.length, 3);
  assert.ok(sleeps.length >= 2 && sleeps.every(ms => ms >= 3000));
  assert.equal(r.stopped, null);
  assert.equal(r.ads.filter(a => a.source === 'x').length, 2);
});

test('collect stops at a wall and reports what it has', async () => {
  const b = fakeBrowser({ wallOn: 'q=Y' });
  const r = await collect({ brands: [{ key: 'x', name: 'X', pageId: '1' }, { key: 'y', name: 'Y' }, { key: 'z', name: 'Z', pageId: '3' }], keywords: [], browserFactory: b.factory, sleep: async () => {} });
  assert.match(r.stopped, /login wall/);
  assert.equal(b.visited.length, 2);
  assert.ok(r.ads.length > 0);
});

function dataDir(structures) {
  const dir = mkdtempSync(join(tmpdir(), 'adstruct-'));
  mkdirSync(join(dir, 'sources')); mkdirSync(join(dir, 'candidates'));
  writeFileSync(join(dir, 'sources', 'a.jpg'), 'x');
  writeFileSync(join(dir, 'library.json'), JSON.stringify({ schema: 's', version: 1, structures }));
  return dir;
}
const approvedCC = {
  id: 'comment-card-offer', name: 'CC', status: 'approved', sources: [{ brand: 'B', days: 100, adLibraryUrl: 'https://x', image: 'sources/a.jpg' }],
  layout: 'comment-card', ratio: '4:5', ratios: ['4:5', '1:1'], fits: ['cream', 'lotion'], requires: ['review'], people: 'none',
  scene: { primary: 'p', fallback: 'f' }, slots: { headline: { source: 'model', maxWords: 5 } }, notes: '',
};
const cand = (o = {}) => ({ id: 'brand-1', brand: 'Brand', adId: '1', adLibraryUrl: 'https://www.facebook.com/ads/library/?id=1', days: 150, format: 'comment-card', nonTransferable: [], summary: 'sum', image: 'img-1.jpg', ...o });
function withCandidates(dir, list) {
  writeFileSync(join(dir, 'candidates', '2026-10-03.json'), JSON.stringify({ candidates: list }));
  writeFileSync(join(dir, 'candidates', 'img-1.jpg'), 'jpegbytes');
}

test('approve appends a candidate-status entry (never approved) that loads', async () => {
  const dir = dataDir([approvedCC]); withCandidates(dir, [cand()]);
  const r = await approveCandidate('brand-1', { dir });
  assert.equal(r.written, true);
  const lib = loadLibrary(join(dir, 'library.json'));
  const s = lib.structures.find(x => x.id === 'brand-1');
  assert.equal(s.status, 'candidate');
  assert.equal(s.layout, 'comment-card');
  assert.equal(s.sources[0].days, 150);
  assert.ok(existsSync(join(dir, s.sources[0].image)));
  assert.equal(lib.structures.length, 2);
});

test('approve refuses non-transferable candidates and leaves library.json untouched', async () => {
  const dir = dataDir([approvedCC]); withCandidates(dir, [cand({ nonTransferable: ['before/after of skin'] })]);
  const before = readFileSync(join(dir, 'library.json'), 'utf8');
  const r = await approveCandidate('brand-1', { dir });
  assert.equal(r.written, false);
  assert.match(r.reason, /non-transferable/);
  assert.equal(readFileSync(join(dir, 'library.json'), 'utf8'), before);
});

test('approve with no automatic layout mapping writes a note and does not touch the library', async () => {
  const dir = dataDir([approvedCC]); withCandidates(dir, [cand({ format: 'other' })]);
  const before = readFileSync(join(dir, 'library.json'), 'utf8');
  const r = await approveCandidate('brand-1', { dir });
  assert.equal(r.written, false);
  assert.equal(readFileSync(join(dir, 'library.json'), 'utf8'), before);
  assert.ok(existsSync(join(dir, 'candidates', 'brand-1.needs-human.md')));
});

test('approve is idempotent on id and rejects unknown ids', async () => {
  const dir = dataDir([approvedCC]); withCandidates(dir, [cand()]);
  await approveCandidate('brand-1', { dir });
  const again = await approveCandidate('brand-1', { dir });
  assert.equal(again.written, false);
  await assert.rejects(approveCandidate('nope', { dir }), /unknown candidate/);
});

test('approve write is atomic: a failing rename leaves the original library intact', async () => {
  const dir = dataDir([approvedCC]); withCandidates(dir, [cand()]);
  const before = readFileSync(join(dir, 'library.json'), 'utf8');
  await assert.rejects(approveCandidate('brand-1', { dir, rename: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(readFileSync(join(dir, 'library.json'), 'utf8'), before);
  assert.equal(existsSync(join(dir, 'library.json.tmp')), false);
});

test('rankCandidates drops ads with no usable start date', () => {
  const now = Date.UTC(2026, 9, 3);
  const r = rankCandidates([{ id: 'n', body: 'body lotion', title: '', images: ['u'], videos: 0 }, { id: 'o', start: now / 1000 - 200 * 86400, body: 'body lotion', title: '', images: ['u'], videos: 0 }], { now });
  assert.deepEqual(r.map(x => x.id), ['o']);
});

test('scrolling re-checks for a wall after each scroll and stops with WallError', async () => {
  let scrolls = 0;
  await assert.rejects(scrollUntilStable({
    scrolls: 8, scroll: async () => { scrolls++; }, sleep: async () => {}, count: () => scrolls,
    bodyText: async () => (scrolls >= 2 ? 'Log in to continue' : 'ads'),
  }), WallError);
  assert.equal(scrolls, 2);
});

test('scrolling ends when the count is stable', async () => {
  let scrolls = 0;
  await scrollUntilStable({ scrolls: 8, scroll: async () => { scrolls++; }, sleep: async () => {}, count: () => 5, bodyText: async () => 'ads' });
  assert.equal(scrolls, 4);
});

test('approve with a missing candidate image writes a note instead of crashing', async () => {
  const dir = dataDir([approvedCC]); withCandidates(dir, [cand({ image: 'gone.jpg' })]);
  const before = readFileSync(join(dir, 'library.json'), 'utf8');
  const r = await approveCandidate('brand-1', { dir });
  assert.equal(r.written, false);
  assert.match(r.reason, /missing/);
  assert.ok(existsSync(join(dir, 'candidates', 'brand-1.needs-human.md')));
  assert.equal(readFileSync(join(dir, 'library.json'), 'utf8'), before);
});

test('approve borrows only from an approved, plate-free, same-layout entry', async () => {
  const bad = { ...approvedCC, id: 'plated', plates: [{ ratio: '1:1', scene: { primary: 'x' } }] };
  const cand2 = { ...approvedCC, id: 'cand-only', status: 'candidate' };
  const dir = dataDir([bad, cand2]); withCandidates(dir, [cand()]);
  const r = await approveCandidate('brand-1', { dir });
  assert.equal(r.written, false);
  assert.match(r.reason, /approved, plate-free/);
});
