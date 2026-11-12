import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState, planName, duplicateCheck, manualBookingCheck, matchAwdShipment } from '../../lib/amazon-inbound-state.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'inb-'));
const D = (s) => `2026-11-${s}T12:00:00Z`;

test('missing file is empty; unreadable throws', () => {
  const d = tmp();
  assert.deepEqual(loadState(join(d, 'none.json')), { messages: {} });
  writeFileSync(join(d, 'bad.json'), '{oops');
  assert.throws(() => loadState(join(d, 'bad.json')), /unreadable/);
  writeFileSync(join(d, 'inv.json'), '[]');
  assert.throws(() => loadState(join(d, 'inv.json')), /invalid/);
});

test('save then load round-trips, no temp file left', () => {
  const d = tmp();
  const p = join(d, 'sub', 'state.json');
  const st = { messages: { a: { messageId: 'a', step: 'done' } } };
  saveState(p, st);
  assert.deepEqual(loadState(p), st);
  assert.deepEqual(readdirSync(join(d, 'sub')), ['state.json']);
});

test('planName is stable', () => {
  assert.equal(planName('abc'), planName('abc'));
  assert.match(planName('abc'), /^culina-[0-9a-f]{8}$/);
  assert.notEqual(planName('abc'), planName('abd'));
});

const booked = { messages: { m1: { messageId: 'm1', step: 'done', signature: 'S1:3', receivedAt: D('10') } } };

test('same signature 3 days later held, 8 days later not', () => {
  const base = { messageId: 'm2', signature: 'S1:3', text: 'ship it', windowDays: 7 };
  assert.equal(duplicateCheck(booked, { ...base, receivedAt: D('13') }).hold, true);
  assert.equal(duplicateCheck(booked, { ...base, receivedAt: D('18') }).hold, false);
});

test('correction wording after a booking is held', () => {
  const r = duplicateCheck(booked, { messageId: 'm2', signature: 'S2:6', text: 'sorry, 2-pack is 6 cases', receivedAt: D('11'), windowDays: 7 });
  assert.equal(r.hold, true);
  assert.equal(duplicateCheck({ messages: {} }, { messageId: 'm2', signature: 'S2:6', text: 'sorry', receivedAt: D('11'), windowDays: 7 }).hold, false);
});

test('resendOf is never held; held/invalid records are not bookings', () => {
  const r = duplicateCheck(booked, { messageId: 'm1', signature: 'S1:3', text: 'sorry', receivedAt: D('11'), windowDays: 7, resendOf: 'm1' });
  assert.equal(r.hold, false);
  const st = { messages: { h: { messageId: 'h', step: 'held', signature: 'S1:3', receivedAt: D('10') }, i: { messageId: 'i', step: 'invalid_replied', signature: 'S1:3', receivedAt: D('10') } } };
  assert.equal(duplicateCheck(st, { messageId: 'x', signature: 'S1:3', text: 'sorry', receivedAt: D('11'), windowDays: 7 }).hold, false);
});

const lines = [{ sku: 'A3', cases: 9 }, { sku: 'B', cases: 2 }, { sku: 'C', cases: 3 }, { sku: 'D', cases: 1 }];

test('manualBookingCheck: FBA plan plus AWD shipment covers all: placed', () => {
  const r = manualBookingCheck(lines, [
    { id: 'fba1', createdAt: D('12'), casesBySku: { A3: 9 } },
    { id: 'awd1', createdAt: D('13'), casesBySku: { B: 2, C: 3, D: 1 } },
  ], D('11'));
  assert.deepEqual(r, { verdict: 'placed', covering: ['fba1', 'awd1'] });
});
test('manualBookingCheck: partial, before receivedAt, none', () => {
  assert.equal(manualBookingCheck(lines, [{ id: 'f', createdAt: D('12'), casesBySku: { A3: 9 } }], D('11')).verdict, 'partial');
  assert.equal(manualBookingCheck(lines, [{ id: 'f', createdAt: D('10'), casesBySku: { A3: 9, B: 2, C: 3, D: 1 } }], D('11')).verdict, 'none');
  assert.equal(manualBookingCheck(lines, [], D('11')).verdict, 'none');
});

test('matchAwdShipment: oldest share wins a single shipment', () => {
  const shares = [
    { messageId: 'new', handoffAt: D('05'), lines: [{ sku: 'B', cases: 2 }] },
    { messageId: 'old', handoffAt: D('02'), lines: [{ sku: 'B', cases: 2 }] },
  ];
  const r = matchAwdShipment(shares, [{ shipmentId: 's1', createdAt: D('06'), casesBySku: { B: 2 } }]);
  assert.deepEqual(r, [{ messageId: 'old', shipmentId: 's1' }]);
});
test('matchAwdShipment: before handoff and partial counts do not match', () => {
  const sh = [{ messageId: 'm', handoffAt: D('05'), lines: [{ sku: 'B', cases: 2 }, { sku: 'C', cases: 3 }] }];
  assert.deepEqual(matchAwdShipment(sh, [{ shipmentId: 's', createdAt: D('04'), casesBySku: { B: 2, C: 3 } }]), []);
  assert.deepEqual(matchAwdShipment(sh, [{ shipmentId: 's', createdAt: D('06'), casesBySku: { B: 2, C: 2 } }]), []);
  assert.deepEqual(matchAwdShipment(sh, [{ shipmentId: 's', createdAt: D('06'), casesBySku: { B: 2 } }]), []);
});
