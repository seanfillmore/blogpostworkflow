import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseShipmentEmail, linesSignature } from '../../lib/amazon-inbound-parse.js';

const { skus } = JSON.parse(readFileSync(new URL('../../config/amazon-inbound.json', import.meta.url), 'utf8'));
const parse = (t) => parseShipmentEmail(t, skus);

test("Travis's real message parses", () => {
  const r = parse('4-pack (9 cases - 108 units)\n3-pack (9 cases - 108 units)\n2-pack (5 cases - 100 unis)\n6-pack (10 cases - 120 units)');
  assert.equal(r.kind, 'shipment');
  assert.equal(r.lines.length, 4);
  const six = r.lines.find((l) => l.key === '6-pack');
  assert.equal(six.cases, 10);
  assert.equal(six.units, 120);
});

test('chatter is none', () => {
  assert.equal(parse('thanks, see you friday').kind, 'none');
});

test('unknown pack is invalid', () => {
  const r = parse('5-pack (2 cases - 24 units)');
  assert.equal(r.kind, 'invalid');
  assert.match(r.problems[0].reason, /unknown pack "5-pack"/);
  assert.equal(r.problems[0].raw, '5-pack (2 cases - 24 units)');
});

test('unit mismatch is invalid', () => {
  const r = parse('3-pack (9 cases - 100 units)');
  assert.equal(r.kind, 'invalid');
  assert.match(r.problems[0].reason, /mismatch.*9 cases x 12 = 108/);
});

test('CRLF, en dash, spaces and "3 pack" parse', () => {
  const r = parse('3 pack (9 cases – 108 units)\r\n  2-PACK  ( 5 Cases — 100 units )  \r\n');
  assert.equal(r.kind, 'shipment');
  assert.equal(r.lines.length, 2);
});

test('x separator and no separator parse', () => {
  assert.equal(parse('3-pack (9 cases x 108 units)').kind, 'shipment');
  assert.equal(parse('3-pack (9 cases 108 units)').kind, 'shipment');
});

test('one bad line makes the whole message invalid and books nothing', () => {
  const r = parse('4-pack (9 cases - 108 units)\n2-pack (five cases)');
  assert.equal(r.kind, 'invalid');
  assert.equal(r.lines.length, 0);
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].raw, '2-pack (five cases)');
});

test('a quoted earlier list never books', () => {
  const r = parse('Thanks!\n\nOn Tue, Travis wrote:\n> 4-pack (9 cases - 108 units)');
  assert.equal(r.kind, 'none');
});

test('linesSignature is order-independent', () => {
  const a = parse('4-pack (9 cases - 108 units)\n6-pack (10 cases - 120 units)').lines;
  assert.equal(linesSignature(a), linesSignature([...a].reverse()));
  assert.match(linesSignature(a), /soap_oil_stick_salt2:9/);
});
