import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProspects } from '../../lib/press-prospects.js';

const row = (domain, over = {}) => ({
  domain, pitch_url: `https://${domain}/a`, top_url: `https://${domain}/top`,
  author: 'Jane Example', author_url: `https://${domain}/author/jane`, publication: `${domain} Pub`,
  author_rejected: null, stale_article: false, likely_store: false, enrich_fetch: 'ok',
  angle: 'angle', competitors: ['Brand A'], prompts: ['best lotion'], score: 10, ...over,
});
const prTargets = { pitch_targets: [
  row('noauthor.example', { author: null }),
  row('stale.example', { stale_article: true }),
  row('pitched.example'),
  row('good.example'),
] };
const linkGap = { opportunities: [
  { domain: 'nofollow.example', rank: 80, dofollow: false, competitors: ['X'], score: 5 },
  { domain: 'good.example', rank: 70, dofollow: true, competitors: ['X'], score: 5 },
  { domain: 'gap.example', rank: 60, dofollow: true, competitors: ['Y'], score: 4 },
] };
const contacts = [{
  id: 'p', name: 'Pat Pitched', status: 'active', domains: ['pitched.example'], channels: [],
  pitches: [{ date: '2026-09-24', outcome: 'sent' }],
}];
const base = { prTargets, linkGap, contacts, existingDrafts: [], today: '2026-10-04' };

test('good editorial first, then good link-gap', () => {
  const { prospects } = buildProspects({ ...base, want: 2 });
  assert.deepEqual(prospects.map((p) => p.key), ['pr-target:good.example', 'link-gap:gap.example']);
  assert.equal(prospects[0].person.name, 'Jane Example');
  assert.equal(prospects[1].person, null);
});

test('every drop has a reason', () => {
  const { skipped } = buildProspects({ ...base, want: 2 });
  const why = (d) => skipped.find((s) => s.domain === d)?.reason || '';
  assert.match(why('noauthor.example'), /no author/);
  assert.match(why('stale.example'), /stale/);
  assert.match(why('pitched.example'), /pitched/);
  assert.match(why('nofollow.example'), /nofollow/);
  assert.match(why('good.example') , /./);
  assert.ok(skipped.some((s) => s.domain === 'good.example' && /editorial/.test(s.reason)));
});

test('no padding when short', () => {
  assert.equal(buildProspects({ ...base, want: 5 }).prospects.length, 2);
});

test('pitch older than cooldown does not block', () => {
  const c = [{ ...contacts[0], pitches: [{ date: '2026-07-01', outcome: 'sent' }] }];
  const { prospects } = buildProspects({ ...base, contacts: c, want: 5 });
  assert.ok(prospects.some((p) => p.domain === 'pitched.example'));
});

test('existing pending/approved draft blocks; sent does not', () => {
  const d = (status, extra) => ({ id: 'd', status, target_url: 'https://www.good.example/x', ...extra });
  let r = buildProspects({ ...base, existingDrafts: [d('pending')], want: 5 });
  assert.ok(!r.prospects.some((p) => p.key === 'pr-target:good.example'));
  assert.ok(r.skipped.some((s) => s.domain === 'good.example' && /draft/.test(s.reason)));
  r = buildProspects({ ...base, existingDrafts: [{ status: 'approved', to: 'a@good.example' }], want: 5 });
  assert.ok(!r.prospects.some((p) => p.key === 'pr-target:good.example'));
  r = buildProspects({ ...base, existingDrafts: [d('sent')], want: 5 });
  assert.ok(r.prospects.some((p) => p.key === 'pr-target:good.example'));
});

test('a draft rejected inside the 60-day cooldown blocks its domain (spec §4)', () => {
  const rej = { id: 'd', status: 'rejected', target_url: 'https://www.good.example/x', created_at: '2026-09-01T14:20:00Z', rejected_at: '2026-09-02T10:00:00Z' };
  const r = buildProspects({ ...base, existingDrafts: [rej], want: 5 });
  assert.ok(!r.prospects.some((p) => p.key === 'pr-target:good.example'));
  assert.ok(r.skipped.some((s) => s.domain === 'good.example' && /rejected/.test(s.reason)));
  const gapRej = { ...rej, target_url: 'https://gap.example/' };
  const g = buildProspects({ ...base, existingDrafts: [gapRej], want: 5 });
  assert.ok(!g.prospects.some((p) => p.key === 'link-gap:gap.example'));
});

