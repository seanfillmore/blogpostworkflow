// tests/lib/post-edit-gate.test.js
//
// The SLS toothpaste page was changed nine times in three weeks by six writers
// and fell from #5 to #10. These pin the rule that stops that: one material
// change, then 28 days of measurement; winners are never rewritten; a freeze
// blocks all but compliance and repair; and a shadow post directory can only
// ever ADD protection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'edit-gate-'));
process.env.SEO_CLAUDE_ROOT = root;
const posts = join(root, 'data', 'posts');
const events = join(root, 'events');
const put = (slug, meta, state) => {
  mkdirSync(join(posts, slug), { recursive: true });
  writeFileSync(join(posts, slug, 'meta.json'), JSON.stringify(meta));
  if (state !== undefined) writeFileSync(join(posts, slug, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
};
const H = 'toothpaste-without-sls-what-to-know-best-options';
// The real shape: the locked post lives under a short slug and declares the handle;
// a shadow dir named for the handle declares nothing.
put('toothpaste-without-sls', { slug: 'toothpaste-without-sls' }, { shopify_handle: H, legacy_locked: true });
put(H, { title: 'SLS Free Toothpaste for Sensitive Mouths' }, {});
put('plain-post', { slug: 'plain-post' }, { shopify_handle: 'plain-post' });
put('broken-post', { slug: 'broken-post' }, '{ not json');

const gate = await import('../../lib/post-edit-gate.js');
const NOW = '2026-10-03T12:00:00.000Z';

test('compliance and repair are always allowed, even frozen, locked or unreadable', () => {
  for (const kind of ['compliance', 'repair']) {
    const d = gate.decideEdit(kind, { now: NOW, freeze: { until: '2027-01-01' }, locked: true, unreadable: true, lastMaterialAt: NOW });
    assert.equal(d.allowed, true, kind);
  }
});

test('a freeze blocks enhance, serp and rewrite until it expires, then lifts', () => {
  const freeze = { until: '2026-11-15T00:00:00.000Z', reason: 'recovering from 09-13 drop' };
  for (const kind of ['enhance', 'serp', 'rewrite']) {
    assert.equal(gate.decideEdit(kind, { now: NOW, freeze }).allowed, false, kind);
    assert.equal(gate.decideEdit(kind, { now: '2026-11-16T00:00:00.000Z', freeze }).allowed, true, `${kind} after expiry`);
  }
});

test('one material change, then 28 days: serp and rewrite wait, enhance does not', () => {
  const facts = { now: NOW, lastMaterialAt: '2026-09-21T15:00:00.000Z' };
  assert.equal(gate.decideEdit('serp', facts).allowed, false);
  assert.equal(gate.decideEdit('rewrite', facts).allowed, false);
  assert.equal(gate.decideEdit('enhance', facts).allowed, true);
  assert.match(gate.decideEdit('serp', facts).until, /^2026-10-19/);
  assert.equal(gate.decideEdit('serp', { now: '2026-10-20T00:00:00.000Z', lastMaterialAt: facts.lastMaterialAt }).allowed, true);
});

test('a locked winner is never rewritten, but its title may be tested', () => {
  assert.equal(gate.decideEdit('rewrite', { now: NOW, locked: true }).allowed, false);
  assert.equal(gate.decideEdit('serp', { now: NOW, locked: true }).allowed, true);
});

test('unknown kinds throw instead of defaulting', () => {
  assert.throws(() => gate.decideEdit('tweak', { now: NOW }));
});

test('a shadow dir named for the handle cannot hide the real post\'s lock (2026-09-13)', () => {
  const d = gate.mayEditLivePost(H, 'rewrite', { now: NOW, eventsDir: events });
  assert.equal(d.allowed, false);
  assert.match(d.reason, /locked winner/);
  assert.ok(d.slugs.includes('toothpaste-without-sls') && d.slugs.includes(H));
});

test('an unreadable state refuses serp and rewrite but allows repair', () => {
  assert.equal(gate.mayEditLivePost('broken-post', 'serp', { now: NOW, eventsDir: events }).allowed, false);
  assert.equal(gate.mayEditLivePost('broken-post', 'repair', { now: NOW, eventsDir: events }).allowed, true);
});

test('a title change logged by the diff detector starts the clock even from an ungated writer', () => {
  mkdirSync(join(events, '2026-09'), { recursive: true });
  writeFileSync(join(events, '2026-09', 'ch-2026-09-21-plain-post-title-ab12.json'),
    JSON.stringify({ changed_at: '2026-09-21T15:00:00.000Z', change_type: 'title' }));
  writeFileSync(join(events, '2026-09', 'ch-2026-09-30-plain-post-content_body-cd34.json'),
    JSON.stringify({ changed_at: '2026-09-30T15:00:00.000Z', change_type: 'content_body' }));
  assert.equal(gate.lastSerpEventAt('plain-post', events), '2026-09-21T15:00:00.000Z', 'body events (link repairs) do not count');
  assert.equal(gate.mayEditLivePost('plain-post', 'serp', { now: NOW, eventsDir: events }).allowed, false);
});

test('recordMaterialEdit stamps state.json (never the tracked meta.json) and starts the cooldown', () => {
  put('fresh-post', { slug: 'fresh-post' }, { shopify_handle: 'fresh-post' });
  assert.equal(gate.mayEditLivePost('fresh-post', 'rewrite', { now: NOW, eventsDir: events }).allowed, true);
  gate.recordMaterialEdit('fresh-post', 'rewrite', 'test', { now: NOW });
  const state = JSON.parse(readFileSync(join(posts, 'fresh-post', 'state.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(posts, 'fresh-post', 'meta.json'), 'utf8'));
  assert.equal(state.last_material_edit.source, 'test');
  assert.equal(meta.last_material_edit, undefined);
  assert.equal(gate.mayEditLivePost('fresh-post', 'serp', { now: NOW, eventsDir: events }).allowed, false);
  assert.deepEqual(gate.recordMaterialEdit('fresh-post', 'repair', 'test'), [], 'repairs do not start a cooldown');
});

test('a freeze follow-up is due only once the freeze has ended', () => {
  const metas = [
    ['a', { edit_freeze: { until: '2026-11-14T00:00:00.000Z', followup: 'consolidate explainers' } }],
    ['b', { edit_freeze: { until: '2026-09-01T00:00:00.000Z' } }],
    ['c', {}],
  ];
  assert.deepEqual(gate.freezeFollowupsDue(metas, '2026-11-13T00:00:00.000Z'), []);
  const due = gate.freezeFollowupsDue(metas, '2026-11-15T00:00:00.000Z');
  assert.equal(due.length, 1);
  assert.equal(due[0].slug, 'a');
});
