import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG, inSendWindow, dailyCap, signature, stripDashes, followUpText, bumpText,
  askAddressText, checkOutgoingCopy, shouldPause, OPT_OUT_LINE, firstName,
} from '../../lib/press-outreach.js';

const ADDR = '1 Example Way, Testville, WY 00000, United States';

test('send window is 16-24 UTC on weekdays', () => {
  assert.equal(inSendWindow(Date.parse('2026-10-05T16:00:00Z')), true);  // Monday
  assert.equal(inSendWindow(Date.parse('2026-10-05T15:59:00Z')), false);
  assert.equal(inSendWindow(Date.parse('2026-10-05T23:59:00Z')), true);
  assert.equal(inSendWindow(Date.parse('2026-10-10T18:00:00Z')), false); // Saturday
});

test('cap is 10 until 14 clean days after the first send, then 25; never ramps while paused', () => {
  const t = Date.parse('2026-10-20T18:00:00Z');
  assert.equal(dailyCap(DEFAULT_CONFIG, {}, t), 10);
  assert.equal(dailyCap(DEFAULT_CONFIG, { first_sent_at: '2026-10-07T17:00:00Z' }, t), 10);
  assert.equal(dailyCap(DEFAULT_CONFIG, { first_sent_at: '2026-10-05T17:00:00Z' }, t), 25);
  assert.equal(dailyCap(DEFAULT_CONFIG, { first_sent_at: '2026-10-01T17:00:00Z', paused: { at: 'x' } }, t), 0);
});

test('signature carries the postal address; templates carry no dashes', () => {
  assert.match(signature(ADDR), /1 Example Way/);
  for (const s of [followUpText({ firstName: 'Jane', n: 1 }), followUpText({ firstName: 'Jane', n: 2 }), bumpText({ firstName: 'Jane', originalSubject: 'X' }), askAddressText({ firstName: 'Jane' })]) {
    assert.doesNotMatch(s, /[—–]/);
    assert.ok(s.split(/\s+/).length <= 70, 'follow-ups stay short');
  }
  assert.equal(stripDashes('a — b – c'), 'a, b, c');
});

test('first pitch must carry the opt-out line and the address, and pass the claim gate', () => {
  const good = `Hi Jane,\n\nShort pitch.\n\n${OPT_OUT_LINE}\n\n${signature(ADDR)}`;
  assert.equal(checkOutgoingCopy({ subject: 'A coconut body cream', text: good, kind: 'pitch' }).ok, true);
  assert.match(checkOutgoingCopy({ subject: 's', text: 'no lines', kind: 'pitch' }).problems.join(), /opt-out/);
  assert.match(checkOutgoingCopy({ subject: 'Our natural antiperspirant', text: good, kind: 'pitch' }).problems.join(), /product-category|antiperspirant/);
  assert.match(checkOutgoingCopy({ subject: 'Heals eczema', text: good, kind: 'pitch' }).problems.join(), /eczema|heal/i);
  assert.match(checkOutgoingCopy({ subject: 'a — b', text: good, kind: 'pitch' }).problems.join(), /dash/);
  assert.equal(checkOutgoingCopy({ subject: 'x'.repeat(71), text: good, kind: 'pitch' }).ok, false);

  // Body-level product-category violation
  const bodyWithClaim = `Hi Jane,\n\nOur antiperspirant formula keeps you fresh all day.\n\n${OPT_OUT_LINE}\n\n${signature(ADDR)}`;
  assert.match(checkOutgoingCopy({ subject: 'Coconut cream', text: bodyWithClaim, kind: 'pitch' }).problems.join(), /product-category/);

  // Category-reference sentence must pass
  const categoryRef = `Hi Jane,\n\nAntiperspirants are regulated as over-the-counter drugs; ours is a deodorant.\n\n${OPT_OUT_LINE}\n\n${signature(ADDR)}`;
  assert.equal(checkOutgoingCopy({ subject: 'Coconut deodorant', text: categoryRef, kind: 'pitch' }).ok, true);
});

test('auto-pause on >3% bounces over the last 50, or any complaint', () => {
  const sends = (bounced, complained = 0) => Array.from({ length: 50 }, (_, i) => ({ last_event: i < bounced ? 'bounced' : i < bounced + complained ? 'complained' : 'delivered' }));
  assert.equal(shouldPause(sends(1)).pause, false);
  assert.equal(shouldPause(sends(2)).pause, true);  // 4%
  assert.equal(shouldPause(sends(0, 1)).pause, true);
  assert.equal(shouldPause([{ last_event: 'bounced' }]).pause, false, 'fewer than 20 sends: rate not judged');
  assert.equal(shouldPause([{ last_event: 'complained' }]).pause, true, 'a complaint always pauses');
});

test('firstName falls back to "there" for an outlet record', () => {
  assert.equal(firstName({ name: 'Jane Doe', kind: 'journalist' }), 'Jane');
  assert.equal(firstName({ name: 'Example Magazine', kind: 'outlet' }), 'there');
});

test('fixed follow-up templates pass copy checks', () => {
  for (const [n, text] of [[1, followUpText({ firstName: 'Jane', n: 1 })], [2, followUpText({ firstName: 'Jane', n: 2 })], [null, bumpText({ firstName: 'Jane' })], [null, askAddressText({ firstName: 'Jane' })]]) {
    const result = checkOutgoingCopy({ subject: 'Re: Coconut cream', text, kind: 'followup' });
    assert.equal(result.ok, true, `template should pass (n=${n}): ${result.problems.join('; ')}`);
  }
});

test('checkOutgoingCopy accepts postalAddress parameter for pitch-specific validation', () => {
  const baseText = `Hi Jane,\n\nShort pitch.\n\n${OPT_OUT_LINE}\n\n`;
  const customAddr = '456 Main St, Anytown, CO 80000, United States';

  // With postalAddress: exact string required after opt-out line
  const withCustom = `${baseText}${customAddr}`;
  assert.equal(checkOutgoingCopy({ subject: 'Test', text: withCustom, kind: 'pitch', postalAddress: customAddr }).ok, true);
  assert.match(checkOutgoingCopy({ subject: 'Test', text: baseText + ADDR, kind: 'pitch', postalAddress: customAddr }).problems.join(), /missing the postal address/);

  // Without postalAddress: fallback to 5-digit check
  const withDefault = `${baseText}${signature(ADDR)}`;
  assert.equal(checkOutgoingCopy({ subject: 'Test', text: withDefault, kind: 'pitch' }).ok, true);
  assert.match(checkOutgoingCopy({ subject: 'Test', text: baseText + 'No address here', kind: 'pitch' }).problems.join(), /missing the postal address/);
});
