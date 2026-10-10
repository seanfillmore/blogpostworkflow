import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN, ARTICLES, main } from '../../scripts/remediate-coconut-toothpaste-article-claims.mjs';
import { gateEntry } from '../../scripts/remediate-toothpaste-safety-claims.mjs';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOTHPASTE = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8')).toothpaste;
const HANDLE = 'can-you-use-coconut-oil-as-toothpaste';
const plain = (h) => h.replace(/<[^>]+>/g, ' ');
const quiet = () => {};

test('one live post, the one the toothpaste remediation already knows', () => {
  assert.deepEqual(Object.keys(ARTICLES), [HANDLE]);
  assert.equal(ARTICLES[HANDLE].articleId, 561115168938);
  for (const e of PLAN) assert.equal(e.handle, HANDLE);
});

test('every AFTER passes the editorial gate the runner enforces', () => {
  for (const e of PLAN) assert.deepEqual(gateEntry(e), [], e.id);
});

test('every BEFORE carried a claim, and no AFTER makes one even on the strict commercial surface', () => {
  for (const e of PLAN) {
    assert.ok(/antibacterial|cavit|gum health/i.test(plain(e.before)), `${e.id}: precondition`);
    const g = checkSeoCopyFields({ body: plain(e.after) });
    assert.equal(g.ok, true, `${e.id}: ${JSON.stringify(g.blocking)}`);
    assert.doesNotMatch(e.after, /cavity-fighting|antibacterial|lowers your risk|gum health/i, e.id);
  }
});

test('no AFTER names an ingredient our toothpaste does not contain', () => {
  const ours = [...TOOTHPASTE.base_ingredients, ...TOOTHPASTE.variations.flatMap((v) => v.essential_oils)].join(' ').toLowerCase();
  assert.doesNotMatch(ours, /xylitol/, 'precondition: no xylitol in the formula');
  for (const e of PLAN) {
    assert.doesNotMatch(e.after, /xylitol|calcium|hydroxyapatite(?! are)/i, e.id);
    for (const named of ['coconut oil', 'baking soda', 'myrrh', 'stevia']) {
      if (e.after.includes(named)) assert.ok(ours.includes(named), `${e.id} names ${named}`);
    }
  }
});

test('house copy rules: no em dashes in new copy, AFTER differs and never contains its BEFORE', () => {
  for (const e of PLAN) {
    assert.doesNotMatch(e.after, /—/, e.id);
    assert.notEqual(e.after, e.before);
    assert.ok(!e.after.includes(e.before), e.id);
  }
});

function stub(body) {
  const calls = { updateArticle: 0 };
  const state = { body };
  const api = {
    getArticle: async () => ({ body_html: state.body }),
    updateArticle: async (_b, _i, f) => { calls.updateArticle += 1; state.body = f.body_html; return {}; },
  };
  return { api, calls, state };
}
const liveLike = () => PLAN.map((e) => `<p>${e.before}</p>`).join('\n');

test('dry run writes nothing; --apply writes once, verifies, updates the mirror, and is idempotent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'coconut-tp-'));
  mkdirSync(join(root, 'data', 'posts', HANDLE), { recursive: true });
  writeFileSync(join(root, 'data', 'posts', HANDLE, 'content.html'), liveLike());

  const dry = stub(liveLike());
  await main({ shopify: dry.api, argv: [], root, log: quiet });
  assert.equal(dry.calls.updateArticle, 0);

  const wet = stub(liveLike());
  await main({ shopify: wet.api, argv: ['--apply'], root, log: quiet });
  assert.equal(wet.calls.updateArticle, 1);
  for (const e of PLAN) {
    assert.ok(wet.state.body.includes(e.after), e.id);
    assert.ok(!wet.state.body.includes(e.before), e.id);
  }
  const mirror = readFileSync(join(root, 'data', 'posts', HANDLE, 'content.html'), 'utf8');
  for (const e of PLAN) assert.ok(mirror.includes(e.after), `mirror ${e.id}`);

  const again = stub(wet.state.body);
  await main({ shopify: again.api, argv: ['--apply'], root, log: quiet });
  assert.equal(again.calls.updateArticle, 0, 'second run must not write');
});

test('a body edited since the plan was written is skipped, not overwritten', async () => {
  const edited = liveLike().replace(PLAN[0].before, 'somebody rewrote this CTA by hand');
  const s = stub(edited);
  await main({ shopify: s.api, argv: ['--apply'], root: mkdtempSync(join(tmpdir(), 'coconut-tp-')), log: quiet });
  assert.ok(s.state.body.includes('somebody rewrote this CTA by hand'));
  assert.ok(!s.state.body.includes(PLAN[0].after));
});
