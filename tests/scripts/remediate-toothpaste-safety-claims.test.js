import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN, ARTICLES, MIRROR_FILES, decideMirror, gateEntry, main }
  from '../../scripts/remediate-toothpaste-safety-claims.mjs';
import { decideEntry, occurrences } from '../../scripts/remediate-petrolatum-avoidance-claim.mjs';
import { checkCopyLength } from '../../lib/seo-copy-length.js';

// The claim shapes this plan exists to remove. Every BEFORE carries one; no AFTER may.
// "cavit" is allowed in an AFTER only as advice to see a dentist ("cavity-prone").
const BEFORE_CLAIM = /safe (for kids|for children|if swallowed)|remineraliz|gum inflammation|cavit|young children|\byes\b/i;
const AFTER_CLAIM = /safe (for kids|for children|if swallowed)|remineraliz|gum inflammation|well-tolerated|\byes\b/i;

const quiet = () => {};

/** A body per article in which every BEFORE occurs exactly as declared. */
function syntheticState() {
  const bodies = {};
  const metafields = {};
  for (const [handle, { articleId }] of Object.entries(ARTICLES)) {
    bodies[articleId] = PLAN
      .filter((e) => e.handle === handle && e.surface === 'body')
      .map((e) => Array(e.expectedOccurrences).fill(`<div>${e.before}</div>`).join('\n'))
      .join('\n<hr>\n');
    const meta = PLAN.find((e) => e.handle === handle && e.surface === 'description_tag');
    if (meta) metafields[articleId] = meta.before;
  }
  return { bodies, metafields };
}

function stubShopify(state) {
  const calls = { getArticle: [], updateArticle: [], upsertMetafield: [] };
  const api = {
    getArticle: async (blogId, id) => { calls.getArticle.push(id); return { id, body_html: state.bodies[id] }; },
    updateArticle: async (blogId, id, fields) => { calls.updateArticle.push(id); state.bodies[id] = fields.body_html; return {}; },
    getMetafields: async (resource, id) => (state.metafields[id] === undefined ? [] : [
      { namespace: 'global', key: 'description_tag', value: state.metafields[id], type: 'single_line_text_field' },
    ]),
    upsertMetafield: async (resource, id, ns, key, value) => { calls.upsertMetafield.push(id); state.metafields[id] = value; },
  };
  return { api, calls };
}

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'toothpaste-claims-'));

test('the plan is a fixed table with every field, unique ids and a known article', () => {
  const ids = new Set();
  for (const e of PLAN) {
    for (const k of ['id', 'handle', 'surface', 'before', 'after', 'reason', 'expectedOccurrences']) {
      assert.ok(e[k] !== undefined && e[k] !== '', `entry ${e.id} needs ${k}`);
    }
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(ARTICLES[e.handle], `${e.id}: ${e.handle} has no ARTICLES row`);
    assert.ok(['body', 'description_tag'].includes(e.surface), `${e.id}: unknown surface`);
    assert.notEqual(e.before, e.after);
  }
});

test('every BEFORE carries the claim shape it removes, and no AFTER does', () => {
  for (const e of PLAN) {
    assert.match(e.before, BEFORE_CLAIM, `${e.id} BEFORE should carry a targeted claim`);
    assert.doesNotMatch(e.after, AFTER_CLAIM, `${e.id} AFTER still carries a claim`);
  }
});

test('every AFTER clears the editorial health gate, and SERP descriptions fit in 160', () => {
  for (const e of PLAN) assert.deepEqual(gateEntry(e), [], `${e.id} AFTER must be gate-clean`);
  for (const e of PLAN.filter((x) => x.surface === 'description_tag')) {
    assert.equal(checkCopyLength({ d: e.after }, { d: 'description' }).ok, true, `${e.id} AFTER over 160`);
  }
});

