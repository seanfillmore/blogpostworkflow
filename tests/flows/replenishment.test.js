import { strict as assert } from 'node:assert';
import test from 'node:test';
import mod from '../../scripts/flows/flows/replenishment.js';
import { send, delay } from '../../scripts/flows/klaviyo-graph.js';

test('module shape: net-new flow with inline enrollment', () => {
  assert.equal(mod.oldFlowId, null);
  assert.equal(mod.entry, 'd1');
  assert.equal(mod.triggers[0].id, 'V69ueg');
  assert.ok(mod.profileFilter.condition_groups[0].conditions[0].metric_id === 'V69ueg');
  assert.ok(mod.emails.replenish_1 && mod.emails.replenish_2);
});

test('actions build the day-35 / day-50 two-email graph', () => {
  const msg = (key) => ({ subject: key, preview: '', template_id: 't-' + key, name: key });
  const acts = mod.actions(msg, { send, delay }, 'draft');
  assert.deepEqual(acts.map((a) => a.temporary_id), ['d1', 'e1', 'd2', 'e2']);
  assert.equal(acts[0].data.value, 35);
  assert.equal(acts[0].data.unit, 'days');
  assert.equal(acts[0].links.next, 'e1');
  assert.equal(acts[1].links.next, 'd2');
  assert.equal(acts[2].data.value, 15);
  assert.equal(acts[3].links.next, null);
});

test('Email 1: subscription-first, flexibility line, dynamic product, NO coupon', () => {
  const h = mod.emails.replenish_1.html;
  assert.match(h, /Subscribe & Save/);
  assert.match(h, /Skip, pause, swap scent, or cancel anytime/);
  assert.match(h, /event\.Items\|first/);
  assert.doesNotMatch(h, /RESTOCK10/);
  assert.doesNotMatch(h, /monthly/i);
});

test('Email 2: keeps subscription hero + RESTOCK10 fallback', () => {
  const h = mod.emails.replenish_2.html;
  assert.match(h, /Subscribe & Save/);
  assert.match(h, /RESTOCK10/);
  assert.match(h, /Skip, pause, swap scent, or cancel anytime/);
  assert.doesNotMatch(h, /monthly/i);
});
