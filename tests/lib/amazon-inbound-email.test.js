import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../../lib/amazon-inbound-email.js';
import { parseShipmentEmail } from '../../lib/amazon-inbound-parse.js';

const CONFIG = JSON.parse(readFileSync(new URL('../../config/amazon-inbound.json', import.meta.url), 'utf8'));

const ship = [
  { shipmentId: 'FBA111', destination: 'ONT8', cases: [{ key: '2-pack', count: 5 }], mode: 'GROUND_SMALL_PARCEL', carrier: 'UPS' },
  { shipmentId: 'FBA222', destination: 'PHX7', cases: [{ key: '3-pack', count: 8 }, { key: '6-pack', count: 2 }], mode: 'FREIGHT_LTL', carrier: 'XPO',
    pallets: [{ cases: [{ sku: 'salt_Soap_conditioner', key: '3-pack', count: 8 }] }, { cases: [{ sku: 'soap_oil_salt_stick_scrubber_brush', key: '6-pack', count: 2 }] }] },
];
const awdLines = [{ key: '4-pack', sku: 'soap_oil_stick_salt2', asin: 'B08K892JQG', cases: 3, units_per_case: 12, case_in: { l: 18, w: 10, h: 12 }, case_lb: 28 }];

const all = () => [
  E.labelsReply({ record: { subject: 'Re: cases' }, shipments: ship, awdLines }),
  E.awdLabelsReply({ awdShipmentId: 'AWD1', lines: awdLines }),
  E.resendRequest({ problems: [{ raw: 'two packs (x)', reason: 'bad line' }] }),
  E.awdHandoff({ lines: awdLines, shipFrom: { name: 'CMS', addressLine1: '41007 Harris Rd', city: 'Springville', stateOrProvinceCode: 'CA', postalCode: '93265' }, reasons: ['30 days of FBA cover'] }),
  E.awdReminder({ days: 3 }),
  E.heldNotice({ reason: 'unknown sender', text: 'hi' }),
  E.alreadyPlacedNotice({ covering: ['FBA9'], lines: awdLines }),
  E.failureNotice({ messageId: 'm1', step: 'create', planId: 'p1', error: 'boom' }),
];

test('no dashes in any output', () => {
  for (const o of all()) for (const k of ['subject', 'text', 'html']) assert.ok(!/[—–]/.test(o[k]), `${o.subject} ${k}`);
});
test('labelsReply names shipments, packs, pallets, AWD', () => {
  const o = E.labelsReply({ record: {}, shipments: ship, awdLines });
  for (const s of ['FBA111', 'FBA222', '2-pack', '3-pack', '6-pack', '2 pallets', 'XPO', 'Drop the boxes at any UPS location or schedule a UPS pickup', 'contact you to schedule', '4-pack']) assert.ok(o.text.includes(s), s);
});
test('resendRequest quotes bad line verbatim', () => {
  assert.ok(E.resendRequest({ problems: [{ raw: 'two packs (x)' }] }).text.includes('two packs (x)'));
});
test('awdHandoff lists per-SKU facts', () => {
  const t = all()[3].text;
  for (const s of ['B08K892JQG', '3 cases', '12 units/case', '18 x 10 x 12', '28 lb', 'Seller Central']) assert.ok(t.includes(s), s);
});
test('html escapes', () => {
  assert.ok(E.heldNotice({ reason: '<b>&', text: '' }).html.includes('&lt;b&gt;&amp;'));
});
test('alreadyPlaced lists covering ids', () => {
  assert.ok(all()[6].text.includes('FBA9'));
});

test('labelsReply pallet lines name the pack, not the MSKU', () => {
  const t = E.labelsReply({ record: {}, shipments: ship, awdLines }).text;
  assert.ok(t.includes('Pallet 1 (8 cases): 8 x 3-pack'), t);
  assert.ok(t.includes('Pallet 2 (2 cases): 2 x 6-pack'), t);
  assert.ok(!t.includes('salt_Soap_conditioner') && !t.includes('soap_oil_salt_stick_scrubber_brush'));
});
test("resendRequest's example line parses as a shipment line", () => {
  const t = E.resendRequest({ problems: [{ raw: 'x' }] }).text;
  const example = t.split('\n').find((l) => /^2-pack \(/.test(l));
  assert.equal(example, '2-pack (10 cases - 200 units)');
  const parsed = parseShipmentEmail(example, CONFIG.skus);
  assert.equal(parsed.kind, 'shipment');
  assert.deepEqual(parsed.lines.map((l) => [l.key, l.cases, l.units]), [['2-pack', 10, 200]]);
});
test('awdHandoff shows the expiration date for an expiration-dated pack and only for it', () => {
  const lines = [...awdLines, { key: '2-pack', sku: 'BLI-X', asin: 'B077LYR5SF', cases: 5, units_per_case: 20, case_in: { l: 18, w: 9, h: 12 }, case_lb: 27, expiration: '2029-11-12' }];
  const t = E.awdHandoff({ lines, shipFrom: {} }).text;
  assert.match(t, /2-pack, SKU BLI-X.*expiration date 2029-11-12/);
  assert.ok(!/4-pack[^\n]*expiration/.test(t));
  assert.match(t, /Enter the expiration date shown above/);
  assert.ok(!/expiration/.test(E.awdHandoff({ lines: awdLines, shipFrom: {} }).text));
});