test('the mechanics are the petrolatum script\'s, imported — not a second copy', () => {
  const src = readFileSync(new URL('../../scripts/remediate-toothpaste-safety-claims.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ occurrences, decideEntry \} from '\.\/remediate-petrolatum-avoidance-claim\.mjs'/);
  assert.doesNotMatch(src, /export function (occurrences|decideEntry)\b/);
});

test('entries on one article apply in sequence to the synthetic body without interfering', () => {
  const { bodies } = syntheticState();
  for (const [handle, { articleId }] of Object.entries(ARTICLES)) {
    let body = bodies[articleId];
    for (const e of PLAN.filter((x) => x.handle === handle && x.surface === 'body')) {
      const d = decideEntry(e, body);
      assert.equal(d.action, 'apply', `${e.id}: ${d.why}`);
      body = d.next;
    }
    for (const e of PLAN.filter((x) => x.handle === handle && x.surface === 'body')) {
      assert.equal(occurrences(body, e.before), 0, `${e.id} BEFORE survived`);
      assert.equal(decideEntry(e, body).action, 'already-applied', `${e.id} not idempotent`);
    }
  }
});

test('a mirror is replaced wherever the BEFORE occurs, and reports what it does not carry', () => {
  const e = PLAN.find((x) => x.id === 'glycerin-formula-safe-for-kids');
  const d = decideMirror(e, `<p>${e.before}</p><p>${e.before}</p>`);
  assert.equal(d.action, 'apply');
  assert.equal(d.count, 2);
  assert.equal(occurrences(d.next, e.before), 0);
  assert.equal(decideMirror(e, d.next).action, 'already-applied');
  assert.equal(decideMirror(e, '<p>an older draft</p>').action, 'absent');
  assert.equal(decideMirror(e, undefined).action, 'no-file');
});

test('DRY RUN writes nothing to Shopify or to a mirror', async () => {
  const state = syntheticState();
  const { api, calls } = stubShopify(state);
  const root = tmpRoot();
  const glycerin = ARTICLES['why-glycerin-free-toothpaste-matters'].articleId;
  const mirrorDir = join(root, 'data', 'posts', 'why-glycerin-free-toothpaste-matters');
  mkdirSync(mirrorDir, { recursive: true });
  writeFileSync(join(mirrorDir, 'content.html'), state.bodies[glycerin]);

  await main({ shopify: api, argv: [], root, log: quiet });

  assert.equal(calls.updateArticle.length, 0);
  assert.equal(calls.upsertMetafield.length, 0);
  assert.equal(readFileSync(join(mirrorDir, 'content.html'), 'utf8'), state.bodies[glycerin]);
});

test('--apply writes one update per article, the metafields, and the mirrors — then is idempotent', async () => {
  const state = syntheticState();
  const { api, calls } = stubShopify(state);
  const root = tmpRoot();
  const glycerin = ARTICLES['why-glycerin-free-toothpaste-matters'].articleId;
  const mirrorDir = join(root, 'data', 'posts', 'why-glycerin-free-toothpaste-matters');
  mkdirSync(mirrorDir, { recursive: true });
  writeFileSync(join(mirrorDir, 'content.html'), state.bodies[glycerin]);
  const oneEntry = PLAN.find((x) => x.id === 'glycerin-formula-safe-for-kids');
  writeFileSync(join(mirrorDir, 'content-refreshed.html'), `<p>older refresh</p><p>${oneEntry.before}</p>`);

  await main({ shopify: api, argv: ['--apply'], root, log: quiet });

  assert.equal(calls.updateArticle.length, Object.keys(ARTICLES).length);
  assert.equal(calls.upsertMetafield.length, PLAN.filter((x) => x.surface === 'description_tag').length);
  for (const e of PLAN) {
    const { articleId } = ARTICLES[e.handle];
    const value = e.surface === 'body' ? state.bodies[articleId] : state.metafields[articleId];
    assert.equal(occurrences(value, e.before), 0, `${e.id} BEFORE still live`);
    assert.ok(occurrences(value, e.after) > 0, `${e.id} AFTER missing`);
  }
  const mirror = readFileSync(join(mirrorDir, 'content.html'), 'utf8');
  for (const e of PLAN.filter((x) => x.handle === 'why-glycerin-free-toothpaste-matters' && x.surface === 'body')) {
    assert.equal(occurrences(mirror, e.before), 0, `${e.id} survived in content.html`);
  }
  const refreshed = readFileSync(join(mirrorDir, 'content-refreshed.html'), 'utf8');
  assert.equal(occurrences(refreshed, oneEntry.before), 0);
  assert.match(refreshed, /older refresh/, 'unrelated mirror content is untouched');
  const backups = readdirSync(join(mirrorDir, 'backups'));
  assert.equal(backups.length, MIRROR_FILES.length, 'each changed mirror is backed up before writing');

  const second = stubShopify(state);
  await main({ shopify: second.api, argv: ['--apply'], root, log: quiet });
  assert.equal(second.calls.updateArticle.length, 0, 'second run must not write');
  assert.equal(second.calls.upsertMetafield.length, 0, 'second run must not write');
});

test('SKIPS a moved copy rather than overwriting it, and writes nothing for that article', async () => {
  const state = syntheticState();
  const { articleId } = ARTICLES['can-you-use-coconut-oil-as-toothpaste'];
  state.bodies[articleId] = '<li>Reduces plaque and inflammation of the gums</li>';
  const { api, calls } = stubShopify(state);
  const record = await main({ shopify: api, argv: ['--apply', '--slug', 'can-you-use-coconut-oil-as-toothpaste'], root: tmpRoot(), log: quiet });
  assert.equal(calls.updateArticle.length, 0);
  assert.equal(record.results[0].action, 'skip');
});

test('--slug limits the run to one article, and an unknown slug is refused', async () => {
  const { api, calls } = stubShopify(syntheticState());
  await main({ shopify: api, argv: ['--slug', 'why-glycerin-free-toothpaste-matters'], root: tmpRoot(), log: quiet });
  assert.deepEqual([...new Set(calls.getArticle)], [ARTICLES['why-glycerin-free-toothpaste-matters'].articleId]);
  await assert.rejects(
    () => main({ shopify: api, argv: ['--slug', 'not-a-post'], root: tmpRoot(), log: quiet }),
    /not in the plan/,
  );
});

test('a run record is written for every run', async () => {
  const root = tmpRoot();
  const { api } = stubShopify(syntheticState());
  await main({ shopify: api, argv: [], root, log: quiet });
  const dir = join(root, 'data', 'reports', 'toothpaste-claim-remediation');
  assert.ok(existsSync(dir));
  assert.equal(readdirSync(dir).filter((f) => f.startsWith('run-')).length, 1);
});
