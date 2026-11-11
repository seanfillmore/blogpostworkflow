import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAlerts } from '../../lib/culina-alerts.js';

const config = { alert_below_days: 60 };
const today = '2026-11-11';
const it = (o) => ({ key: 'a', label: 'A', coverDays: 40, onHand: 10, ...o });

test('below threshold, never alerted -> below_threshold row', () => {
  const r = decideAlerts({ items: [it()], state: {}, today, config });
  assert.equal(r.send, true);
  assert.equal(r.rows[0].reason, 'below_threshold');
  assert.deepEqual(r.nextState.a, { lastAlertAt: today, level: 'below_threshold' });
});

test('alerted 3 days ago and still below -> no row, state kept', () => {
  const state = { a: { lastAlertAt: '2026-11-08', level: 'below_threshold' } };
  const r = decideAlerts({ items: [it()], state, today, config });
  assert.equal(r.send, false);
  assert.deepEqual(r.rows, []);
  assert.deepEqual(r.nextState.a, state.a);
});

test('alerted 7 days ago -> reminder', () => {
  const state = { a: { lastAlertAt: '2026-11-04', level: 'below_threshold' } };
  const r = decideAlerts({ items: [it()], state, today, config });
  assert.equal(r.rows[0].reason, 'reminder');
  assert.equal(r.nextState.a.lastAlertAt, today);
});

test('on hand 0 -> out_of_stock, even if alerted yesterday at below_threshold', () => {
  const state = { a: { lastAlertAt: '2026-11-10', level: 'below_threshold' } };
  const r = decideAlerts({ items: [it({ onHand: 0, coverDays: 0 })], state, today, config });
  assert.equal(r.rows[0].reason, 'out_of_stock');
  assert.deepEqual(r.nextState.a, { lastAlertAt: today, level: 'out_of_stock' });
});

test('out_of_stock first day and weekly reminder', () => {
  const i = it({ onHand: 0, coverDays: null });
  assert.equal(decideAlerts({ items: [i], state: {}, today, config }).rows[0].reason, 'out_of_stock');
  const recent = { a: { lastAlertAt: '2026-11-10', level: 'out_of_stock' } };
  assert.equal(decideAlerts({ items: [i], state: recent, today, config }).rows.length, 0);
  const old = { a: { lastAlertAt: '2026-11-04', level: 'out_of_stock' } };
  assert.equal(decideAlerts({ items: [i], state: old, today, config }).rows[0].reason, 'out_of_stock');
});

test('recovers to 70 -> key removed, no row', () => {
  const state = { a: { lastAlertAt: '2026-11-04', level: 'below_threshold' }, b: { lastAlertAt: '2026-11-10', level: 'below_threshold' } };
  const r = decideAlerts({ items: [it({ coverDays: 70 }), it({ key: 'b', label: 'B' })], state, today, config });
  assert.equal('a' in r.nextState, false);
  assert.equal(r.rows.length, 0);
  assert.ok(r.nextState.b);
});

test('null coverDays with stock is never alerted; state cleared', () => {
  const state = { a: { lastAlertAt: '2026-11-04', level: 'below_threshold' } };
  const r = decideAlerts({ items: [it({ coverDays: null })], state, today, config });
  assert.equal(r.send, false);
  assert.equal('a' in r.nextState, false);
});

test('threshold from config; exactly at threshold is not below', () => {
  assert.equal(decideAlerts({ items: [it({ coverDays: 60 })], state: {}, today, config }).rows.length, 0);
  assert.equal(decideAlerts({ items: [it({ coverDays: 60 })], state: {}, today, config: { alert_below_days: 90 } }).rows.length, 1);
});

test('does not mutate input state; multiple rows in one result', () => {
  const state = { a: { lastAlertAt: '2026-11-04', level: 'below_threshold' } };
  const copy = JSON.parse(JSON.stringify(state));
  const r = decideAlerts({ items: [it(), it({ key: 'b', label: 'B', onHand: 0 })], state, today, config });
  assert.deepEqual(state, copy);
  assert.equal(r.rows.length, 2);
});

test('partial restock (out_of_stock -> below_threshold) does not alert; keeps lastAlertAt', () => {
  const state = { a: { lastAlertAt: '2026-11-09', level: 'out_of_stock' } };
  const r = decideAlerts({ items: [it({ onHand: 5, coverDays: 20 })], state, today, config });
  assert.equal(r.send, false);
  assert.deepEqual(r.nextState.a, { lastAlertAt: '2026-11-09', level: 'below_threshold' });
  const old = { a: { lastAlertAt: '2026-11-04', level: 'out_of_stock' } };
  const r2 = decideAlerts({ items: [it({ onHand: 5, coverDays: 20 })], state: old, today, config });
  assert.equal(r2.rows[0].reason, 'reminder');
});

test('missing or unparseable lastAlertAt counts as due', () => {
  for (const bad of [undefined, 'garbage']) {
    const state = { a: { lastAlertAt: bad, level: 'below_threshold' } };
    const r = decideAlerts({ items: [it()], state, today, config });
    assert.equal(r.rows[0].reason, 'reminder');
    assert.equal(r.nextState.a.lastAlertAt, today);
  }
});

test('non-finite alert_below_days throws', () => {
  for (const c of [{}, { alert_below_days: NaN }, { alert_below_days: '60' }, undefined]) {
    assert.throws(() => decideAlerts({ items: [it()], state: {}, today, config: c }), /alert_below_days/);
  }
});

test('recover then drop again alerts as below_threshold', () => {
  let s = decideAlerts({ items: [it()], state: {}, today: '2026-11-01', config }).nextState;
  s = decideAlerts({ items: [it({ coverDays: 80 })], state: s, today: '2026-11-03', config }).nextState;
  assert.deepEqual(s, {});
  const r = decideAlerts({ items: [it({ coverDays: 30 })], state: s, today: '2026-11-04', config });
  assert.equal(r.rows[0].reason, 'below_threshold');
});

test('final-fix: extra item fields pass through to rows untouched', () => {
  const r = decideAlerts({ items: [it({ fba: 4, awd: 5, inbound: 1, shipQty: 300, shipBy: '2026-11-20', needBy: null })], state: {}, today, config });
  assert.equal(r.rows[0].fba, 4);
  assert.equal(r.rows[0].awd, 5);
  assert.equal(r.rows[0].inbound, 1);
  assert.equal(r.rows[0].shipQty, 300);
  assert.equal(r.rows[0].shipBy, '2026-11-20');
  assert.equal(r.rows[0].reason, 'below_threshold');
  assert.equal(r.rows[0].key, 'a');
});
