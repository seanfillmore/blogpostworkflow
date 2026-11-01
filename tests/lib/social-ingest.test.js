import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMetaCopy, planBatch, suggestedCaptionProblems, writeCaption, ingestBatch, remoteQueue, slug,
} from '../../lib/social-ingest.js';
import { ID_RE } from '../../lib/social-queue.js';

const META = `# Cream listicle statics: Meta copy

Landing page: https://www.realskincare.com/pages/coconut-body-cream

## Primary texts

1. A popular drugstore coconut lotion lists 34 ingredients. Our Coconut Moisturizer starts from a 7-ingredient base you can read in one breath.

2. Used every night, one 4oz jar lasts about a month. Try it for 30 days.

## Headlines

1. 5 reasons people are switching
2. You can read the whole label
`;

const BATCH = '2026-10-19 Coconut Moisturizer - coconut-breeze';
function batchDir({ meta = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'social-ingest-'));
  const dir = join(root, BATCH);
  const c1 = join(dir, '01 5 reasons people are switching');
  mkdirSync(join(c1, '_rejected'), { recursive: true });
  for (const f of ['01-aurora-sky.png', '02-dark-slate.png']) writeFileSync(join(c1, f), 'png');
  const img = (file, sceneId, over = {}) => ({ scene: { id: sceneId, scene: `${sceneId} scene` }, ok: true, file: join(c1, file), notes: [], ...over });
  writeFileSync(join(dir, 'run.json'), JSON.stringify({
    product: { handle: 'coconut-moisturizer' },
    concepts: [{ headline: '5 reasons people are switching', subhead: 'to a body cream with a 7-ingredient base', images: [
      img('01-aurora-sky.png', 'aurora-sky'),
      img('02-dark-slate.png', 'dark-slate', { notes: ['hands in frame'] }),
      img('03-bad.png', 'bad', { ok: false, file: join(c1, '_rejected', '03-bad.png') }),
    ] }],
  }));
  if (meta) writeFileSync(join(dir, 'meta-copy.md'), META);
  return dir;
}

const GOOD = (n) => `${n} reasons people are switching to a body cream with a 7-ingredient base.\n\nRead them at the link in our bio.\n\n#realskincare #bodycream #coconutoil`;

test('parseMetaCopy reads the numbered primary texts and headlines', () => {
  const c = parseMetaCopy(META);
  assert.equal(c.primaryTexts.length, 2);
  assert.match(c.primaryTexts[0], /^A popular drugstore/);
  assert.deepEqual(c.headlines, ['5 reasons people are switching', 'You can read the whole label']);
});