test('a draft rejected 61 days ago does not block', () => {
  const rej = { id: 'd', status: 'rejected', target_url: 'https://www.good.example/x', created_at: '2026-08-03T14:20:00Z', rejected_at: '2026-08-04T10:00:00Z' };
  const r = buildProspects({ ...base, existingDrafts: [rej], want: 5 });
  assert.ok(r.prospects.some((p) => p.key === 'pr-target:good.example'));
});

test('shortfall on one side is filled from the other; link-gap in book dropped', () => {
  const many = { opportunities: ['a', 'b', 'c', 'd'].map((x) => ({ domain: `${x}.example`, rank: 1, dofollow: true, competitors: [], score: 1 })) };
  const book = [{ id: 'q', name: 'Q', status: 'inactive', domains: ['a.example'], channels: [], pitches: [] }];
  const { prospects, skipped } = buildProspects({ ...base, linkGap: many, contacts: [...contacts, ...book], want: 4 });
  assert.equal(prospects.length, 4);
  assert.deepEqual(prospects.map((p) => p.source), ['pr-target', 'link-gap', 'link-gap', 'link-gap']);
  assert.ok(skipped.some((s) => s.domain === 'a.example' && /book/.test(s.reason)));
});

const left = (name, status, extra = {}) => ({ id: 'x', name, status, domains: ['good.example'], channels: [], pitches: [], ...extra });

test('matching-author contact who left blocks, naming contact and status', () => {
  const r = buildProspects({ ...base, contacts: [left('jane example', 'left_outlet')], want: 5 });
  assert.ok(!r.prospects.some((p) => p.domain === 'good.example'));
  assert.ok(r.skipped.some((s) => s.domain === 'good.example' && /jane example/.test(s.reason) && /left_outlet/.test(s.reason)));
});

test('do_not_contact outlet blocks any author on the domain', () => {
  const r = buildProspects({ ...base, contacts: [left('Desk', 'do_not_contact', { kind: 'outlet' })], want: 5 });
  assert.ok(!r.prospects.some((p) => p.domain === 'good.example'));
});

test('a different writer who left does not block', () => {
  const r = buildProspects({ ...base, contacts: [left('Someone Else', 'left_outlet'), left('Desk2', 'inactive', { kind: 'outlet' })], want: 5 });
  assert.ok(r.prospects.some((p) => p.key === 'pr-target:good.example'));
});

test('duplicate domains collapse to the first row', () => {
  const pt = { pitch_targets: [row('www.dup.example'), row('dup.example', { author: 'Other' })] };
  const lg = { opportunities: ['www.g.example', 'g.example'].map((d) => ({ domain: d, rank: 1, dofollow: true, competitors: [], score: 1 })) };
  const r = buildProspects({ ...base, prTargets: pt, linkGap: lg, want: 10 });
  assert.deepEqual(r.prospects.map((p) => p.key), ['pr-target:dup.example', 'link-gap:g.example']);
  assert.equal(r.skipped.filter((s) => s.reason === 'duplicate domain').length, 2);
});

test('excludeKeys drops dead prospects BEFORE truncation, so live ones still fill want', () => {
  const many = { pitch_targets: [row('dead1.example'), row('dead2.example'), row('live.example')] };
  const { prospects, skipped } = buildProspects({
    ...base, prTargets: many, linkGap: { opportunities: [] }, want: 1,
    excludeKeys: new Set(['pr-target:dead1.example', 'pr-target:dead2.example']),
  });
  assert.deepEqual(prospects.map((p) => p.key), ['pr-target:live.example']);
  assert.ok(skipped.some((s) => s.domain === 'dead1.example' && /failed attempts/.test(s.reason)));
});

test('excludeKeys applies to link-gap keys too', () => {
  const { prospects } = buildProspects({
    ...base, prTargets: { pitch_targets: [] }, want: 5, excludeKeys: new Set(['link-gap:gap.example']),
  });
  assert.deepEqual(prospects.map((p) => p.key), ['link-gap:good.example']);
});
