// tests/agents/ad-concepts-orchestrator.test.js
//
// The structure-library pipeline end to end, every model and network call stubbed.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseArgs, runAds, buildEvidenceProduct, quotableEvidence, listSiblingVariants,
  productKind, productNoun, productDescriptionShort, factCandidates, NEEDS_HUMAN_REVIEW_NOTE,
} from '../../agents/ad-concepts/index.js';
import { loadLibrary } from '../../agents/ad-concepts/structures.js';
import { LABEL_MAX_CHARS } from '../../agents/ad-concepts/layouts/labelled-bundle.js';
import { listRuns } from '../../agents/dashboard/lib/ad-studio-runs.js';

// 12+ bytes: the orchestrator sniffs the real media type, and sniffImageMediaType needs 12.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const reply = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });
const LIBRARY = loadLibrary();

const REVIEWS = [
  'This is THE moisturizer for winters for my whole family. It is long lasting and does not feel greasy.',
  'Soft, not greasy, and it soaks right in. I use it every single morning.',
  'It helps my diabetic skin so much.',
];
const LOTION_DESC = 'An 8 fl. oz. (236ml) white plastic cylindrical squeeze bottle with a black flip-top cap and a white label reading "real SKIN CARE".';
const CREAM_DESC = 'A short, wide-mouth plastic jar approximately 4 oz in size with a flat, ribbed black screw-on cap. The jar body is white.';

function product(handle, desc) {
  const kind = productKind(desc);
  return {
    handle, title: handle === 'coconut-lotion' ? 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' : 'Coconut Moisturizer | 4oz',
    variant: 'pure-unscented', unitCount: 1, labelStrings: ['real SKIN CARE', '8 fl. oz'], badgeStrings: [], labelInk: 'black',
    physicalDescription: desc, kind, productNoun: productNoun(handle, kind), productDescriptionShort: productDescriptionShort(desc, kind),
    priceLabel: '$30', url: `https://www.realskincare.com/products/${handle}`,
  };
}

function deps({ verify = () => true, reviews = REVIEWS, landing = null, productExtra = {}, photos = ['ref.jpg'] } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'ads-'));
  const prompts = [];
  const renders = [];
  const archived = [];
  const notes = [];
  let lastRender = '';
  const anthropic = { messages: { create: async (req) => {
    const t = req.messages[0].content;
    const text = typeof t === 'string' ? t : '';
    prompts.push(text);
    if (text.includes('Pick the ONE customer review')) return reply({ index: 0 });
    if (text.includes('"headline" text')) return reply({ text: 'Soft, not greasy', claims: [] });
    if (text.includes('AD-LEVEL copy')) {
      return reply({
        primaryTexts: ['Soft, not greasy. Coconut lotion that soaks right in.', 'One lotion for the whole family, every morning.'],
        headlines: ['Soft, not greasy', 'Coconut lotion'], claims: [],
      });
    }
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  } } };
  const landingObj = landing || {
    handle: 'sensitive-skin-starter-set', title: 'Sensitive Skin Moisturizing Set', url: 'https://www.realskincare.com/products/sensitive-skin-starter-set',
    variants: [{ title: 'Default Title', price: 46.8, compareAt: 58 }],
  };
  return {
    out, prompts, renders, archived, notes,
    deps: {
      outRoot: out, now: () => new Date('2026-10-03T12:00:00Z'),
      models: { copy: 'copy-model', verify: 'verify-model' },
      anthropic, library: LIBRARY,
      loadEvidence: async ({ handle }) => ({
        product: { ...product(handle, handle === 'coconut-lotion' ? LOTION_DESC : CREAM_DESC), ...productExtra },
        catalogEntry: { title: handle === 'coconut-lotion' ? 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' : 'Coconut Moisturizer | 4oz' },
        pdpBody: 'Made with organic coconut oil. Absorbs quickly. Heals cracked skin.', reviews, photoPaths: photos, photoDir: `/refs/${handle}`,
        referencePhotos: [], siblingVariants: ['coconut-breeze'], brandKit: { free_shipping_threshold: 45, manufacturing: 'Made in the USA' },
        competitorNames: ['Acme'], persona: null,
      }),
      fetchLanding: async () => landingObj,
      render: async (prompt) => { lastRender = prompt; renders.push(prompt); return JPEG; },
      verifyImage: async () => { const ok = verify(lastRender); return { ok, reasons: ok ? [] : ['label wrong'] }; },
      strayText: async () => ({ ok: true, detail: '' }),
      renderLayout: async () => ({ buffer: JPEG, overflow: false }),
      critique: async () => ({ ok: true, score: 4, reasons: [] }),
      occlusion: async () => ({ ok: true, detail: '' }),
      notify: async (n) => { notes.push(n); },
      archive: (a) => { archived.push(a); },
    },
  };
}

