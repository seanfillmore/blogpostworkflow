import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { learnRules, decide, planMoves, pulledBack, isSystemFolder } from '../../lib/inbox-sorter.js';
import { renderSummary } from '../../agents/inbox-sorter/index.js';

const filed = {
  Newsletters: [{ from: 'news@letter.com' }, { from: 'hi@letter.com' }, { from: 'writer@gmail.com' }],
  'Cold Pitches': [{ from: 'sarah@agency.com' }, { from: 'leah@agency.com' }, { from: 'mo@agency.com' }],
  'ShipTJS (3PL)': [{ from: 'john@3pl.com' }],
  Mixed: [{ from: 'a@split.com' }, { from: 'b@split.com' }],
  Other: [{ from: 'c@split.com' }, { from: 'd@split.com' }],
};
const ctx = { ownDomain: 'realskincare.com' };

test('importing the agent does not run it', () => assert.equal(typeof renderSummary, 'function'));

test('learns by address, and by domain only when one folder holds 90%+ of it', () => {
  const r = learnRules(filed);
  assert.equal(r.byAddress.get('john@3pl.com'), 'ShipTJS (3PL)');
  assert.equal(r.byDomain.get('agency.com'), 'Cold Pitches', 'a new rep at the agency is caught');
  assert.equal(r.byDomain.has('split.com'), false, 'a 50/50 domain is not a rule');
  assert.equal(r.byDomain.has('3pl.com'), false, 'one message is not enough for a domain rule');
});

test('a freemail domain never becomes a rule', () => {
  const r = learnRules({ Newsletters: [{ from: 'a@gmail.com' }, { from: 'b@gmail.com' }, { from: 'c@gmail.com' }] });
  assert.equal(r.byDomain.has('gmail.com'), false);
  assert.equal(decide({ from: 'creator@gmail.com' }, r, ctx), null);
  assert.equal(decide({ from: 'a@gmail.com' }, r, ctx).folder, 'Newsletters', 'the exact address still is');
});

test('never moves flagged, own-domain, kept or protected mail', () => {
  const r = learnRules(filed);
  assert.equal(decide({ from: 'news@letter.com', flagged: true }, r, ctx), null);
  assert.equal(decide({ from: 'support@realskincare.com', bulk: true }, r, ctx), null);
  assert.equal(decide({ from: 'news@letter.com' }, r, { ...ctx, keep: new Set(['news@letter.com']) }), null);
  assert.equal(decide({ from: 'news@letter.com' }, r, { ...ctx, protect: new Set(['news@letter.com']) }), null);
});

test('unknown bulk mail goes to Notifications; an unknown person stays', () => {
  const r = learnRules(filed);
  assert.deepEqual(decide({ from: 'promo@new.com', bulk: true }, r, ctx), { folder: 'Notifications', why: 'bulk mail' });
  assert.equal(decide({ from: 'person@new.com' }, r, ctx), null);
});

test('plan groups by folder; a filed message dragged back marks its sender kept', () => {
  const r = learnRules(filed);
  const plan = planMoves([{ from: 'news@letter.com', uid: 1 }, { from: 'tom@agency.com', uid: 2 }, { from: 'x@y.com', uid: 3 }], r, ctx);
  assert.deepEqual([...plan.keys()].sort(), ['Cold Pitches', 'Newsletters']);
  assert.deepEqual([...pulledBack([{ from: 'News@Letter.com', messageId: '<1>' }, { from: 'z@z.com', messageId: '<2>' }], new Set(['<1>']))], ['news@letter.com']);
});

test('system folders never teach rules', () => {
  for (const b of [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Sent Messages' }, { path: 'Trash' }, { path: 'Scheduled' }]) assert.ok(isSystemFolder(b), b.path);
  assert.equal(isSystemFolder({ path: 'Newsletters' }), false);
});

test('the agent never deletes or expunges (source scan)', () => {
  const src = readFileSync(new URL('../../agents/inbox-sorter/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /messageDelete|expunge|\\\\Deleted/);
});
