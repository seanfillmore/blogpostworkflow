// tests/agents/ad-concepts-orchestrator.test.js
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runConcepts } from '../../agents/ad-concepts/index.js';
import { listRuns } from '../../agents/dashboard/lib/ad-studio-runs.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 9]);
const concept = (id, family, extra = {}) => ({ id, title: id, picture: `${id} picture`, anchor: 'a', twist: 't', family, productRole: 'r', sceneText: 'none', people: 'none', typeBand: 'top', awareness: 'problem', headlineIdea: 'One fat.', claims: [], ...extra });
const reply = (o) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o) }] });

function deps({ verifyOk = () => true, maxConcepts = 4, peopleOn = null, overlayGarbageOnce = false, critiqueFailures = 0, flexGarbage = false } = {}) {
  let critFails = critiqueFailures;
  let garbage = overlayGarbageOnce;
  const out = mkdtempSync(join(tmpdir(), 'adc-'));
  const concepts = [concept('a', 'scale-gag'), concept('b', 'genre-parody', peopleOn === 'b' ? { people: 'face' } : {}), concept('c', 'product-art'), concept('d', 'identity-comedy')].slice(0, maxConcepts);
  const queue = [];
  const anthropic = { messages: { create: async (req) => {
    const t = req.messages[0].content;
    const text = typeof t === 'string' ? t : '';
    if (text.includes('generating ad CONCEPTS')) return reply({ concepts });
    if (text.includes('You did NOT write them')) return reply({ scores: concepts.map((_, i) => ({ i, thumbStop: 5 - (i % 2), oneSecondRead: 4, productClarity: 4, renderability: 4, brandFit: 4 })) });
    if (text.includes('Write the SCENE description')) return reply('A bold kitchen scene.');
    if (text.includes('overlay type')) { if (garbage) { garbage = false; return reply('this is not json'); } }
    if (text.includes('overlay type')) return reply({ headline: 'One fat. Real soap.', sub: '', claims: [{ text: 'one fat', sourceId: 'pdp' }] });
    if (text.includes('AD-LEVEL copy') && flexGarbage) return reply('nope');
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
        product: { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap', unitCount: 1, labelStrings: ['real SKIN CARE'], badgeStrings: [], physicalDescription: 'bar', variant: 'nourishing-tea-tree', labelInk: null },
        catalogEntry: {}, brandKit: {}, pdpBody: 'One fat: organic virgin coconut oil.', persona: null, reviews: [],
        sourceIndex: { pdp: 'One fat: organic virgin coconut oil.' }, photoPaths: ['ref1.jpg'], photoDir: '/refs/coconut-soap', competitorNames: [], tactics: '',
      }),
      render: async () => JPEG,
      verifyImage: async () => ({ ok: verifyOk(), reasons: verifyOk() ? [] : ['bad'] }),
      typeset: async ({ buffer }) => ({ buffer, mediaType: 'image/jpeg', colour: '#000000', treatment: 'band', overflow: false, headlinePx: 80 }),
      critique: async () => (critFails-- > 0 ? { ok: false, score: 1, reasons: ['bad type'] } : { ok: true, score: 4, reasons: [] }),
      notify: async (n) => { queue.push(n); },
      archive: () => null,
      notifications: queue,
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