test('planBatch: kept images only, with slug ids and source keys the migration also uses', () => {
  const dir = batchDir();
  const plan = planBatch(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')), dir);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].source, `${BATCH}/01 5 reasons people are switching/01-aurora-sky.png`);
  assert.equal(plan[0].id, '2026-10-19-coconut-moisturizer-coconut-breeze-c1-5-reasons-people-are-switching-aurora-sky');
  assert.ok(plan.every((p) => ID_RE.test(p.id)));
  assert.equal(plan[1].needs_human_review, true);
  assert.equal(plan[0].needs_human_review, false);
  const migrated = JSON.parse(readFileSync(new URL('../../scripts/social-queue-migrate-ig-statics.json', import.meta.url), 'utf8')).items;
  assert.ok(migrated.some((m) => m.source === plan[0].source), 'a migrated item is recognised by its source');
  assert.equal(slug('A  B--c!'), 'a-b-c');
});

test('suggestedCaptionProblems: ungrounded numbers and repeated openings are refused', () => {
  const src = 'starts from a 7-ingredient base. 5 reasons';
  assert.deepEqual(suggestedCaptionProblems(GOOD(5), { sourceText: src }), []);
  assert.ok(suggestedCaptionProblems(GOOD(9), { sourceText: src }).some((p) => /number 9/.test(p)));
  assert.ok(suggestedCaptionProblems(GOOD(5), { sourceText: src, prior: [GOOD(5).replace('Read', 'See')] }).some((p) => /opens with/.test(p)));
});

function stubModel(replies) {
  const prompts = [];
  return {
    prompts,
    messages: { create: async ({ messages, model }) => { prompts.push({ text: messages[0].content, model }); const t = replies.shift(); return { content: [{ type: 'text', text: t }], stop_reason: 'end_turn' }; } },
  };
}

test('writeCaption: one retry naming the problems, then empty with the reason', async () => {
  const copy = parseMetaCopy(META);
  const image = { headline: '5 reasons people are switching', subhead: 'to a body cream with a 7-ingredient base' };
  const fixed = stubModel(['Heals dry skin. Link in bio. #realskincare', GOOD(5)]);
  const r = await writeCaption({ anthropic: fixed, copy, image });
  assert.equal(r.caption, GOOD(5));
  assert.match(fixed.prompts[1].text, /refused for/);
  assert.match(fixed.prompts[0].text, /A popular drugstore coconut lotion/);
  const never = stubModel(['no cta #realskincare', 'still no cta #realskincare']);
  const r2 = await writeCaption({ anthropic: never, copy, image });
  assert.equal(r2.caption, '');
  assert.match(r2.reason, /link in bio/);
});

function stubRemote(known = { ids: [], sources: [] }) {
  const sent = [];
  return { sent, known: async () => known, ingest: async (items) => { sent.push(...items); return { ok: true, created: items.map((i) => i.id), skipped: [], invalid: [] }; } };
}

test('ingestBatch dry run: no model, no upload, skips what the server already holds', async () => {
  const dir = batchDir();
  const remote = stubRemote({ ids: [], sources: [`${BATCH}/01 5 reasons people are switching/01-aurora-sky.png`] });
  const s = await ingestBatch({ batchDir: dir, apply: false, deps: { remote, log: () => {} } });
  assert.equal(s.kept, 2);
  assert.deepEqual(s.already, ['2026-10-19-coconut-moisturizer-coconut-breeze-c1-5-reasons-people-are-switching-aurora-sky']);
  assert.deepEqual(s.wouldAdd, ['2026-10-19-coconut-moisturizer-coconut-breeze-c1-5-reasons-people-are-switching-dark-slate']);
  assert.equal(remote.sent.length, 0);
});

test('ingestBatch apply: captions, converts, uploads and posts each new image; a failed caption keeps the image', async () => {
  const dir = batchDir();
  const remote = stubRemote();
  const uploads = [];
  const deps = {
    remote, log: () => {},
    anthropic: stubModel([GOOD(5), 'bad', 'still bad']),
    toJpeg: async (file, id) => `/tmp/${id}.jpg`,
    upload: async (jpg) => { uploads.push(jpg); return { id: `gid://shopify/MediaImage/${uploads.length}`, url: `https://cdn.shopify.com/s/files/${uploads.length}.jpg` }; },
  };
  const s = await ingestBatch({ batchDir: dir, apply: true, deps });
  assert.equal(s.created.length, 2);
  assert.equal(uploads.length, 2);
  assert.equal(remote.sent[0].caption, GOOD(5));
  assert.equal(remote.sent[1].caption, '', 'never dropped, left for Sean to caption');
  assert.ok(remote.sent[1].suggested_caption_reason);
  assert.equal(remote.sent[1].needs_human_review, true);
  assert.ok(remote.sent.every((i) => !('status' in i)));
});

test('remoteQueue sends basic auth and refuses without credentials', async () => {
  assert.throws(() => remoteQueue({ user: '', pass: '' }), /DASHBOARD_USER/);
  const seen = [];
  const q = remoteQueue({ url: 'https://dash.example/', user: 'u', pass: 'p', fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true, known: { ids: ['a'], sources: [] } }) }; } });
  assert.deepEqual((await q.known()).ids, ['a']);
  assert.equal(seen[0].url, 'https://dash.example/api/social/items');
  assert.equal(seen[0].init.headers.authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
});

test('planBatch: two batches sharing a folder name and scene ids get different ids by headline', () => {
  const run = (headline) => ({ product: { handle: 'coconut-moisturizer' }, concepts: [{ headline, images: [{ ok: true, file: '/x/01-custom-01.png', scene: { id: 'custom-01' }, notes: [] }] }] });
  const a = planBatch(run('No Tricks in This Jar'), '/x');
  const b = planBatch(run('Sweater Weather Is Here'), '/x');
  assert.notEqual(a[0].id, b[0].id);
  assert.ok([a[0].id, b[0].id].every((id) => ID_RE.test(id)));
});
