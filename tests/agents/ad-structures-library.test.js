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

// ---- task 6 fix round 1 ----
import { supportedRatios, RUN_RATIOS, PLATE_RATIOS } from '../../agents/ad-concepts/structures.js';

test('run and plate ratio vocabularies', () => {
  assert.deepEqual(RUN_RATIOS, ['4:5', '1:1']);
  assert.deepEqual(PLATE_RATIOS, ['1:1', '4:5', '3:4', '9:16']);
});

test('plates[].ratio must be a plate ratio', () => {
  const plates = (r) => [{ kind: 'generic', productFree: true, ratio: r, scene: { primary: 'p' } }, { kind: 'product', productFree: false, ratio: '3:4' }];
  assert.equal(loadLibrary(lib([base({ plates: plates('9:16') })])).structures.length, 1);
  assert.throws(() => loadLibrary(lib([base({ id: 'pr', plates: plates('16:9') })])), /pr.*plate ratio/);
  assert.throws(() => loadLibrary(lib([base({ id: 'pr2', plates: [{ kind: 'product' }] })])), /pr2.*plate ratio/);
});

test('ratios[] lists the run ratios a structure supports; each must be one its layout can render', () => {
  assert.deepEqual(supportedRatios(base({ ratio: '4:5' })), ['4:5']);
  assert.deepEqual(supportedRatios(base({ ratio: '4:5', ratios: ['4:5', '1:1'] })), ['4:5', '1:1']);
  assert.throws(() => loadLibrary(lib([base({ id: 'rr', layout: 'split-two-panel', ratio: '4:5', ratios: ['4:5', '1:1'] })])), /rr.*1:1/);
});

test('eligible filters by the run ratio when ctx.ratio is given', () => {
  const l = { structures: [S('a', 'comment-card', 1, { ratio: '4:5', ratios: ['4:5', '1:1'] }), S('b', 'split-two-panel', 1, { ratio: '4:5' })] };
  assert.deepEqual(eligible(l, { ...ctx(['cream'], []), ratio: '1:1' }).map(s => s.id), ['a']);
  assert.deepEqual(eligible(l, { ...ctx(['cream'], []), ratio: '4:5' }).map(s => s.id), ['a', 'b']);
  assert.match(whyIneligibleOf(l.structures[1], '1:1'), /does not support 1:1/);
});
async function whyIneligibleOfImpl() { return (await import('../../agents/ad-concepts/structures.js')).whyIneligible; }
const whyIneligibleFn = await whyIneligibleOfImpl();
function whyIneligibleOf(s, ratio) { return whyIneligibleFn(s, { ...ctx(['cream'], []), ratio }); }

test('seeded library: every structure runs at 4:5; texture-scoop is cream only; split plates carry their ratios', () => {
  const by = Object.fromEntries(loadLibrary().structures.map(s => [s.id, s]));
  for (const s of Object.values(by)) assert.ok(supportedRatios(s).includes('4:5'), s.id);
  assert.deepEqual(by['texture-scoop'].fits, ['cream']);
  assert.deepEqual(by['they-think-we-sell'].plates.map(p => p.ratio), ['9:16', '3:4']);
});
