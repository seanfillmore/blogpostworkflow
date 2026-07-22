import { strict as assert } from 'node:assert';
import test from 'node:test';
import { resolveEnrollment, isNetNew } from '../../scripts/flows/klaviyo-graph.js';

test('isNetNew: true only when both triggers and profileFilter are set', () => {
  assert.equal(isNetNew({ triggers: [{ id: 'X' }], profileFilter: { condition_groups: [] } }), true);
  assert.equal(isNetNew({ triggers: [{ id: 'X' }] }), false);
  assert.equal(isNetNew({ profileFilter: { condition_groups: [] } }), false);
  assert.equal(isNetNew({}), false);
});

test('resolveEnrollment: net-new module uses its own triggers/profileFilter', () => {
  const mod = { triggers: [{ type: 'metric', id: 'V69ueg', trigger_filter: null }], profileFilter: { condition_groups: [] } };
  const out = resolveEnrollment(mod, null);
  assert.equal(out.triggers[0].id, 'V69ueg');
  assert.deepEqual(out.profileFilter, { condition_groups: [] });
});

test('resolveEnrollment: legacy module clones from the old flow definition', () => {
  const mod = { oldFlowId: 'ABC123' };
  const oldDef = { triggers: [{ type: 'metric', id: 'X' }], profile_filter: { condition_groups: [{ a: 1 }] } };
  const out = resolveEnrollment(mod, oldDef);
  assert.equal(out.triggers[0].id, 'X');
  assert.deepEqual(out.profileFilter, { condition_groups: [{ a: 1 }] });
});

test('resolveEnrollment: throws when neither inline nor cloned enrollment is available', () => {
  assert.throws(() => resolveEnrollment({ name: 'z' }, null), /enrollment/);
});
