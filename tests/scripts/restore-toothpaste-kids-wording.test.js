import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAN, ARTICLES, main } from '../../scripts/restore-toothpaste-kids-wording.mjs';
import { PLAN as REMEDIATION_PLAN, gateEntry } from '../../scripts/remediate-toothpaste-safety-claims.mjs';
import { decideEntry, occurrences } from '../../scripts/remediate-petrolatum-avoidance-claim.mjs';
import { checkCopyLength } from '../../lib/seo-copy-length.js';

// Operator ruling 2026-09-13: every RSC product is safe for kids. That wording is a brand fact.
const KIDS_WORDING = /safe (for kids|for children|if swallowed)|well-tolerated even by young children|\bYes\b/i;
const KIDS_SAFETY = /safe (for kids|for children|if swallowed)/i;
// The oral drug claims #881 removed alongside kids wording must never ride back in.
const ORAL_CLAIM = /remineraliz|enamel|gum health|cavit/i;

const quiet = () => {};

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
  const calls = { updateArticle: [], upsertMetafield: [] };
  const api = {
    getArticle: async (blogId, id) => ({ id, body_html: state.bodies[id] }),
    updateArticle: async (blogId, id, fields) => { calls.updateArticle.push(id); state.bodies[id] = fields.body_html; return {}; },
    getMetafields: async (resource, id) => (state.metafields[id] === undefined ? [] : [
      { namespace: 'global', key: 'description_tag', value: state.metafields[id], type: 'single_line_text_field' },
    ]),
    upsertMetafield: async (resource, id, ns, key, value) => { calls.upsertMetafield.push(id); state.metafields[id] = value; },
  };
  return { api, calls };
}

const tmpRoot = () => mkdtempSync(join(tmpdir(), 'toothpaste-kids-restore-'));

test('the plan is a fixed table with every field, unique ids and a known article', () => {
  const ids = new Set();
  for (const e of PLAN) {
    for (const k of ['id', 'reverses', 'handle', 'surface', 'before', 'after', 'reason', 'expectedOccurrences']) {
      assert.ok(e[k] !== undefined && e[k] !== '', `entry ${e.id} needs ${k}`);
    }
    assert.ok(!ids.has(e.id), `duplicate id ${e.id}`);
    ids.add(e.id);
    assert.ok(ARTICLES[e.handle], `${e.id}: ${e.handle} has no ARTICLES row`);
    assert.ok(['body', 'description_tag'].includes(e.surface));
  }
  assert.equal(PLAN.length, 15);
});

test('every AFTER restores kids wording and carries no oral drug claim', () => {
  for (const e of PLAN) {
    assert.match(e.after, KIDS_WORDING, `${e.id} AFTER should restore kids wording`);
    assert.doesNotMatch(e.after, ORAL_CLAIM, `${e.id} AFTER must not bring an oral claim back`);
    assert.doesNotMatch(e.before, KIDS_SAFETY, `${e.id} BEFORE should be the softened #881 wording`);
  }
});

test('every AFTER clears the editorial health gate, and the SERP description fits in 160', () => {
  for (const e of PLAN) assert.deepEqual(gateEntry(e), [], `${e.id} AFTER must be gate-clean`);
  for (const e of PLAN.filter((x) => x.surface === 'description_tag')) {
    assert.equal(checkCopyLength({ d: e.after }, { d: 'description' }).ok, true, `${e.id} AFTER over 160`);
  }
});

test('no BEFORE is a substring of its AFTER, so a second run reads as already-applied', () => {
  for (const e of PLAN) assert.equal(e.after.includes(e.before), false, `${e.id}: BEFORE sits inside AFTER`);
});

test('#881 can never soften the wording again: its plan holds none of these entries', () => {
  const ids = new Set(REMEDIATION_PLAN.map((e) => e.id));
  for (const e of PLAN) assert.equal(ids.has(e.reverses), false, `#881 still carries ${e.reverses}`);
  for (const e of REMEDIATION_PLAN) {
    assert.doesNotMatch(e.before, KIDS_SAFETY, `#881 entry ${e.id} would remove kids wording on a re-run`);
  }
});

test('the runner is #881\'s, imported rather than copied', () => {
  const src = readFileSync(new URL('../../scripts/restore-toothpaste-kids-wording.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ runPlan \} from '\.\/remediate-toothpaste-safety-claims\.mjs'/);
  assert.doesNotMatch(src, /function (decideEntry|decideMirror|occurrences)\b/);
});

test('entries on one article apply in sequence and are idempotent', () => {
  const { bodies } = syntheticState();
  for (const [handle, { articleId }] of Object.entries(ARTICLES)) {
    let body = bodies[articleId];
    const entries = PLAN.filter((x) => x.handle === handle && x.surface === 'body');
    for (const e of entries) {
      const d = decideEntry(e, body);
      assert.equal(d.action, 'apply', `${e.id}: ${d.why}`);
      body = d.next;
    }
    for (const e of entries) assert.equal(decideEntry(e, body).action, 'already-applied', `${e.id} not idempotent`);
  }
});

test('DRY RUN writes nothing', async () => {
  const state = syntheticState();
  const { api, calls } = stubShopify(state);
  await main({ shopify: api, argv: [], root: tmpRoot(), log: quiet });
  assert.equal(calls.updateArticle.length, 0);
  assert.equal(calls.upsertMetafield.length, 0);
});

test('--apply writes one update per article, the description, and the mirror; a second run writes nothing', async () => {
  const state = syntheticState();
  const { api, calls } = stubShopify(state);
  const root = tmpRoot();
  const handle = 'why-glycerin-free-toothpaste-matters';
  const mirrorDir = join(root, 'data', 'posts', handle);
  mkdirSync(mirrorDir, { recursive: true });
  writeFileSync(join(mirrorDir, 'content.html'), state.bodies[ARTICLES[handle].articleId]);

  const record = await main({ shopify: api, argv: ['--apply'], root, log: quiet });

  assert.equal(calls.updateArticle.length, Object.keys(ARTICLES).length);
  assert.equal(calls.upsertMetafield.length, 1);
  for (const e of PLAN) {
    const { articleId } = ARTICLES[e.handle];
    const value = e.surface === 'body' ? state.bodies[articleId] : state.metafields[articleId];
    assert.equal(occurrences(value, e.before), 0, `${e.id} BEFORE still live`);
    assert.ok(occurrences(value, e.after) > 0, `${e.id} AFTER missing`);
  }
  const mirror = readFileSync(join(mirrorDir, 'content.html'), 'utf8');
  for (const e of PLAN.filter((x) => x.handle === handle)) assert.ok(mirror.includes(e.after), `${e.id} not in mirror`);
  assert.ok(readdirSync(join(root, 'data', 'reports', 'toothpaste-kids-wording-restore')).some((f) => f.startsWith('run-')));
  assert.equal(record.applied, true);

  const second = stubShopify(state);
  await main({ shopify: second.api, argv: ['--apply'], root, log: quiet });
  assert.equal(second.calls.updateArticle.length, 0);
  assert.equal(second.calls.upsertMetafield.length, 0);
});
