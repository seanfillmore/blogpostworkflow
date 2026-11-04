import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, backlog } from '../../agents/social-organic/index.js';
import { newItem } from '../../lib/social-queue.js';

const CONFIG = { backlogPerKind: 1, maxPerRun: 3, seeds: ['What happens when you switch deodorant?'], categoryFacts: [] };
const FACTS = '- Body Lotion: 94 customer reviews averaging 4.9 stars';
const CAPTION = 'Soft hands all winter.\nWhat keeps yours soft?\nLink in bio.\n#realskincare #winterskin';
const REVIEW = { id: 7, rating: 5, reviewer_name: 'Amanda Kohl', body: 'This lotion soaks in fast and my hands stay soft through the whole workday, even in winter.', product_handle: 'coconut-lotion', published: true, hidden: false, verified: true };

// A model that answers by what the prompt asks for.
const client = (over = {}) => ({ calls: 0, messages: { async create({ messages }) {
  this.calls = (this.calls || 0) + 1;
  const p = messages[0].content;
  let out;
  if (/carousel/.test(p)) out = over.carousel || { slides: [1, 2, 3, 4, 5].map((n) => ({ title: ['Cover', 'First', 'Second', 'Third', 'Last'][n - 1], body: n > 1 ? 'A useful line.' : '' })), caption: CAPTION };
  else if (/quote card/.test(p)) out = over.review || { fits: true, caption: CAPTION };
  else out = over.relatable || { text: 'Winter hands feel every knuckle.', caption: CAPTION };
  return { content: [{ text: JSON.stringify(typeof out === 'function' ? out() : out) }] };
} } });

const deps = (saved) => ({
  render: async () => ({ buffer: Buffer.from('jpg'), overflow: false }),
  upload: async (_b, name) => ({ url: `https://cdn.shopify.com/s/files/${name}`, id: 'gid' }),
  save: (item) => saved.push(item),
});

test('runOnce --apply: drafts one of each kind PENDING, a carousel with every slide', async () => {
  const saved = [];
  const run = await runOnce({ apply: true, client: client(), config: CONFIG, items: [], reviews: [REVIEW], products: { 'coconut-lotion': 'Body Lotion' }, facts: FACTS, competitors: [], ...deps(saved), log: () => {} });
  assert.deepEqual(saved.map((i) => i.kind), ['carousel', 'review', 'relatable']);
  assert.ok(saved.every((i) => i.status === 'pending'));
  assert.equal(saved[0].images.length, 5);
  assert.equal(saved[0].topic, 'What happens when you switch deodorant?');
  assert.equal(saved[1].review_name, 'Amanda K.');
  assert.equal(saved[1].needs_human_review, true);
  assert.equal(run.skipped.length, 0);
});

test('runOnce: a full backlog drafts nothing; the dry run saves nothing', async () => {
  const items = ['carousel', 'review', 'relatable'].map((kind, n) => newItem({ id: `organic-${kind}-x${n}`, kind, image_url: 'https://cdn.shopify.com/a.jpg', ...(kind === 'carousel' ? { images: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'] } : {}) }));
  assert.deepEqual(backlog(items), { carousel: 1, review: 1, relatable: 1 });
  const saved = [];
  const run = await runOnce({ apply: true, client: client(), config: CONFIG, items, reviews: [REVIEW], facts: FACTS, ...deps(saved) });
  assert.equal(run.plan.length, 0);
  const dry = await runOnce({ apply: false, client: client(), config: CONFIG, items: [], reviews: [REVIEW], products: { 'coconut-lotion': 'Body Lotion' }, facts: FACTS, ...deps(saved), log: () => {} });
  assert.equal(saved.length, 0);
  assert.equal(dry.saved.length, 3);
});

test('runOnce: a draft that fails its gate twice is skipped and named, never saved', async () => {
  const saved = [];
  const bad = { text: 'This lotion heals eczema.', caption: CAPTION };
  const run = await runOnce({ apply: true, onlyKind: 'relatable', client: client({ relatable: bad }), config: CONFIG, items: [], facts: FACTS, ...deps(saved), log: () => {} });
  assert.equal(saved.length, 0);
  assert.match(run.skipped[0].reason, /claim/);
});

test('runOnce: a review that does not fit its product is passed over for the next one', async () => {
  const saved = [];
  const answers = [{ fits: false, caption: CAPTION }, { fits: true, caption: CAPTION }];
  const second = { ...REVIEW, id: 8, reviewer_name: 'Beth Lane' };
  const run = await runOnce({ apply: true, onlyKind: 'review', client: client({ review: () => answers.shift() }), config: CONFIG, items: [], reviews: [REVIEW, second], products: { 'coconut-lotion': 'Body Lotion' }, facts: FACTS, ...deps(saved), log: () => {} });
  assert.equal(saved.length, 1);
  assert.match(run.skipped[0].reason, /does not fit/);
});

test('pickTopic: seeds go first in order; otherwise the model picks from the shortlist and the rest stay', async () => {
  const { pickTopic } = await import('../../agents/social-organic/index.js');
  const seedFirst = [{ topic: 'Seed', source: 'seed' }, { topic: 'q1', source: 'search' }];
  assert.equal((await pickTopic({ client: null, topics: seedFirst })).topic, 'Seed');
  const topics = [{ topic: 'how to clean body lotion', source: 'search' }, { topic: 'is sls free toothpaste better', source: 'search' }];
  const c = { messages: { create: async () => ({ content: [{ text: '{"pick": 2}' }] }) } };
  assert.equal((await pickTopic({ client: c, topics })).topic, 'is sls free toothpaste better');
  assert.deepEqual(topics.map((t) => t.topic), ['how to clean body lotion'], 'the unpicked topic stays available');
  const broken = { messages: { create: async () => { throw new Error('down'); } } };
  assert.equal((await pickTopic({ client: broken, topics })).topic, 'how to clean body lotion', 'a model failure falls back to the first');
});

test('runOnce: a review implying a result on the body is passed over with the reason', async () => {
  const saved = [];
  const answers = [{ fits: false, why: 'implies a change in her teeth', caption: CAPTION }, { fits: true, caption: CAPTION }];
  const second = { ...REVIEW, id: 9, reviewer_name: 'Cara Diaz' };
  const run = await runOnce({ apply: true, onlyKind: 'review', client: client({ review: () => answers.shift() }), config: CONFIG, items: [], reviews: [REVIEW, second], products: { 'coconut-lotion': 'Body Lotion' }, facts: FACTS, ...deps(saved), log: () => {} });
  assert.equal(saved.length, 1);
  assert.match(run.skipped[0].reason, /implies a change in her teeth/);
});

test('runOnce: a new draft never reuses an existing item id (a same-day rerun once overwrote an approved card)', async () => {
  const saved = [];
  const now = Date.parse('2026-11-04T18:04:00Z');
  const first = await runOnce({ apply: true, onlyKind: 'review', client: client(), config: CONFIG, items: [], reviews: [REVIEW], products: { 'coconut-lotion': 'Body Lotion' }, facts: FACTS, ...deps(saved), now, log: () => {} });
  const existing = [...saved];
  const again = { ...REVIEW, id: 99 };
  await runOnce({ apply: true, onlyKind: 'review', client: client(), config: { ...CONFIG, backlogPerKind: 2 }, items: existing, reviews: [again], products: { 'coconut-lotion': 'Body Lotion' }, facts: FACTS, ...deps(saved), now, log: () => {} });
  assert.equal(first.saved.length, 1);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].id, saved[1].id);
  assert.match(saved[1].id, /-1804-1-amanda-k-2$/);
});
