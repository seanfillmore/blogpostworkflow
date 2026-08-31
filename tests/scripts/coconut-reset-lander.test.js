import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PLAN, TEMPLATE_FIXES, classifyEntry, gatePlan, buildWrites, METAOBJECT_ID,
} from '../../scripts/build-coconut-reset-lander.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The lander's copy lives in a bundle_lander METAOBJECT, not the theme, so a
// change here is live the instant it is written — there is no unpublished copy
// to preview. That is why it ships as a reviewed plan rather than an edit.

test('every AFTER clears the health-claim gate', () => {
  const r = gatePlan();
  assert.equal(r.ok, true, JSON.stringify(r.failures));
});

test('every entry declares a kind, and only the two allowed ones', () => {
  // 'correctness' (the page states something untrue) and 'positioning' (a
  // judgement) must not blur: a positioning rewrite riding along under the
  // authority of a factual fix is how copy changes nobody agreed to get shipped.
  for (const e of PLAN) {
    assert.ok(['correctness', 'positioning'].includes(e.kind), `${e.id} has kind "${e.kind}"`);
    assert.ok(e.reason && e.reason.length > 40, `${e.id} needs a written reason`);
  }
});

test('the cream-count fix is classified as correctness, not positioning', () => {
  const e = PLAN.find((x) => x.id === 'tabs-whats-inside-cream-count');
  assert.equal(e.kind, 'correctness');
  assert.match(e.before, /1 Body Cream/);
  assert.match(e.after, /3 Body Creams/);
});

test('no BEFORE and AFTER are equal — a no-op entry is a plan that lies', () => {
  for (const e of [...PLAN, ...TEMPLATE_FIXES]) {
    assert.notEqual(e.before, e.after, `${e.id} changes nothing`);
  }
});

test('classifyEntry drives the drift guard in all three directions', () => {
  const e = { before: 'holds 1 cream', after: 'holds 3 creams' };
  assert.equal(classifyEntry('the box holds 1 cream today', e), 'apply');
  assert.equal(classifyEntry('the box holds 3 creams today', e), 'already-applied');
  // Neither present: somebody edited this in the admin. Never overwrite it.
  assert.equal(classifyEntry('the box holds two creams', e), 'skip-drift');
});

test('the template fallback BEFORE really is in the committed file', () => {
  // Pins the fallback to reality: if the template is re-pulled and the string
  // moves, this fails rather than the plan silently matching nothing.
  const src = readFileSync(join(ROOT, TEMPLATE_FIXES[0].file), 'utf8');
  const hit = src.includes(TEMPLATE_FIXES[0].before) || src.includes(TEMPLATE_FIXES[0].after);
  assert.ok(hit, 'template must carry either the BEFORE or the AFTER, never a third value');
});

test('the metaobject id is pinned, not discovered at runtime', () => {
  // Resolving "the lander metaobject" by search could pick another bundle's.
  assert.match(METAOBJECT_ID, /^gid:\/\/shopify\/Metaobject\/\d+$/);
});

// Two PLAN entries can target the SAME metaobject field — the buy box has four
// bullets in one `buybox_bullets` value, and bullets 2 and 4 were replaced
// independently. Building one write per ENTRY sent two inputs with the same key,
// which Shopify rejects outright ("Field ... duplicates other inputs"). Even if it
// had accepted them, each was computed from the ORIGINAL live value, so the second
// would have silently discarded the first.
test('entries sharing a field coalesce into ONE write carrying both edits', () => {
  const fields = { bullets: { value: 'one\ntwo\nthree\nfour' } };
  const plan = [
    { id: 'b', field: 'bullets', before: 'two', after: 'SECOND' },
    { id: 'd', field: 'bullets', before: 'four', after: 'FOURTH' },
  ];
  const writes = buildWrites(fields, plan);
  assert.equal(writes.length, 1, 'one write per FIELD, not per entry');
  assert.equal(writes[0].key, 'bullets');
  assert.equal(writes[0].value, 'one\nSECOND\nthree\nFOURTH', 'the second edit builds on the first');
});

test('a field whose entries are ALL already applied produces no write at all', () => {
  const fields = { bullets: { value: 'one\nSECOND\nthree\nFOURTH' } };
  const plan = [
    { id: 'b', field: 'bullets', before: 'two', after: 'SECOND' },
    { id: 'd', field: 'bullets', before: 'four', after: 'FOURTH' },
  ];
  assert.deepEqual(buildWrites(fields, plan), [], 'a re-run must be a no-op, not a rewrite');
});

// classifyEntry decides "already applied" by looking for the BEFORE string. If a
// BEFORE is a substring of its own AFTER, that test can never come back false: the
// entry re-applies on every run, compounding (a 'B' -> 'BEE' rewrite becomes
// 'BEEEE' on the second pass). Found by writing exactly that as a test fixture.
test('no plan entry has a BEFORE contained in its own AFTER', () => {
  for (const e of [...PLAN, ...TEMPLATE_FIXES]) {
    assert.ok(!e.after.includes(e.before), `${e.id}: BEFORE inside AFTER can never read as applied`);
  }
});
