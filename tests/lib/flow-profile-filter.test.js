import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressesProperty } from '../../lib/flow-profile-filter.js';

const gvCondition = {
  type: 'profile-property',
  property: "properties['gv_entrant']",
  filter: { type: 'existence', operator: 'not-set' },
};
const metricCondition = {
  type: 'profile-metric',
  metric_id: 'V69ueg',
  measurement: 'count',
  measurement_filter: { type: 'numeric', operator: 'equals', value: 0 },
};

test('the real live Welcome Series shape counts as suppressed', () => {
  // Verbatim shape of V5fp5i on 2026-08-31: three metric groups, then gv_entrant alone.
  const definition = {
    profile_filter: {
      condition_groups: [
        { conditions: [metricCondition] },
        { conditions: [{ ...metricCondition, metric_id: 'VieVPL' }] },
        { conditions: [{ ...metricCondition, metric_id: 'Wfyj88' }] },
        { conditions: [gvCondition] },
      ],
    },
  };
  assert.deepEqual(suppressesProperty(definition, 'gv_entrant'), { suppressed: true });
});

test('a suppression sharing a group with another condition does NOT count', () => {
  // Klaviyo ORs within a group, so this gates nothing — a profile with no orders passes.
  const definition = {
    profile_filter: { condition_groups: [{ conditions: [metricCondition, gvCondition] }] },
  };
  const r = suppressesProperty(definition, 'gv_entrant');
  assert.equal(r.suppressed, false);
  assert.match(r.reason, /ORed/);
});

test('a flow with no profile_filter is not suppressed, and says so', () => {
  assert.deepEqual(suppressesProperty({}, 'gv_entrant'), {
    suppressed: false,
    reason: 'no profile_filter on this flow',
  });
  assert.equal(suppressesProperty(null, 'gv_entrant').suppressed, false);
});

test('a filter that gates a DIFFERENT property is not a pass', () => {
  const definition = {
    profile_filter: {
      condition_groups: [
        { conditions: [{ ...gvCondition, property: "properties['something_else']" }] },
      ],
    },
  };
  const r = suppressesProperty(definition, 'gv_entrant');
  assert.equal(r.suppressed, false);
  assert.match(r.reason, /no gv_entrant condition/);
});

test('an is-set condition is not a suppression — the operator matters', () => {
  const definition = {
    profile_filter: {
      condition_groups: [
        { conditions: [{ ...gvCondition, filter: { type: 'existence', operator: 'is-set' } }] },
      ],
    },
  };
  assert.equal(suppressesProperty(definition, 'gv_entrant').suppressed, false);
});
