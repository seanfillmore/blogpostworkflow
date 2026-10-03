// tests/agents/ad-concepts-orchestrator.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runConcepts } from '../../agents/ad-concepts/index.js';
import { listRuns } from '../../agents/dashboard/lib/ad-studio-runs.js';

// 12+ bytes: the orchestrator sniffs the real media type, and sniffImageMediaType needs 12.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const concept = (id, family, extra = {}) => ({ id, title: id, picture: `${id} picture`, anchor: 'a', twist: 't', family, productRole: 'r', sceneText: 'none', people: 'none', typeBand: 'top', awareness: 'problem', headlineIdea: 'One fat.', claims: [], ...extra });
const reply = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

function deps({ verifyOk = () => true, maxConcepts = 4, peopleOn = null, overlayGarbageOnce = false, critiqueFailures = 0, flexGarbage = false, conceptExtra = {}, productExtra = {}, flexCutOff = false, occlusion = null } = {}) {
  let critFails = critiqueFailures;
  let garbage = overlayGarbageOnce;
  const out = mkdtempSync(join(tmpdir(), 'adc-'));
  const concepts = [concept('a', 'scale-gag'), concept('b', 'genre-parody', peopleOn === 'b' ? { people: 'face' } : {}), concept('c', 'product-art'), concept('d', 'identity-comedy')].slice(0, maxConcepts)
    .map(c => ({ ...c, ...(conceptExtra[c.id] || {}) }));
  const prompts = [];
  const archived = [];
  const queue = [];
  const anthropic = { messages: { create: async (req) => {
    const t = req.messages[0].content;
    const text = typeof t === 'string' ? t : '';
    prompts.push(text);
    if (text.includes('generating ad CONCEPTS')) return reply({ concepts });
    if (text.includes('You did NOT write them')) return reply({ scores: concepts.map((_, i) => ({ i, thumbStop: 5 - (i % 2), oneSecondRead: 4, productClarity: 4, renderability: 4, brandFit: 4 })) });
    if (text.includes('Write the SCENE description')) return reply('A bold kitchen scene.');
    if (text.includes('overlay type')) { if (garbage) { garbage = false; return reply('this is not json'); } }
    if (text.includes('overlay type')) return reply({ headline: 'One fat. Real soap.', sub: '', claims: [{ text: 'one fat', sourceId: 'pdp' }] });
    if (text.includes('AD-LEVEL copy') && flexGarbage) return reply('nope');
    if (text.includes('AD-LEVEL copy') && flexCutOff) return { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"primaryTexts":["' }] };
    if (text.includes('AD-LEVEL copy')) return reply({ primaryTexts: ['One fat. Organic virgin coconut oil, turned into soap. That is the list.', 'Swap a long ingredient list for one fat. Coconut oil soap, small batches.'], headlines: ['One fat. Real soap.', 'Coconut oil soap'], claims: [{ text: 'one fat', sourceId: 'pdp' }] });
    throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
  } } };
  return {
    out,
    deps: {
      root: out, outRoot: out, now: () => new Date('2026-10-03T12:00:00Z'),
      models: { concept: 'm', judge: 'j', shot: 'm', copy: 'm' },
      anthropic,
      loadEvidence: async () => ({
        product: { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap', unitCount: 1, labelStrings: ['real SKIN CARE'], badgeStrings: [], physicalDescription: 'bar', variant: 'nourishing-tea-tree', labelInk: null, ...productExtra },
        catalogEntry: {}, brandKit: {}, pdpBody: 'One fat: organic virgin coconut oil.', persona: null, reviews: [],
        sourceIndex: { pdp: 'One fat: organic virgin coconut oil.' }, photoPaths: ['ref1.jpg'], photoDir: '/refs/coconut-soap', competitorNames: [], tactics: '',
      }),
      render: async () => JPEG,
      verifyImage: async () => ({ ok: verifyOk(), reasons: verifyOk() ? [] : ['bad'] }),
      typeset: async ({ buffer }) => ({ buffer, mediaType: 'image/jpeg', colour: '#000000', treatment: 'band', overflow: false, headlinePx: 80 }),
      critique: async () => (critFails-- > 0 ? { ok: false, score: 1, reasons: ['bad type'] } : { ok: true, score: 4, reasons: [] }),
      occlusion: occlusion || (async () => ({ ok: true, detail: '' })),
      notify: async (n) => { queue.push(n); },
      archive: (a) => { archived.push(a); },
      notifications: queue, prompts, archived,
    },
  };
}

test('parseArgs', () => {
  const a = parseArgs(['--product', 'coconut-soap', '--variant', 'nourishing-tea-tree', '--concept', 'a dog', '--concept', 'a crime scene', '--max-renders', '12', '--dry-run']);
  assert.deepEqual(a, { product: 'coconut-soap', variant: 'nourishing-tea-tree', concepts: ['a dog', 'a crime scene'], ratio: '4:5', maxRenders: 12, dryRun: true });
  assert.throws(() => parseArgs([]), /--product/);
  assert.throws(() => parseArgs(['--product', 'x', '--ratio', '9:16']), /ratio/);
});

test('end to end: a complete run folder, a 3-image manifest, and a run the dashboard lists', async () => {
  const { out, deps: d } = deps({ peopleOn: 'b' });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--variant', 'nourishing-tea-tree']), deps: d });
  const runDir = join(out, report.runId);
  assert.ok(existsSync(join(runDir, 'concepts.json')));
  assert.ok(existsSync(join(runDir, 'run.json')));
  const manifest = JSON.parse(readFileSync(join(runDir, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 3);
  assert.equal(manifest.short, false);
  const files = readdirSync(join(runDir, 'a', 'v1'));
  assert.ok(files.includes('meta-plate-take1-4x5.jpg') && files.includes('meta-final-take1-4x5.jpg'));
  assert.deepEqual(report.needsHumanReview, ['b']);
  assert.match(d.notifications[0].subject, /NEEDS HUMAN REVIEW/);
  assert.notEqual(d.notifications[0].immediate, true);
  const listed = listRuns(out);
  assert.ok(listed.some(r => r.runId === report.runId));
});

test('dry run stops after concepts with no render', async () => {
  const { out, deps: d } = deps();
  let renders = 0; d.render = async () => { renders++; return JPEG; };
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--dry-run']), deps: d });
  assert.equal(renders, 0);
  assert.ok(existsSync(join(out, report.runId, 'concepts.json')));
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false);
});

test('budget runs out mid-concept: run.json says so, manifest is short or absent', async () => {
  const { out, deps: d } = deps({ verifyOk: () => false });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--max-renders', '4']), deps: d });
  const run = JSON.parse(readFileSync(join(out, report.runId, 'run.json'), 'utf8'));
  assert.equal(run.budget.stopped, true);
  assert.ok(run.budget.skipped.length > 0);
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false, 'fewer than 2 finished concepts writes no manifest');
});
test('a malformed copy reply rejects that concept and it is replaced; the run does not crash', async () => {
  const { out, deps: d } = deps({ overlayGarbageOnce: true });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.ok(report.rejectedConcepts.some(r => /copy rejected/.test(r.error)));
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 3);
});

test('zero reference photos: rejects before any model or render call, naming the directory', async () => {
  const { deps: d } = deps();
  const base = d.loadEvidence;
  d.loadEvidence = async (a) => ({ ...(await base(a)), photoPaths: [] });
  let calls = 0; d.render = async () => { calls++; return JPEG; };
  const create = d.anthropic.messages.create; d.anthropic.messages.create = async (r) => { calls++; return create(r); };
  await assert.rejects(runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d }), /no reference photos under \/refs\/coconut-soap/);
  assert.equal(calls, 0);
});

