import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoster, planScheduled, renderTemplate, classifyInbound, replyProblems, parseDraft,
  firstName, shortProduct, inSendWindow, holdingReply, replySubject, DEFAULT_CONFIG,
} from '../../lib/creator-outreach.js';
import { stripQuoted } from '../../lib/hushmail.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-02T18:00:00Z'); // inside the send window
const order = (over = {}) => ({
  name: '#2360', createdAt: '2026-09-22T00:00:00Z', tags: ['sample-request', 'trybe'], email: 'Lori@Example.com',
  note: 'Trybe sample request for Lori Yockim',
  lineItems: { nodes: [{ title: 'Coconut Moisturizer | 4oz' }, { title: 'Moisturizing Coconut Soap | 3.4oz' }] },
  fulfillments: [{ status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-09-26T19:00:00Z', trackingInfo: [{ company: 'USPS', number: '9234' }] }],
  ...over,
});
const roster = (orders, submissions = []) => buildRoster({ orders, submissions });
const iso = (ms) => new Date(ms).toISOString();

test('roster keys on the order email, lowercased, and owes content only for delivered products', () => {
  const [c] = roster([order(), order({ name: '#2400', lineItems: { nodes: [{ title: 'Lip Balm' }] }, fulfillments: [{ displayStatus: 'IN_TRANSIT' }] })]);
  assert.equal(c.email, 'lori@example.com');
  assert.equal(c.firstName, 'Lori');
  assert.deepEqual(c.missing, ['Coconut Moisturizer | 4oz', 'Moisturizing Coconut Soap | 3.4oz']);
  assert.equal(c.orders[0].trackingNumber, '9234');
  assert.equal(roster([order({ email: '' })]).length, 0, 'no email, no contact');
});

test('first names: forwarder prefixes and handles fall back to "there"', () => {
  assert.equal(firstName('gigi oh'), 'Gigi');
  assert.equal(firstName('#ICC35294 Jose'), 'there');
  assert.equal(shortProduct('Coconut Moisturizer | 4oz'), 'Coconut Moisturizer');
  assert.equal(shortProduct('Coconut Oil Toothpaste — Natural Oral Care'), 'Coconut Oil Toothpaste');
});

test('welcome goes once a sample ships, then the nudge ladder by delivery age', () => {
  const r = roster([order()]);
  assert.equal(planScheduled(r, {}, { now: NOW }).sends[0].kind, 'welcome');
  const afterWelcome = { creators: { 'lori@example.com': { sent: { welcome: iso(NOW - 3 * DAY) }, lastScheduledAt: iso(NOW - 3 * DAY) } } };
  assert.equal(planScheduled(r, afterWelcome, { now: NOW }).sends[0].kind, 'nudge1');
  const n1 = { creators: { 'lori@example.com': { sent: { welcome: 'x', nudge1: iso(NOW - 2 * DAY) }, lastScheduledAt: iso(NOW - 2 * DAY) } } };
  assert.equal(planScheduled(r, n1, { now: NOW }).sends.length, 0, 'nudge2 waits for 12 days');
  assert.equal(planScheduled(r, n1, { now: NOW + 10 * DAY }).sends[0].kind, 'nudge2');
  const n2 = { creators: { 'lori@example.com': { sent: { welcome: 'x', nudge1: 'x', nudge2: iso(NOW + 10 * DAY) }, lastScheduledAt: iso(NOW + 10 * DAY) } } };
  assert.equal(planScheduled(r, n2, { now: NOW + 18 * DAY }).sends[0].kind, 'final');
  const fin = { creators: { 'lori@example.com': { sent: { welcome: 'x', nudge1: 'x', nudge2: 'x', final: 'x' } } } };
  assert.equal(planScheduled(r, fin, { now: NOW + 60 * DAY }).sends.length, 0, 'the ladder stops');
});

test('guards suppress: opted out, waiting on Sean, replied recently, emailed recently', () => {
  const r = roster([order()]);
  for (const rec of [{ optedOut: true }, { escalatedOpen: true }, { lastInboundAt: iso(NOW - DAY) }, { lastScheduledAt: iso(NOW - DAY) }]) {
    assert.equal(planScheduled(r, { creators: { 'lori@example.com': rec } }, { now: NOW }).sends.length, 0, JSON.stringify(rec));
  }
});

test('no nudge right after a submission; full coverage ends nudges; approval earns one thank-you', () => {
  const st = { creators: { 'lori@example.com': { sent: { welcome: 'x' }, thanked: ['s1'] } } };
  const recent = [{ id: 's1', status: 'approved', created_at: iso(NOW - DAY), creator: { name: 'Lori Yockim' }, products: [{ name: 'Coconut Moisturizer | 4oz' }] }];
  assert.equal(planScheduled(roster([order()], recent), st, { now: NOW }).sends.length, 0);
  const all = [{ ...recent[0], created_at: iso(NOW - 30 * DAY), products: [{ name: 'Coconut Moisturizer | 4oz' }, { name: 'Moisturizing Coconut Soap | 3.4oz' }] }];
  assert.equal(planScheduled(roster([order()], all), st, { now: NOW }).sends.length, 0);
  const fresh = planScheduled(roster([order()], [{ ...recent[0], id: 's2' }]), st, { now: NOW }).sends[0];
  assert.equal(fresh.kind, 'thanks');
  assert.deepEqual(fresh.extra.submissionIds, ['s2']);
  assert.match(fresh.text, /Moisturizing Coconut Soap too/);
});

test('outside the send window nothing scheduled goes, but it is reported', () => {
  const night = Date.parse('2026-10-02T08:00:00Z');
  assert.equal(inSendWindow(night), false);
  const p = planScheduled(roster([order()]), {}, { now: night });
  assert.equal(p.sends.length, 0);
  assert.equal(p.deferredByWindow.length, 1);
});

test('the per-run cap holds', () => {
  const many = Array.from({ length: 20 }, (_, i) => order({ name: `#${i}`, email: `c${i}@x.com`, note: `Trybe sample request for C${i}` }));
  const p = planScheduled(roster(many), {}, { now: NOW });
  assert.equal(p.sends.length, DEFAULT_CONFIG.maxScheduledPerRun);
});

test('templates: no em dashes, no health claims, every kind renders', () => {
  const [c] = roster([order()]);
  for (const k of ['welcome', 'nudge1', 'nudge2', 'final', 'thanks']) {
    const { subject, text } = renderTemplate(k, c, { products: ['Coconut Moisturizer | 4oz'] });
    assert.ok(subject && text.includes('Hi Lori,'), k);
    assert.ok(!/—/.test(text + subject), `${k} has an em dash`);
    assert.deepEqual(replyProblems(text).filter((p) => p !== 'too long'), [], `${k}: ${replyProblems(text)}`);
  }
});

test('inbound triage: escalate money, reactions, damage; opt-out; ignore autoresponders', () => {
  const m = (text, subject = 'Re: samples') => classifyInbound({ text, subject });
  assert.equal(m('When will my package arrive?').action, 'draft');
  assert.equal(m('How much do you pay per video?').action, 'escalate');
  assert.deepEqual(m('I got a rash after using it').reasons, ['a skin reaction or health concern']);
  assert.equal(m('The soap arrived broken').action, 'escalate');
  assert.equal(m('Please remove me from these emails').action, 'opt-out');
  assert.equal(m('back monday', 'Out of Office: samples').action, 'ignore');
  assert.equal(classifyInbound({ text: 'hi', subject: 'x', autoSubmitted: true }).action, 'ignore');
  assert.equal(m('').action, 'ignore');
});

test('a drafted reply may not promise money or product, claim a cure, or use an em dash', () => {
  assert.deepEqual(replyProblems('Your package is in transit with USPS and should arrive Monday.\nSean'), []);
  assert.ok(replyProblems('We pay 20% commission on sales.').length);
  assert.ok(replyProblems('No worries, I will send you another one!').length);
  assert.ok(replyProblems('It heals eczema fast.').length);
  assert.ok(replyProblems('Great question — yes.').includes('em dash'));
});

test('model output parsing is strict about the action', () => {
  assert.deepEqual(parseDraft('```json\n{"action":"reply","reply":"Hi","escalate_reason":""}\n```'), { action: 'reply', reply: 'Hi', reason: '' });
  assert.throws(() => parseDraft('{"action":"approve"}'));
  assert.throws(() => parseDraft('not json'));
});

test('holding reply adds stop-using advice only for a reaction; subjects thread', () => {
  const [c] = roster([order()]);
  assert.match(holdingReply(c, ['a skin reaction or health concern']), /stop using/);
  assert.doesNotMatch(holdingReply(c, ['money or terms']), /stop using/);
  assert.equal(replySubject('Re: hi'), 'Re: hi');
  assert.equal(replySubject('hi'), 'Re: hi');
});

test('quoted history is stripped before the reply is judged', () => {
  assert.equal(stripQuoted('Thanks!\n\nOn Tue, Sean wrote:\n> how is it going'), 'Thanks!');
  assert.equal(stripQuoted('ok\n> quoted'), 'ok');
});

test('long catalog titles read naturally in prose', () => {
  assert.equal(shortProduct('Non-Toxic Body Lotion Made With Only 6 Clean Ingredients'), 'Non-Toxic Body Lotion');
});

test('no thank-you for a video submitted more than 14 days ago', () => {
  const old = [{ id: 's9', status: 'approved', created_at: iso(NOW - 20 * DAY), creator: { name: 'Lori Yockim' }, products: [{ name: 'Coconut Moisturizer | 4oz' }] }];
  const p = planScheduled(roster([order()], old), { creators: { 'lori@example.com': { sent: { welcome: 'x', nudge1: 'x' }, lastScheduledAt: iso(NOW - 3 * DAY) } } }, { now: NOW });
  assert.notEqual(p.sends[0]?.kind, 'thanks');
});

test('resend transport: From is Sean, threading headers carried, Sent copy appended with the same Message-ID', async () => {
  const { sendMail } = await import('../../lib/hushmail.js');
  let posted;
  let appended;
  const r = await sendMail({ user: 'sean@realskincare.com', pass: 'x' }, { to: 'c@x.com', subject: 'Re: hi', text: 'Hello', inReplyTo: '<a@x>' }, {
    via: 'resend', resendKey: 'k',
    fetchImpl: async (url, init) => { posted = JSON.parse(init.body); return new Response('{"id":"r1"}', { status: 200 }); },
    appendSent: async (creds, raw) => { appended = raw.toString(); },
  });
  assert.equal(posted.from, 'Sean at Real Skin Care <sean@realskincare.com>');
  assert.equal(posted.headers['In-Reply-To'], '<a@x>');
  assert.equal(posted.headers['Message-ID'], r.messageId);
  assert.match(r.messageId, /@realskincare\.com>$/);
  assert.ok(appended.includes(`Message-ID: ${r.messageId}`));
  assert.equal(r.sentCopy, 'saved to Sent');
});

test('resend transport: a failed Sent append is reported, not fatal', async () => {
  const { sendMail } = await import('../../lib/hushmail.js');
  const r = await sendMail({ user: 'sean@realskincare.com', pass: 'x' }, { to: 'c@x.com', subject: 's', text: 't' }, {
    via: 'resend', resendKey: 'k', fetchImpl: async () => new Response('{"id":"r1"}'), appendSent: async () => { throw new Error('imap down'); },
  });
  assert.match(r.sentCopy, /NOT saved to Sent: imap down/);
});