const ARGS = ['--products', 'coconut-moisturizer,coconut-lotion', '--variant', 'pure-unscented', '--landing', 'sensitive-skin-starter-set'];
const runJson = (out, r) => JSON.parse(readFileSync(join(out, r.runId, 'run.json'), 'utf8'));

test('parseArgs: products list, landing default, offer, structures, renders, dry run', () => {
  const a = parseArgs([...ARGS, '--offer', 'Set $46.80 (was $58)', '--structures', 'a,b,c,d', '--max-renders', '12', '--dry-run']);
  assert.deepEqual(a.products, ['coconut-moisturizer', 'coconut-lotion']);
  assert.equal(a.landing, 'sensitive-skin-starter-set');
  assert.equal(a.offer, 'Set $46.80 (was $58)');
  assert.deepEqual(a.structures, ['a', 'b', 'c', 'd']);
  assert.equal(a.maxRenders, 12);
  assert.equal(a.dryRun, true);
  assert.equal(parseArgs(['--products', 'coconut-lotion']).landing, 'coconut-lotion');
  assert.equal(parseArgs(['--products', 'coconut-lotion']).maxRenders, 30);
  assert.equal(parseArgs(['--products', 'coconut-lotion']).ratio, '4:5');
  assert.equal(parseArgs(['--products', 'coconut-lotion', '--ratio', '1:1']).ratio, '1:1');
  assert.throws(() => parseArgs(['--products', 'a', '--ratio', '9:16']), /--ratio/);
  assert.throws(() => parseArgs([]), /--products/);
  assert.throws(() => parseArgs(['--products', 'a,b']), /--landing/);
  assert.throws(() => parseArgs(['--products', 'a', '--max-renders', '0']), /max-renders/);
});

test('product kind, noun and short description come from the manifest description', () => {
  assert.equal(productKind(LOTION_DESC), 'lotion');
  assert.equal(productKind(CREAM_DESC), 'cream');
  assert.equal(productKind('A round soap bar.'), null);
  assert.equal(productNoun('coconut-lotion', 'lotion'), 'coconut lotion');
  assert.equal(productNoun('coconut-moisturizer', 'cream'), 'body cream');
  assert.equal(productDescriptionShort(LOTION_DESC, 'lotion'), '8 fl oz white squeeze bottle');
  assert.equal(productDescriptionShort(CREAM_DESC, 'cream'), '4 oz white jar');
});

