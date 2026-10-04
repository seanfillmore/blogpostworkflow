import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoster, planScheduled, renderTemplate, classifyInbound, replyProblems, parseDraft,
  firstName, shortProduct, inSendWindow, replySubject, DEFAULT_CONFIG,
  withQuotedThread, MAX_QUOTED_CHARS,
} from '../../lib/creator-outreach.js';
import { stripQuoted, isEmojiReaction, isAgentMessageId } from '../../lib/hushmail.js';

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

test('reply subjects thread', () => {
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

// The 2026-10-03 incident, from the real messages: a heart emoji was escalated
// as a skin reaction and the creator was told to stop using a product she had
// not received yet.
test('a Gmail emoji reaction is ignored, never escalated as a skin reaction', () => {
  const body = '\u{1F496}\n\nSierra Swinney reacted via Gmail\n<https://www.google.com/gmail/about/>';
  assert.equal(isEmojiReaction({ text: body, attachments: [] }), true);
  assert.equal(isEmojiReaction({ text: 'x', attachments: [{ contentType: 'text/vnd.google.email-reaction+json' }] }), true);
  assert.equal(isEmojiReaction({ text: 'Thanks, it arrived!', attachments: [] }), false);
  assert.deepEqual(classifyInbound({ subject: 'Re: samples', text: body, emojiReaction: true }), { action: 'ignore', reason: 'emoji reaction' });
});

test('the health pattern needs a symptom or condition, not a stray word', () => {
  const m = (text) => classifyInbound({ text, subject: 'Re: samples' }).action;
  for (const ok of [
    'Sierra Swinney reacted via Gmail',
    'I will film it this weekend, I am still learning',
    'My daughter will be in the video, she is ill-tempered in the mornings lol',
    'I will burn through this bottle fast!',
    'Excited to start posting it',
  ]) assert.equal(m(ok), 'draft', ok);
  for (const bad of [
    'I got a rash after using it',
    'I had a reaction on my arms',
    'my skin reacted badly to it',
    'It is burning a little',
    'I am prone to eczema flareups',
    'my hands are itchy and swollen',
    'is it safe while pregnant?',
  ]) assert.equal(m(bad), 'escalate', bad);
});

test('Gmail wraps a long attribution over two lines and it still counts as the quote', () => {
  const real = 'That is so helpful. Thanks.\n\nOn Fri, Oct 2, 2026 at 10:30 PM Sean at Real Skin Care <\nsean@realskincare.com> wrote:\n\n> Hi Sierra,';
  assert.equal(stripQuoted(real), 'That is so helpful. Thanks.');
  const twoLine = 'Talk soon!\n\nOn Fri, Oct 2, 2026 at 9:30 AM Sean at Real Skin Care <sean@realskincare.com>\nwrote:\n\n> Hi';
  assert.equal(stripQuoted(twoLine), 'Talk soon!');
  assert.equal(stripQuoted('On Monday I will film it.\nThanks!'), 'On Monday I will film it.\nThanks!');
});

test('every reply quotes the conversation under it, nesting earlier quotes', () => {
  const prior = { date: '2026-10-03T14:34:31Z', from: 'Sierra Swinney <s@example.com>', text: 'Sounds good!\n\nOn Fri, Sean wrote:\n> Hi Sierra,' };
  const out = withQuotedThread('Hi Sierra,\n\nSean', prior);
  assert.match(out, /^Hi Sierra,\n\nSean\n\nOn Sat, 03 Oct 2026 14:34:31 UTC, Sierra Swinney <s@example\.com> wrote:\n> Sounds good!/);
  assert.match(out, /\n>> Hi Sierra,$/, 'an already-quoted line gains one more level');
  assert.equal(withQuotedThread('Hi', null), 'Hi');
  assert.equal(withQuotedThread('Hi', { date: 'x', from: 'y', text: '   ' }), 'Hi');
  const long = withQuotedThread('Hi', { date: '2026-10-03T00:00:00Z', from: 'y', text: 'a'.repeat(MAX_QUOTED_CHARS + 500) });
  assert.match(long, /\[earlier messages trimmed\]$/);
});

test('the agent\'s own Message-IDs are recognised, so its Sent copies are never read as Sean\'s reply', () => {
  // Real IDs from the Sent folder, 2026-10-03.
  for (const id of ['<mur6igqx.6ec5t4wg@realskincare.com>', '<mushnym2.1kcz5soh@realskincare.com>']) assert.equal(isAgentMessageId(id), true, id);
  for (const id of ['<8a8bbb94464173106f7eaf47eb93c25562b195f21a99bbd4@smtp.hushmail.com>', '<5F2A9C1E-3B4D-4E8F-9A21-7C6D8E9F0A1B@realskincare.com>', '', null]) assert.equal(isAgentMessageId(id), false, String(id));
});

test('a due email held by a gate is reported with its kind, reason and when it lifts', () => {
  // 2026-10-04: welcome sent 46h earlier, nudge1 due (delivered 6 days ago). The
  // run said "Nothing to do" while it was holding the nudge.
  const welcomeAt = iso(NOW - 46 * 3_600_000);
  const st = { creators: { 'lori@example.com': { sent: { welcome: welcomeAt }, lastScheduledAt: welcomeAt } } };
  const p = planScheduled(roster([order()]), st, { now: NOW });
  assert.equal(p.sends.length, 0);
  assert.equal(p.suppressed.length, 1);
  const [h] = p.suppressed;
  assert.equal(h.kind, 'nudge1');
  assert.match(h.reason, /emailed recently/);
  assert.equal(h.until, iso(Date.parse(welcomeAt) + 48 * 3_600_000));
});

test('a recently-emailed creator with nothing due is NOT listed as held', () => {
  const at = iso(NOW - 3_600_000);
  const st = { creators: { 'lori@example.com': { sent: { welcome: at, nudge1: at }, lastScheduledAt: at } } };
  const p = planScheduled(roster([order()]), st, { now: NOW });
  assert.equal(p.sends.length, 0);
  assert.deepEqual(p.suppressed, []);
});

test('opted-out creators are never listed as held', () => {
  const st = { creators: { 'lori@example.com': { optedOut: true } } };
  assert.deepEqual(planScheduled(roster([order()]), st, { now: NOW }).suppressed, []);
});
