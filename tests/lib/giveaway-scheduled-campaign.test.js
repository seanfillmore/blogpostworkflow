// tests/lib/giveaway-scheduled-campaign.test.js
//
// The failure this guards is a campaign reverted to Draft and never requeued: it
// simply never sends, at its scheduled time, with nothing erroring. For the
// giveaway consolation sequence that is the whole revenue event of the campaign.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { reviseScheduledCampaign } from '../../lib/giveaway/scheduled-campaign.js';

const SEND = '2026-09-19T22:00:00+00:00';

/** A fake Klaviyo that tracks status the way the real one transitions it. */
function fakeKlaviyo({ status = 'Scheduled', failEdit = false, failRequeue = false, sendAfter = null } = {}) {
  const calls = [];
  let cur = status;
  const request = async (method, path, body) => {
    calls.push(`${method} ${path.replace(/\/campaigns\/[^/]+\//, '/campaigns/X/').replace(/\/campaign-send-jobs\/[^/]+\//, '/campaign-send-jobs/X/')}`);
    if (method === 'GET') {
      return { data: { attributes: { status: cur, send_strategy: { datetime: cur === 'Scheduled' && sendAfter && calls.filter((c) => c.startsWith('POST /campaign-send-jobs')).length ? sendAfter : SEND } } } };
    }
    // Order matters: the requeue POST and the revert PATCH share a path prefix,
    // so the method has to discriminate them or the requeue reads as a revert.
    if (method === 'POST' && path === '/campaign-send-jobs/') {
      if (failRequeue) throw new Error('requeue boom');
      cur = 'Scheduled'; return {};
    }
    if (method === 'PATCH' && path.startsWith('/campaign-send-jobs/')) { cur = 'Draft'; return {}; }
    if (method === 'PATCH' && path.startsWith('/campaigns/')) {
      if (failEdit) throw new Error('edit boom');
      return {};
    }
    return {};
  };
  return { request, sleep: async () => {}, calls, statusNow: () => cur };
}

const patchAudience = () => ({ audiences: { included: ['ENG123'], excluded: ['UigAyc'] } });

test('a scheduled campaign is reverted, patched, and REQUEUED', async () => {
  const k = fakeKlaviyo();
  const r = await reviseScheduledCampaign({ id: 'C1', plan: patchAudience, deps: k });
  assert.equal(r.ok, true, r.problems.join(' | '));
  assert.equal(k.statusNow(), 'Scheduled', 'must end Scheduled, not Draft');
  assert.ok(k.calls.some((c) => c.includes('PATCH /campaign-send-jobs')), 'reverted');
  assert.ok(k.calls.some((c) => c === 'POST /campaign-send-jobs/'), 'requeued');
});

test('THE CRITICAL CASE: a failed edit still requeues, so the send is not lost', async () => {
  const k = fakeKlaviyo({ failEdit: true });
  const r = await reviseScheduledCampaign({ id: 'C1', plan: patchAudience, deps: k });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /edit failed/.test(p)));
  assert.equal(k.statusNow(), 'Scheduled', 'a failed edit must never leave it in Draft');
});

test('a failed REQUEUE is reported as the severe thing it is', async () => {
  const k = fakeKlaviyo({ failRequeue: true });
  const r = await reviseScheduledCampaign({ id: 'C1', plan: patchAudience, deps: k });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /will NOT send/.test(p)), r.problems.join(' | '));
});

test('a Draft campaign is patched WITHOUT a revert or a requeue', async () => {
  const k = fakeKlaviyo({ status: 'Draft' });
  const r = await reviseScheduledCampaign({ id: 'C1', plan: patchAudience, deps: k });
  assert.equal(r.ok, true);
  assert.ok(!k.calls.some((c) => c === 'POST /campaign-send-jobs/'), 'a draft must not be scheduled by this');
});

test('plan() returning null changes nothing — no revert on a no-op', async () => {
  const k = fakeKlaviyo();
  const r = await reviseScheduledCampaign({ id: 'C1', plan: () => null, deps: k });
  assert.equal(r.changed, false);
  assert.equal(r.ok, true);
  assert.deepEqual(k.calls, ['GET /campaigns/X/'], 'exactly one read, no writes');
});

test('a SENT campaign is refused rather than reverted', async () => {
  const k = fakeKlaviyo({ status: 'Sent' });
  const r = await reviseScheduledCampaign({ id: 'C1', plan: patchAudience, deps: k });
  assert.equal(r.changed, false);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /Sent/.test(p)));
  assert.ok(!k.calls.some((c) => c.includes('send-jobs')), 'must not touch the send job of a sent campaign');
});

test('a send time that moved is reported', async () => {
  const k = fakeKlaviyo({ sendAfter: '2026-09-20T22:00:00+00:00' });
  const r = await reviseScheduledCampaign({ id: 'C1', plan: patchAudience, deps: k });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /send time CHANGED/.test(p)), r.problems.join(' | '));
});