test('factCandidates pulls short phrases from catalog titles and the PDP', () => {
  const f = factCandidates({ catalogEntries: [{ title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' }, { title: 'Coconut Moisturizer | 4oz' }], pdpBodies: ['Made with organic coconut oil. Absorbs quickly. ' + 'word '.repeat(20)] });
  assert.ok(f.includes('Only 6 Clean Ingredients'));
  assert.ok(f.includes('Made with organic coconut oil'));
  assert.ok(f.includes('Coconut Moisturizer'));
  assert.ok(!f.some(x => x.split(' ').length > 8));
});

test('full run: 3 finals, manifest with the landing URL and price, run.json with structures, landing, offer', async () => {
  const { out, deps: d, notes, archived } = deps();
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  const runDir = join(out, report.runId);
  assert.equal(report.results.length, 3);
  // Default selection: approved + evidence present, ranked by source days, distinct layouts.
  assert.deepEqual(report.results.map(r => r.conceptSlug), ['product-group-plain', 'comment-card-offer', 'texture-scoop']);
  const manifest = JSON.parse(readFileSync(join(runDir, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 3);
  assert.equal(manifest.short, false);
  assert.equal(manifest.productUrl, 'https://www.realskincare.com/products/sensitive-skin-starter-set');
  assert.equal(manifest.landing.price, 46.8);
  const md = readFileSync(join(runDir, 'flexible-ad.md'), 'utf8');
  assert.match(md, /sensitive-skin-starter-set/);
  const run = runJson(out, report);
  assert.deepEqual(run.structures.map(s => [s.id, s.sourceDays]), [['product-group-plain', 386], ['comment-card-offer', 304], ['texture-scoop', 256]]);
  assert.equal(run.landing.url, 'https://www.realskincare.com/products/sensitive-skin-starter-set');
  assert.equal(run.offer, null);
  // The comment card carries a verbatim review and the band is an always-true value line.
  const plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'));
  const card = plan.structures.find(s => s.id === 'comment-card-offer');
  assert.equal(card.slots.quote, REVIEWS[0]);
  assert.equal(card.slots.band, 'FREE SHIPPING ON ORDERS OVER $45');
  assert.equal(card.product, 'coconut-moisturizer');
  // The diabetic review was screened out and recorded with its reason.
  assert.ok(run.droppedReviews.some(r => /diabetic/.test(r.text) && /condition word/.test(r.reason)));
  assert.ok(existsSync(join(runDir, 'comment-card-offer', 'v1', 'meta-plate-take1-4x5.jpg')));
  assert.ok(existsSync(join(runDir, 'comment-card-offer', 'v1', 'meta-final-take1-4x5.jpg')));
  assert.equal(JSON.parse(readFileSync(join(runDir, 'comment-card-offer', 'copy.json'), 'utf8')).zones.quote, REVIEWS[0]);
  assert.equal(archived.length, 1);
  assert.notEqual(notes[0].immediate, true);
  assert.equal(notes[0].status, 'info');
  assert.ok(listRuns(out).some(r => r.runId === report.runId));
});

test('texture-scoop (hands) is flagged needsHumanReview everywhere', async () => {
  const { out, deps: d, notes } = deps();
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  assert.deepEqual(report.needsHumanReview, ['texture-scoop']);
  assert.equal(runJson(out, report).needsHumanReviewNote, NEEDS_HUMAN_REVIEW_NOTE);
  assert.match(notes[0].subject, /NEEDS HUMAN REVIEW/);
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.deepEqual(manifest.needsHumanReview, ['texture-scoop']);
  assert.match(readFileSync(join(out, report.runId, 'flexible-ad.md'), 'utf8'), /texture-scoop\/v1\/meta-final-take\d-4x5\.jpg/);
});

test('offer mismatch aborts before any render or model call', async () => {
  const { deps: d, prompts, renders } = deps();
  await assert.rejects(runAds({ args: parseArgs([...ARGS, '--offer', 'Set $40 (was $58)']), deps: d }), /matches no live variant/);
  assert.equal(prompts.length, 0);
  assert.equal(renders.length, 0);
});

test('a verified offer becomes the band on every offer-or-value slot, and is recorded', async () => {
  const { out, deps: d } = deps();
  const report = await runAds({ args: parseArgs([...ARGS, '--offer', 'Set $46.80 (was $58)', '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  for (const s of plan.structures) if (s.slots.band) assert.equal(s.slots.band, 'SENSITIVE SKIN MOISTURIZING SET $46.80 (WAS $58)');
  assert.equal(runJson(out, report).offer.band, 'SENSITIVE SKIN MOISTURIZING SET $46.80 (WAS $58)');
});

test('an offer band that fails the copy gate aborts before any paid call', async () => {
  const landing = { handle: 'x', title: 'Sensitive Set \u2014 Unscented', url: 'u', variants: [{ title: 'D', price: 46.8, compareAt: 58 }] };
  const { deps: d, prompts, renders } = deps({ landing });
  await assert.rejects(runAds({ args: parseArgs([...ARGS, '--offer', '$46.80 (was $58)']), deps: d }), /offer band/);
  assert.equal(prompts.length + renders.length, 0);
});

test('dry run writes plan.json with filled slots and makes no render', async () => {
  const { out, deps: d, renders } = deps();
  const report = await runAds({ args: parseArgs([...ARGS, '--dry-run']), deps: d });
  assert.equal(renders.length, 0);
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.equal(plan.structures.length, 3);
  assert.ok(plan.structures.every(s => s.slots && s.layout));
  assert.ok(plan.ineligible.some(s => s.id === 'labelled-bundle-offer' && /missing evidence: offer/.test(s.reason)));
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false);
  assert.equal(report.manifestReason, 'dry run');
});

test('a structure whose plate fails every take is replaced by the next eligible one with an unused layout', async () => {
  // Fail every take of the comment card's scene (primary AND fallback mention "pale wall").
  const { out, deps: d, renders } = deps({ verify: (p) => !/pale wall/.test(p) });
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  const run = runJson(out, report);
  const rej = run.rejectedStructures.find(r => r.id === 'comment-card-offer');
  assert.match(rej.reason, /no take passed/);
  assert.equal(renders.filter(p => /pale wall/.test(p)).length, 4, '2 primary + 2 fallback takes');
  assert.deepEqual(report.results.map(r => r.conceptSlug), ['product-group-plain', 'texture-scoop', 'they-think-we-sell']);
  // The split's left plate is product-free: rendered without references, checked for stray text.
  assert.ok(existsSync(join(out, report.runId, 'they-think-we-sell', 'v1', 'meta-generic-take1-9x16.jpg')));
});

test('no review fits a quote slot: that structure is skipped with the reason and replaced', async () => {
  const long = 'This is a long review that goes on and on about how much I like the lotion. '.repeat(4).trim();
  const { out, deps: d } = deps({ reviews: [long] });
  const report = await runAds({ args: parseArgs([...ARGS, '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.ok(plan.skipped.some(s => s.id === 'comment-card-offer' && /no review fits/.test(s.reason)));
  assert.ok(!plan.structures.some(s => s.id === 'comment-card-offer'));
  assert.equal(plan.structures.length, 3);
});

test('checklist rows the gates reject are recorded with their reasons', async () => {
  const { out, deps: d } = deps();
  const report = await runAds({ args: parseArgs([...ARGS, '--structures', 'ours-vs-theirs-checklist,comment-card-offer', '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  const cl = plan.structures.find(s => s.id === 'ours-vs-theirs-checklist');
  assert.ok(cl.slots.oursRows.includes('Only 6 Clean Ingredients'));
  assert.ok(plan.droppedRows.length > 0);
  assert.ok(plan.droppedRows.every(r => r.reason && r.structure));
});

test('labelled bundle: labels are product nouns <= 28 chars at the library positions, offer band', async () => {
  const { out, deps: d } = deps();
  const report = await runAds({ args: parseArgs([...ARGS, '--offer', 'Set $46.80 (was $58)', '--structures', 'labelled-bundle-offer,comment-card-offer', '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  const lb = plan.structures.find(s => s.id === 'labelled-bundle-offer');
  const entry = LIBRARY.structures.find(s => s.id === 'labelled-bundle-offer');
  assert.deepEqual(lb.slots.labels.map(l => l.text), ['Body cream', 'Coconut lotion']);
  lb.slots.labels.forEach((l, i) => {
    assert.ok(l.text.length <= LABEL_MAX_CHARS);
    for (const k of ['x', 'y', 'tx', 'ty']) { assert.equal(l[k], entry.labelPositions[i][k]); assert.ok(l[k] >= 0 && l[k] <= 1); }
  });
  assert.match(lb.slots.band, /\$46\.80 \(WAS \$58\)/);
});

test('overrides beyond 3 structures are honoured', async () => {
  const { out, deps: d } = deps();
  const ids = ['comment-card-offer', 'texture-scoop', 'they-think-we-sell', 'ours-vs-theirs-checklist'];
  const report = await runAds({ args: parseArgs([...ARGS, '--structures', ids.join(','), '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.structures.map(s => s.id), ids);
});

test('fewer than 2 eligible structures aborts before any paid call', async () => {
  const { deps: d, prompts, renders } = deps();
  d.library = { version: 1, structures: LIBRARY.structures.filter(s => s.id === 'comment-card-offer') };
  await assert.rejects(runAds({ args: parseArgs(ARGS), deps: d }), /fewer than 2 eligible/);
  assert.equal(prompts.length + renders.length, 0);
});

test('zero reference photos: rejects before any model or render call, naming the directory', async () => {
  const { deps: d, prompts, renders } = deps({ photos: [] });
  await assert.rejects(runAds({ args: parseArgs(ARGS), deps: d }), /no reference photos under \/refs\/coconut-moisturizer/);
  assert.equal(prompts.length + renders.length, 0);
});

test('empty labelStrings: refuses before any model or render call', async () => {
  const { deps: d, prompts, renders } = deps({ productExtra: { labelStrings: [] } });
  await assert.rejects(runAds({ args: parseArgs(ARGS), deps: d }), /labelStrings is empty/);
  assert.equal(prompts.length + renders.length, 0);
});

test('onStart hands over runDir before any paid call', async () => {
  const { deps: d } = deps();
  const seen = [];
  d.onStart = ({ runDir, runId }) => { seen.push(runId); assert.ok(existsSync(runDir)); };
  await runAds({ args: parseArgs([...ARGS, '--dry-run']), deps: d });
  assert.match(seen[0], /^structures-sensitive-skin-starter-set-pure-unscented-/);
});

test('render throws mid-run: that structure is recorded failed and replaced; takes already verified stay on disk', async () => {
  const { out, deps: d } = deps();
  let n = 0;
  const base = d.render;
  d.render = async (p, o) => { if (++n === 2) throw new Error('gemini said no (400)'); return base(p, o); };
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  const run = runJson(out, report);
  assert.ok(run.rejectedStructures.some(r => /^failed: gemini said no/.test(r.reason)), JSON.stringify(run.rejectedStructures));
  assert.equal(report.results.length, 3);
  assert.equal(run.error, undefined);
});

test('an unrecoverable error escapes: run.json carries error and archive runs before the rethrow', async () => {
  const { out, deps: d, archived } = deps();
  d.writeFlexibleCopy = async () => { throw new Error('ad-concepts: the copy response was cut off at the token limit.'); };
  await assert.rejects(runAds({ args: parseArgs(ARGS), deps: d }), /cut off/);
  assert.equal(archived.length, 1);
  const runId = readdirSync(out).find(f => f.startsWith('structures-'));
  const run = JSON.parse(readFileSync(join(out, runId, 'run.json'), 'utf8'));
  assert.match(run.error, /cut off/);
  assert.equal(run.results.length, 3);
});

test('a non-truncation flexible copy throw becomes manifestReason; the run still finishes', async () => {
  const { out, deps: d } = deps();
  d.writeFlexibleCopy = async () => { throw new TypeError('bad shape'); };
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  assert.match(report.manifestReason, /^flexible copy failed: bad shape/);
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false);
});

test('occlusion is asked about the layout\'s type regions; an occluded final is not used', async () => {
  const seen = [];
  const { out, deps: d } = deps();
  d.occlusion = async (o) => { seen.push(o); return o.structureId === 'product-group-plain' ? { ok: false, detail: 'the band covers the cap' } : { ok: true, detail: '' }; };
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  assert.ok(seen.every(o => Array.isArray(o.regions) && o.size && o.productDescription));
  assert.ok(runJson(out, report).rejectedStructures.some(r => r.id === 'product-group-plain' && /occludes/.test(r.reason)));
});

test('two finals: manifest is short and its markdown says so', async () => {
  const { out, deps: d } = deps();
  d.library = { version: 1, structures: LIBRARY.structures.filter(s => ['comment-card-offer', 'product-group-plain'].includes(s.id)) };
  const report = await runAds({ args: parseArgs(ARGS), deps: d });
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.short, true);
  const md = readFileSync(join(out, report.runId, 'flexible-ad.md'), 'utf8');
  assert.match(md, /SHORT/);
  assert.match(md, /add both images/);
});

test('buildEvidenceProduct carries price, url, label ink, kind, noun and short description', () => {
  const studio = { buildLabelStrings: () => ['real SKIN CARE'], resolveBadgeStrings: () => [] };
  const p = buildEvidenceProduct({ handle: 'coconut-lotion', variant: 'pure-unscented', manifestEntry: { unitCount: 1, labelInk: 'black', productDescription: LOTION_DESC }, catalogEntry: { title: 'Lotion', priceLabel: '$30', url: 'https://x/products/coconut-lotion' }, studio });
  assert.equal(p.priceLabel, '$30');
  assert.equal(p.url, 'https://x/products/coconut-lotion');
  assert.equal(p.labelInk, 'black');
  assert.equal(p.kind, 'lotion');
  assert.equal(p.productNoun, 'coconut lotion');
  assert.equal(p.productDescriptionShort, '8 fl oz white squeeze bottle');
});

test('quotableEvidence withholds health-claim reviews from the prompts AND the citable source', () => {
  const r = quotableEvidence({ pdpBody: 'One fat.', brandKit: null, catalogEntry: null, reviews: ['Lathers beautifully.', 'It cured my eczema.'] });
  assert.deepEqual(r.reviews, ['Lathers beautifully.']);
  assert.doesNotMatch(r.sourceIndex.reviews, /eczema/);
});

test('listSiblingVariants: directories only, minus the current variant and unwrapped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adc-img-'));
  for (const v of ['calming-lavender', 'nourishing-tea-tree', 'pure-unscented', 'unwrapped']) mkdirSync(join(dir, v));
  writeFileSync(join(dir, '2.jpg'), 'x');
  assert.deepEqual(listSiblingVariants(dir, 'nourishing-tea-tree'), ['calming-lavender', 'pure-unscented']);
  assert.deepEqual(listSiblingVariants(dir, null), []);
  assert.deepEqual(listSiblingVariants(join(dir, 'missing'), 'x'), []);
});

// ---- task 6 fix round 1 ----
import { readRun } from '../../agents/dashboard/lib/ad-studio-runs.js';

test('a lotion-only run never selects texture-scoop (cream only)', async () => {
  const { out, deps: d } = deps();
  const report = await runAds({ args: parseArgs(['--products', 'coconut-lotion', '--variant', 'pure-unscented', '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.ok(!plan.structures.some(s => s.id === 'texture-scoop'));
  assert.match(plan.ineligible.find(s => s.id === 'texture-scoop').reason, /fits cream/);
  await assert.rejects(runAds({ args: parseArgs(['--products', 'coconut-lotion', '--structures', 'texture-scoop', '--dry-run']), deps: deps().deps }), /texture-scoop.*not eligible/);
});

test('split run: each plate rendered at its own library ratio, named from it, and the dashboard finds the final', async () => {
  const { out, deps: d } = deps();
  const ratios = [];
  const base = d.render;
  d.render = async (p, o) => { ratios.push([/cooking coconut oil/.test(p) ? 'generic' : 'product', o.ratio]); return base(p, o); };
  const report = await runAds({ args: parseArgs([...ARGS, '--structures', 'they-think-we-sell,comment-card-offer']), deps: d });
  const v = join(out, report.runId, 'they-think-we-sell', 'v1');
  assert.ok(existsSync(join(v, 'meta-generic-take1-9x16.jpg')));
  assert.ok(existsSync(join(v, 'meta-plate-take1-3x4.jpg')));
  assert.ok(existsSync(join(v, 'meta-final-take1-4x5.jpg')));
  const proof = JSON.parse(readFileSync(join(v, 'proof.json'), 'utf8'));
  assert.equal(proof['meta-plate-take1-3x4.jpg'].final, 'meta-final-take1-4x5.jpg');
  assert.ok(ratios.some(([k, r]) => k === 'generic' && r === '9:16'));
  assert.ok(ratios.filter(([k]) => k === 'product').every(([, r]) => r === '3:4' || r === '4:5'));
  const run = readRun(out, report.runId);
  const target = run.concepts.find(c => c.conceptSlug === 'they-think-we-sell').variations[0].targets.find(t => t.key.endsWith('meta-plate-take1-3x4.jpg'));
  assert.equal(target.comp, 'meta-final-take1-4x5.jpg');
  assert.equal(target.compTrusted, true);
});

test('one output ratio per run: every final the same pixel size, manifest placement is that ratio', async () => {
  for (const [ratio, size] of [['4:5', [1080, 1350]], ['1:1', [1080, 1080]]]) {
    const { out, deps: d } = deps();
    const sizes = [];
    d.renderLayout = async ({ width, height }) => { sizes.push([width, height]); return { buffer: JPEG, overflow: false }; };
    const report = await runAds({ args: parseArgs([...ARGS, '--ratio', ratio]), deps: d });
    assert.equal(report.results.length, 3, ratio);
    assert.ok(sizes.length >= 3 && sizes.every(s => s[0] === size[0] && s[1] === size[1]), `${ratio}: ${JSON.stringify(sizes)}`);
    const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
    assert.equal(manifest.placement.ratio, ratio);
    assert.ok(manifest.plates.every(p => p.ratio === ratio));
    assert.equal(runJson(out, report).ratio, ratio);
  }
});

test('--ratio 1:1 never selects a 4:5-only structure', async () => {
  const { out, deps: d } = deps();
  const report = await runAds({ args: parseArgs([...ARGS, '--ratio', '1:1', '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.ok(!plan.structures.some(s => ['they-think-we-sell', 'ours-vs-theirs-checklist'].includes(s.id)));
  assert.match(plan.ineligible.find(s => s.id === 'they-think-we-sell').reason, /does not support 1:1/);
});

test('a product-free plate takes one render when it passes; run.json cost counts fallback and product-free renders', async () => {
  // The split's product plate fails both primary takes, so its fallback renders too.
  const { out, deps: d, renders } = deps({ verify: (p) => !/bright airy bathroom/.test(p) });
  const report = await runAds({ args: parseArgs([...ARGS, '--structures', 'they-think-we-sell,comment-card-offer,product-group-plain']), deps: d });
  assert.equal(renders.filter(p => /cooking coconut oil/.test(p)).length, 1, 'generic plate: one render, it passed');
  assert.equal(renders.filter(p => /very large on a plain light surface, filling about 75%/.test(p)).length, 2, 'two fallback renders');
  assert.equal(renders.length, 1 + 4 + 2 + 2);
  assert.equal(runJson(out, report).cost.renders, renders.length);
});

test('a product-free plate that fails gets exactly one fallback render', async () => {
  const { deps: d, renders } = deps();
  d.strayText = async () => ({ ok: false, detail: 'a logo on the tub' });
  const report = await runAds({ args: parseArgs([...ARGS, '--structures', 'they-think-we-sell,comment-card-offer']), deps: d });
  assert.equal(renders.filter(p => /cooking (coconut oil|fat)/.test(p)).length, 2);
  assert.match(report.rejectedStructures.find(r => r.id === 'they-think-we-sell').reason, /stray-text.*a logo on the tub/);
});

test('quote pick: one retry on an unparseable reply, then the structure is planned', async () => {
  const { out, deps: d, prompts } = deps();
  let bad = true;
  const create = d.anthropic.messages.create;
  d.anthropic.messages.create = async (req) => {
    const t = req.messages[0].content;
    if (typeof t === 'string' && t.includes('Pick the ONE customer review') && bad) { bad = false; prompts.push(t); return reply('I pick the first one'); }
    return create(req);
  };
  const report = await runAds({ args: parseArgs([...ARGS, '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.equal(plan.structures.find(s => s.id === 'comment-card-offer').slots.quote, REVIEWS[0]);
  assert.equal(prompts.filter(p => p.includes('Pick the ONE customer review')).length, 2);
});

test('quote pick unparseable twice: the structure is skipped with the reason', async () => {
  const { out, deps: d } = deps();
  const create = d.anthropic.messages.create;
  d.anthropic.messages.create = async (req) => {
    const t = req.messages[0].content;
    if (typeof t === 'string' && t.includes('Pick the ONE customer review')) return reply('no idea');
    return create(req);
  };
  const report = await runAds({ args: parseArgs([...ARGS, '--dry-run']), deps: d });
  const plan = JSON.parse(readFileSync(join(out, report.runId, 'plan.json'), 'utf8'));
  assert.match(plan.skipped.find(s => s.id === 'comment-card-offer').reason, /quote pick/);
});