test('fewer than 2 finals: manifestReason says so, notify body uses it', async () => {
  const { out, deps: d } = deps({ verifyOk: () => false });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--max-renders', '4']), deps: d });
  assert.match(report.manifestReason, /fewer than 2 concepts finished \(0\)/);
  assert.match(d.notifications[0].body, /fewer than 2 concepts finished/);
  assert.ok(report.rejectedConcepts.some(r => /no take passed verification/.test(r.error)));
  assert.equal(JSON.parse(readFileSync(join(out, report.runId, 'run.json'), 'utf8')).manifestReason, report.manifestReason);
});

test('flexible copy rejected: manifestReason names it, not "fewer than 2"', async () => {
  const { out, deps: d } = deps({ flexGarbage: true });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.match(report.manifestReason, /^flexible copy rejected: /);
  assert.doesNotMatch(d.notifications[0].body, /fewer than 2/);
  assert.equal(existsSync(join(out, report.runId, 'flexible-ad.json')), false);
});

test('a written manifest has manifestReason null', async () => {
  const { deps: d } = deps();
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.equal(report.manifestReason, null);
});

test('two finals: manifest is written with short: true', async () => {
  const { out, deps: d } = deps({ maxConcepts: 2 });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 2);
  assert.equal(manifest.short, true);
  assert.match(d.notifications[0].subject, /SHORT/);
});

