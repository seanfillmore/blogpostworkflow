import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherGrowthInputs, generateGrowthRecs, growthRecProblems } from '../../lib/growth-recs.js';

const inputs = { aov_trailing_90d: 50.39, quick_wins: { rows: [{ page: '/p', impressions: 4200, ctr: 0.5 }] }, missing: [] };
const good = (move, ev = 'The page has 4,200 impressions at 0.5% CTR.') =>
  ({ move, evidence: ev, dollars_low: 50, dollars_high: 150, status: 'needs-decision' });
const fake = (...replies) => {
  let i = 0; const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); const r = replies[Math.min(i++, replies.length - 1)]; return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }], stop_reason: 'end_turn' }; } } };
};

test('invented number in evidence is dropped and named', async () => {
  const bad = good('Rewrite title', 'It gets 9,999 impressions.');
  const c = fake([bad, good('A'), good('B')], [bad, good('A'), good('B')]);
  const r = await generateGrowthRecs({ inputs, client: c });
  assert.equal(r.recs.length, 2);
  assert.match(r.dropped[0].reason, /9,999/);
  assert.match(c.calls[1].messages[0].content, /9,999/);
});

test('claim gate drops "heals eczema"', () => {
  const p = growthRecProblems(good('Say our lotion heals eczema'), JSON.stringify(inputs));
  assert.ok(p.some((x) => /claim gate/.test(x)));
});

test('em dash and bad dollars are problems', () => {
  const t = JSON.stringify(inputs);
  assert.ok(growthRecProblems(good('Do x — now'), t).some((x) => /em dash/.test(x)));
  assert.ok(growthRecProblems({ ...good('x'), dollars_low: 9, dollars_high: 1 }, t).length);
});

test('malformed reply retries once then returns empty with reason', async () => {
  const c = fake('not json');
  const r = await generateGrowthRecs({ inputs, client: c });
  assert.equal(c.calls.length, 2);
  assert.deepEqual(r.recs, []);
  assert.match(r.reason, /JSON/);
});

test('valid recs pass, fewer than 2 survivors returns empty', async () => {
  const ok = await generateGrowthRecs({ inputs, client: fake([good('A'), good('B'), good('C')]) });
  assert.equal(ok.recs.length, 3);
  const bad = good('Z', 'It gets 777 clicks.');
  const few = await generateGrowthRecs({ inputs, client: fake([bad, good('A')]) });
  assert.deepEqual(few.recs, []);
  assert.ok(few.reason);
});

test('gatherGrowthInputs lists stale and missing sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'growth-'));
  mkdirSync(join(root, 'data/reports/quick-wins'), { recursive: true });
  mkdirSync(join(root, 'data/reports/gsc-opportunity'), { recursive: true });
  writeFileSync(join(root, 'data/reports/quick-wins/latest.json'), JSON.stringify({ generated_at: '2020-01-01T00:00:00Z', rows: [] }));
  writeFileSync(join(root, 'data/reports/gsc-opportunity/latest.json'), JSON.stringify({ generated_at: new Date().toISOString(), rows: [1] }));
  const i = gatherGrowthInputs(root);
  assert.ok(i.gsc_opportunity);
  assert.equal(i.quick_wins, undefined);
  const m = Object.fromEntries(i.missing.map((x) => [x.source, x.reason]));
  assert.match(m.quick_wins, /stale/);
  assert.equal(m.seo_impact || m['seo-impact'], 'missing');
  assert.equal(m.ctr_program, 'missing');
  assert.equal(m.commercial_cvr, 'not computed');
});
