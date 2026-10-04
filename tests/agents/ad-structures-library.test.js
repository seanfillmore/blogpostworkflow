import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LAYOUTS, EVIDENCE, DEFAULT_LIBRARY_PATH, loadLibrary, eligible, selectStructures } from '../../agents/ad-concepts/structures.js';

const base = (o = {}) => ({
  id: 's1', name: 'S', status: 'approved',
  sources: [{ brand: 'B', days: 100, adLibraryUrl: 'https://x', image: 'sources/a.jpg' }],
  layout: 'comment-card', ratio: '1:1', fits: ['cream'], requires: [], people: 'none',
  scene: { primary: 'p', fallback: 'f' }, slots: {}, notes: '', ...o,
});
function lib(structures) {
  const dir = mkdtempSync(join(tmpdir(), 'lib-'));
  mkdirSync(join(dir, 'sources'));
  writeFileSync(join(dir, 'sources', 'a.jpg'), 'x');
  const p = join(dir, 'library.json');
  writeFileSync(p, JSON.stringify({ version: 1, structures }));
  return p;
}

test('constants', () => {
  assert.deepEqual(LAYOUTS, ['comment-card', 'headline-over-photo', 'split-two-panel', 'checklist-split', 'photo-only', 'labelled-bundle']);
  assert.deepEqual(EVIDENCE, ['review', 'offer', 'catalogFact', 'bundleLanding']);
});

test('valid library loads', () => {
  const l = loadLibrary(lib([base()]));
  assert.equal(l.version, 1);
  assert.equal(l.structures.length, 1);
});

const bad = {
  'unknown layout': { layout: 'nope' },
  'bad status': { status: 'live' },
  'empty sources': { sources: [] },
  'missing source image': { sources: [{ brand: 'B', days: 1, adLibraryUrl: 'u', image: 'sources/missing.jpg' }] },
  'bad requires': { requires: ['vibes'] },
  'missing scene.primary': { scene: { fallback: 'f' } },
  'bad ratio': { ratio: '9:16' },
  'empty fits': { fits: [] },
};
for (const [name, o] of Object.entries(bad)) {
  test(`rejects ${name}, naming the id`, () => {
    assert.throws(() => loadLibrary(lib([base({ id: 'broken-one', ...o })])), /broken-one/);
  });
}

const S = (id, layout, days, o = {}) => base({ id, layout, sources: [{ brand: 'B', days, adLibraryUrl: 'u', image: 'sources/a.jpg' }], ...o });
const ctx = (kinds, ev) => ({ productKinds: kinds, evidence: new Set(ev) });

test('eligible: approved only, evidence present, fits intersects', () => {
  const l = { structures: [
    S('a', 'comment-card', 1, { requires: ['review'] }),
    S('b', 'photo-only', 1, { status: 'candidate' }),
    S('c', 'split-two-panel', 1, { fits: ['serum'] }),
    S('d', 'photo-only', 1),
  ] };
  assert.deepEqual(eligible(l, ctx(['cream'], [])).map(s => s.id), ['d']);
  assert.deepEqual(eligible(l, ctx(['cream'], ['review'])).map(s => s.id), ['a', 'd']);
});

test('labelled-bundle-offer needs offer and bundleLanding', () => {
  const l = loadLibrary(DEFAULT_LIBRARY_PATH);
  const ids = (ev) => eligible(l, ctx(['cream', 'lotion'], ev)).map(s => s.id);
  assert.ok(!ids(['review', 'catalogFact', 'offer']).includes('labelled-bundle-offer'));
  assert.ok(!ids(['review', 'catalogFact', 'bundleLanding']).includes('labelled-bundle-offer'));
  assert.ok(ids(['offer', 'bundleLanding']).includes('labelled-bundle-offer'));
});

test('selectStructures: days desc, distinct layouts, slots', () => {
  const list = [S('a', 'comment-card', 100), S('b', 'comment-card', 300), S('c', 'photo-only', 200), S('d', 'split-two-panel', 50), S('e', 'checklist-split', 10)];
  assert.deepEqual(selectStructures(list, { slots: 3 }).map(s => s.id), ['b', 'c', 'd']);
});

test('selectStructures: max days across sources', () => {
  const two = S('x', 'photo-only', 10);
  two.sources.push({ brand: 'B', days: 500, adLibraryUrl: 'u', image: 'sources/a.jpg' });
  assert.equal(selectStructures([S('y', 'comment-card', 300), two], { slots: 2 })[0].id, 'x');
});

test('selectStructures: override first, then fill; invalid override throws', () => {
  const list = [S('a', 'comment-card', 300), S('c', 'photo-only', 200), S('d', 'split-two-panel', 50)];
  assert.deepEqual(selectStructures(list, { slots: 2, override: ['d'] }).map(s => s.id), ['d', 'a']);
  assert.throws(() => selectStructures(list, { override: ['zzz'] }), /zzz.*not eligible/);
});

test('real library loads with the six seeded structures', () => {
  const l = loadLibrary();
  assert.deepEqual(l.structures.map(s => s.id).sort(), ['comment-card-offer', 'labelled-bundle-offer', 'ours-vs-theirs-checklist', 'product-group-plain', 'texture-scoop', 'they-think-we-sell'].sort());
  const by = Object.fromEntries(l.structures.map(s => [s.id, s]));
  assert.equal(by['texture-scoop'].people, 'hands');
  assert.deepEqual(by['labelled-bundle-offer'].requires, ['offer', 'bundleLanding']);
  assert.equal(by['they-think-we-sell'].plates[0].productFree, true);
  assert.ok(by['ours-vs-theirs-checklist'].rows.theirs.length >= 3);
  for (const s of l.structures) assert.ok(!JSON.stringify(s).includes('—'), s.id);
  assert.ok(!/antiperspirant|mineral oil|petrolatum/i.test(JSON.stringify(l)));
});

test('labelPositions, when present, must be 0-1 fractions', () => {
  const ok = { labelPositions: [{ x: 0.2, y: 0.1, tx: 0.3, ty: 0.4 }, { x: 0.8, y: 0.1, tx: 0.7, ty: 0.4 }] };
  assert.equal(loadLibrary(lib([base(ok)])).structures.length, 1);
  assert.throws(() => loadLibrary(lib([base({ id: 'lp', labelPositions: [{ x: 2, y: 0.1, tx: 0.3, ty: 0.4 }] })])), /lp.*labelPositions/);
});

test('the seeded labelled-bundle structure carries label positions', () => {
  const s = loadLibrary().structures.find(x => x.id === 'labelled-bundle-offer');
  assert.ok(s.labelPositions.length >= 2 && s.labelPositions.length <= 4);
});

test('whyIneligible names the reason', async () => {
  const { whyIneligible } = await import('../../agents/ad-concepts/structures.js');
  assert.match(whyIneligible(base({ requires: ['offer'] }), { productKinds: ['cream'], evidence: new Set() }), /missing evidence: offer/);
  assert.equal(whyIneligible(base(), { productKinds: ['cream'], evidence: new Set() }), null);
});