test('critique failing on both treatments: concept is recorded and replaced', async () => {
  const { out, deps: d } = deps({ critiqueFailures: 6 });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.ok(report.rejectedConcepts.some(r => /typeset\/critique failed on both treatments/.test(r.error)));
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 3);
});

// ── final-review fixes ────────────────────────────────────────────────────────
import { buildEvidenceProduct, quotableEvidence } from '../../agents/ad-concepts/index.js';

const runJson = (out, report) => JSON.parse(readFileSync(join(out, report.runId, 'run.json'), 'utf8'));
const conceptsJson = (out, report) => JSON.parse(readFileSync(join(out, report.runId, 'concepts.json'), 'utf8'));

test('render #4 throws: run continues, verdict failed, takes written as they verify, run.json + archive', async () => {
  // Picked order is a, c, b (totals 21, 21, 20). Render #4 is concept c's first take.
  const { out, deps: d } = deps();
  let n = 0; d.render = async () => { if (++n === 4) throw new Error('gemini said no (400)'); return JPEG; };
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const run = runJson(out, report);
  assert.ok(run.rejectedConcepts.some(r => r.conceptSlug === 'c' && /^failed: gemini said no/.test(r.error)), JSON.stringify(run.rejectedConcepts));
  for (const k of [1, 2, 3]) assert.ok(existsSync(join(out, report.runId, 'a', 'v1', `meta-plate-take${k}-4x5.jpg`)));
  assert.equal(d.archived.length, 1);
  assert.equal(run.error, undefined);
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.deepEqual(manifest.plates.map(p => p.format).sort(), ['a', 'b', 'd'], 'the failed concept is replaced');
});

test('a throw mid-concept keeps the takes already verified for THAT concept on disk', async () => {
  const { out, deps: d } = deps();
  let n = 0; d.render = async () => { if (++n === 5) throw new Error('boom'); return JPEG; };
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.ok(existsSync(join(out, report.runId, 'c', 'v1', 'meta-plate-take1-4x5.jpg')));
  const proof = JSON.parse(readFileSync(join(out, report.runId, 'c', 'v1', 'proof.json'), 'utf8'));
  assert.ok(proof['meta-plate-take1-4x5.jpg']);
});

