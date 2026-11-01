import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectImap, isTransientNetworkError } from '../../lib/hushmail.js';
import { transientStreak, TRANSIENT_ESCALATE_AFTER } from '../../agents/creator-outreach/index.js';

const tlsDrop = () => Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' });

test('the production TLS drop is transient; an auth failure is not', () => {
  assert.equal(isTransientNetworkError(tlsDrop()), true);
  assert.equal(isTransientNetworkError(new Error('Connection timeout')), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error('Invalid password'), { authenticationFailed: true })), false);
  assert.equal(isTransientNetworkError(null), false);
});

test('connectImap retries a transient drop with a FRESH client', async () => {
  let made = 0;
  const client = await connectImap(() => {
    made += 1;
    const n = made;
    return { connect: async () => { if (n < 3) throw tlsDrop(); }, close() {}, n };
  }, { sleep: async () => {} });
  assert.equal(made, 3);
  assert.equal(client.n, 3);
});

test('connectImap does not retry an auth failure', async () => {
  let made = 0;
  await assert.rejects(connectImap(() => { made += 1; return { connect: async () => { throw new Error('Invalid password'); } }; }, { sleep: async () => {} }), /Invalid password/);
  assert.equal(made, 1);
});

test('connectImap gives up after its attempts', async () => {
  await assert.rejects(connectImap(() => ({ connect: async () => { throw tlsDrop(); } }), { attempts: 2, sleep: async () => {} }), /TLS/);
});

test('a single blip is not reported; a sustained outage is', () => {
  let prev = null;
  for (let i = 1; i < TRANSIENT_ESCALATE_AFTER; i++) {
    const r = transientStreak(prev, { failed: true, now: `t${i}` });
    assert.equal(r.report, false);
    prev = r.next;
  }
  const r = transientStreak(prev, { failed: true, now: 'tN' });
  assert.equal(r.report, true);
  assert.equal(r.next.since, 't1');
  assert.deepEqual(transientStreak(r.next, { failed: false }), { next: null, report: false });
});