test('an unrecoverable error escapes: run.json carries error and archive runs before the rethrow', async () => {
  const { out, deps: d } = deps({ flexCutOff: true });
  let archivedBeforeReject = false;
  d.archive = (a) => { d.archived.push(a); archivedBeforeReject = true; };
  await assert.rejects(runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d }), /cut off/);
  assert.ok(archivedBeforeReject);
  const runId = readdirSync(out).find(f => f.startsWith('concepts-'));
  const run = JSON.parse(readFileSync(join(out, runId, 'run.json'), 'utf8'));
  assert.match(run.error, /cut off/);
  assert.equal(run.results.length, 3, 'the finished finals are still reported');
});

test('onStart hands over runDir before any paid call (main archives it on SIGINT/SIGTERM)', async () => {
  const { deps: d } = deps();
  const seen = [];
  const create = d.anthropic.messages.create;
  d.anthropic.messages.create = async (r) => { seen.push('model'); return create(r); };
  d.onStart = ({ runDir, runId }) => { seen.push(`start:${runId}`); assert.ok(existsSync(runDir)); };
  await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--dry-run']), deps: d });
  assert.match(seen[0], /^start:concepts-coconut-soap-/);
});

test('empty labelStrings: refuses before any model or render call', async () => {
  const { deps: d } = deps({ productExtra: { labelStrings: [] } });
  let calls = 0; d.render = async () => { calls++; return JPEG; };
  const create = d.anthropic.messages.create; d.anthropic.messages.create = async (r) => { calls++; return create(r); };
  await assert.rejects(runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d }), /labelStrings is empty/);
  assert.equal(calls, 0);
});

test('flexible copy sees the price and the on-image headline; the manifest carries the product URL', async () => {
  const { out, deps: d } = deps({ productExtra: { priceLabel: '$12', url: 'https://www.realskincare.com/products/coconut-soap' } });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const flexPrompt = d.prompts.find(p => p.includes('AD-LEVEL copy'));
  assert.match(flexPrompt, /\$12/);
  assert.match(flexPrompt, /on-image headline: "One fat\. Real soap\."/);
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.productUrl, 'https://www.realskincare.com/products/coconut-soap');
  assert.match(readFileSync(join(out, report.runId, 'flexible-ad.md'), 'utf8'), /realskincare\.com\/products\/coconut-soap/);
});

test('a replacement that shipped is labelled "picked (replacement)", not outscored', async () => {
  const { out, deps: d } = deps({ critiqueFailures: 6 });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const byId = Object.fromEntries(conceptsJson(out, report).concepts.map(c => [c.id, c.verdict]));
  assert.equal(byId.d, 'picked (replacement)');
});

test('no --concept: a stray requested:true from the model is forced false', async () => {
  const { out, deps: d } = deps({ conceptExtra: { d: { requested: true } } });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const cs = conceptsJson(out, report).concepts;
  assert.ok(cs.every(c => c.requested === false));
  assert.equal(cs.find(c => c.id === 'd').verdict, 'runner-up');
});

test('--concept asked for two, model returned one requested: requestedMissing in run.json and notify', async () => {
  const { out, deps: d } = deps({ conceptExtra: { d: { requested: true } } });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap', '--concept', 'a dog', '--concept', 'a crime scene']), deps: d });
  assert.equal(runJson(out, report).requestedMissing, 1);
  assert.match(d.notifications[0].body, /1 of 2 requested concept/);
});

test('needsHumanReview says verify checks nothing about anatomy, in run.json, notify and flexible-ad.md', async () => {
  const { out, deps: d } = deps({ peopleOn: 'b' });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.match(runJson(out, report).needsHumanReviewNote, /checks nothing about anatomy/);
  assert.match(d.notifications[0].body, /checks nothing about anatomy/);
  const md = readFileSync(join(out, report.runId, 'flexible-ad.md'), 'utf8');
  assert.match(md, /checks nothing about anatomy/);
  assert.match(md, /b\/v1\/meta-final-take\d-4x5\.jpg/);
});

test('a short run\'s flexible-ad.md matches its image count', async () => {
  const { out, deps: d } = deps({ maxConcepts: 2 });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const md = readFileSync(join(out, report.runId, 'flexible-ad.md'), 'utf8');
  assert.doesNotMatch(md, /all three/);
  assert.match(md, /SHORT/);
  assert.match(md, /add both images/);
});

test('buildEvidenceProduct carries priceLabel and url from the catalog entry', () => {
  const studio = { buildLabelStrings: () => ['real SKIN CARE'], resolveBadgeStrings: () => [] };
  const p = buildEvidenceProduct({ args: { product: 'coconut-soap', variant: null }, manifestEntry: { unitCount: 1 }, catalogEntry: { title: 'Soap', priceLabel: '$12', url: 'https://x/products/coconut-soap' }, studio });
  assert.equal(p.priceLabel, '$12');
  assert.equal(p.url, 'https://x/products/coconut-soap');
});

test('quotableEvidence withholds health-claim reviews from the prompts AND the citable source', () => {
  const r = quotableEvidence({ pdpBody: 'One fat.', brandKit: null, catalogEntry: null, reviews: ['Lathers beautifully.', 'It cured my eczema.'] });
  assert.deepEqual(r.reviews, ['Lathers beautifully.']);
  assert.doesNotMatch(r.sourceIndex.reviews, /eczema/);
});

// ── acceptance fix 2: occlusion check on the final ───────────────────────────

test('occlusion fails on both treatments: the concept gets no final and is replaced', async () => {
  const seen = [];
  // Only concept a is occluded, on BOTH treatments; every other concept passes.
  const { out, deps: d } = deps({ occlusion: async (o) => { seen.push(o); return o.conceptId === 'a' ? { ok: false, detail: 'the caption strip covers the top of the bar' } : { ok: true, detail: '' }; } });
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  const rej = report.rejectedConcepts.find(r => r.conceptSlug === 'a');
  assert.ok(rej, JSON.stringify(report.rejectedConcepts));
  assert.match(rej.error, /occlu|covers/i);
  assert.ok(!report.results.some(r => r.conceptSlug === 'a'));
  const manifest = JSON.parse(readFileSync(join(out, report.runId, 'flexible-ad.json'), 'utf8'));
  assert.equal(manifest.plates.length, 3);
  assert.ok(!manifest.plates.some(p => p.format === 'a'));
  const proof = JSON.parse(readFileSync(join(out, report.runId, 'a', 'v1', 'proof.json'), 'utf8'));
  assert.equal(proof['meta-plate-take1-4x5.jpg'].occlusion.ok, false);
  assert.match(proof['meta-plate-take1-4x5.jpg'].occlusion.detail, /caption strip/);
  assert.ok(seen.some(o => o.productDescription === 'bar' && o.band === 'top'), 'productDescription and band reach the check');
});

test('occlusion fails on band, passes on caption: the caption final is chosen and recorded', async () => {
  const typesets = [];
  const { out, deps: d } = deps({ occlusion: async (o) => (o.treatment === 'band' ? { ok: false, detail: 'headline over the lid' } : { ok: true, detail: '' }) });
  const base = d.typeset;
  d.typeset = async (o) => { typesets.push(o.treatment); return { ...(await base(o)), treatment: o.treatment }; };
  const report = await runConcepts({ args: parseArgs(['--product', 'coconut-soap']), deps: d });
  assert.equal(report.results.length, 3);
  assert.ok(typesets.includes('caption'));
  const proof = JSON.parse(readFileSync(join(out, report.runId, 'a', 'v1', 'proof.json'), 'utf8'));
  const p1 = proof['meta-plate-take1-4x5.jpg'];
  assert.equal(p1.treatment, 'caption');
  assert.equal(p1.occlusion.ok, true);
  assert.equal(p1.critique.ok, true);
  assert.deepEqual(p1.attempts.map(a => [a.treatment, a.occlusion?.ok]), [['band', false], ['caption', true]]);
});
