import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPressOutreach } from '../../agents/press-outreach/index.js';
import { newDraft, approveDraft } from '../../lib/press-drafts.js';

// FAKE DATA ONLY: invented people on example.com.
const NOW = Date.parse('2026-10-06T18:00:00Z');

const contact = (id, pitchOver = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-10-01', concept: 'intro', outcome: 'sent', subject: 'Coconut cream', message_id: `<${id}@realskincare.com>`, references: [], last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
});

function world({ replies = [], drafts = [], imapError = null, contacts = null } = {}) {
  const calls = { send: [], savedDrafts: [] };
  const disk = new Map(drafts.map((d) => [d.id, d]));
  const opts = {
    apply: true, now: NOW, config: { enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10 },
    book: { contacts: contacts || [contact('jane'), contact('sam')] },
    state: { sends: [], processed: [], escalated: {} }, drafts, postalAddress: '1 Example Way, Testville, WY 00000',
    readReplies: async () => { if (imapError) throw imapError; return replies; },
    readSent: async () => [],
    send: async (m) => { calls.send.push(m); return { messageId: `<s${calls.send.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: (b) => { opts.book = b; }, saveState: () => {},
    saveDraft: (d) => { calls.savedDrafts.push(d); disk.set(d.id, d); }, readDraft: (id) => disk.get(id) || null,
    escalate: async () => {}, tellSean: async () => {}, onAddress: async () => {},
    graphql: async () => { throw new Error('unexpected Shopify call'); },
    confirmReply: async () => true, sleep: async () => {}, reportError: async () => {}, log: () => {},
  };
  return { opts, calls };
}

const followup = (id, n, over = {}) => approveDraft(newDraft({
  kind: 'followup', n, contactId: id, to: `${id}@example.com`, subject: 'Re: Coconut cream',
  text: `Hi ${id},\n\nYour cold weather list made me think of our Rose Petal lotion. Would a bottle help your next one?\n\nSean`,
  inReplyTo: `<${id}@realskincare.com>`, references: [`<${id}@realskincare.com>`], concept: 'intro', now: NOW - 3600e3, ...over,
}), { now: NOW - 1800e3 });

test('a due follow-up is NOT sent by the 30-minute run without an approved draft', async () => {
  const { opts, calls } = world();
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.send, []);
  assert.deepEqual(r.followUps, []);
  for (const c of opts.book.contacts) assert.equal(c.pitches[0].follow_ups_sent, 0);
});

test('an approved followup sends threaded under the pitch and sets follow_ups_sent = max(existing, n)', async () => {
  const { opts, calls } = world({ drafts: [followup('jane', 2)], contacts: [contact('jane', { follow_ups_sent: 1 })] });
  const r = await runPressOutreach(opts);
  assert.equal(calls.send.length, 1);
  const m = calls.send[0];
  assert.equal(m.to, 'jane@example.com');
  assert.equal(m.subject, 'Re: Coconut cream');
  assert.equal(m.inReplyTo, '<jane@realskincare.com>');
  assert.ok(m.references.includes('<jane@realskincare.com>'));
  const p = opts.book.contacts[0].pitches[0];
  assert.equal(p.follow_ups_sent, 2);
  assert.equal(p.last_sent_at, new Date(NOW).toISOString());
  assert.equal(calls.savedDrafts.at(-1).status, 'sent');
  assert.equal(opts.state.sends[0].kind, 'followup');
  assert.deepEqual(r.followUps.map((f) => [f.id, f.n]), [['jane', 2]]);
});

test('a first follow-up never lowers a count already at 2 (redrafted September bumps)', async () => {
  const { opts, calls } = world({ drafts: [followup('jane', 1)], contacts: [contact('jane', { follow_ups_sent: 2 })] });
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 1);
  assert.equal(opts.book.contacts[0].pitches[0].follow_ups_sent, 2);
});

test('an approved followup expires, unsent, once the writer replied ("thread moved on")', async () => {
  const reply = { from: 'jane@example.com', messageId: '<r-jane>', text: "I'm going to pass at this time.", fullText: "I'm going to pass at this time.", subject: 'Re: Coconut cream', references: ['<jane@realskincare.com>'], date: '2026-10-05T10:00:00Z', emojiReaction: false, autoSubmitted: false };
  const { opts, calls } = world({ replies: [reply], drafts: [followup('jane', 1)] });
  const r = await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  const saved = calls.savedDrafts.find((d) => d.kind === 'followup');
  assert.equal(saved.status, 'expired');
  assert.equal(saved.expired_reason, 'thread moved on');
  assert.ok(r.expired.some((e) => e.reason === 'thread moved on'));
});

test('an approved followup is held, still approved, while IMAP is down', async () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const { opts, calls } = world({ imapError: err, drafts: [followup('jane', 1)] });
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.send, []);
  assert.ok(!calls.savedDrafts.some((d) => d.kind === 'followup'));
  assert.ok(r.skipped.some((s) => /followup held/.test(s.reason)));
});

// ── drafting (--draft) and --redraft-bumps ──
import { runDrafting, runRedraftBumps, findOriginalPitch } from '../../agents/press-outreach/index.js';
import { markSent } from '../../lib/press-drafts.js';

const DNOW = Date.parse('2026-10-07T14:20:00Z');
const OPT = 'If this isn\'t a fit, just reply "no thanks" and I won\'t follow up.';
const FACTS = { brand: { facts: ['Handmade in small batches, made in the USA'] }, products: { lotion: { name: 'Body Lotion', format: 'squeeze bottle', price: '$30', base_ingredients: ['purified spring water', 'organic virgin coconut oil'], scents: ['Pure Unscented', 'Rose Petal'], facts: [] } } };
const ARTICLE_HTML = '<html><body><h1>Hand creams for cold weather</h1><p>Cracked knuckles are the first sign that winter has arrived, and a thicker cream helps more than you would think. We tested twelve tubes over three weeks in a drafty office and kept notes on how each one felt after washing up.</p></body></html>';

const writer = (id, pitchOver = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Writer`, status: 'active', domains: [`${id}.example.com`],
  channels: [{ type: 'email', address: `${id}@${id}.example.com`, verified: true, source: 'published' }],
  pitches: [{ date: '2026-10-01', concept: 'pitch-2026-10', products: ['lotion'], outcome: 'sent', subject: 'Coconut lotion for your roundup', message_id: `<${id}-p@realskincare.com>`, references: [], last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, source: 'pr-target', target_url: `https://${id}.example.com/best-lotion`, draft_id: `20261001-${id}-pitch`, ...pitchOver }],
});
const sentPitch = (id) => markSent(approveDraft(newDraft({ kind: 'pitch', contactId: id, to: `${id}@${id}.example.com`, subject: 'Coconut lotion for your roundup', text: `Hi ${id},\n\nYour roundup said dry winter skin needs a richer lotion. Our Body Lotion is made with organic virgin coconut oil.\n\nSean\n\n${OPT}\nReal Skin Care, 1 Example St`, concept: 'pitch-2026-10', products: ['lotion'], now: Date.parse('2026-10-01T10:00:00Z') }), { now: Date.parse('2026-10-01T11:00:00Z') }), { now: Date.parse('2026-10-01T17:00:00Z'), messageId: `<${id}-p@realskincare.com>` });

const fetchArticle = async (url) => {
  if (/\/author\//.test(url)) {
    const host = new URL(url).hostname;
    return { outcome: 'ok', html: `<a href="https://${host}/best-lotion">old</a><a href="https://${host}/2026/hand-creams-cold-weather">new</a>` };
  }
  if (/hand-creams/.test(url)) return { outcome: 'ok', html: ARTICLE_HTML };
  return { outcome: 'ok', html: '<p>A long article about lotion.</p>' };
};
const goodGenerate = async (prompt) => {
  const name = /writing a short personal note to (\w+)/.exec(prompt)[1];
  return JSON.stringify({
    body: `${name}, your line that "cracked knuckles are the first sign that winter has arrived" stuck with me. Our Body Lotion comes in Pure Unscented and Rose Petal. Would a bottle help your next cold weather list?`,
    article_quote: 'cracked knuckles are the first sign that winter has arrived',
  });
};

function draftHarness(over = {}) {
  const saved = { drafts: [], states: [] };
  const args = {
    apply: true, now: DNOW, deadline: DNOW + 3600e3, clock: () => DNOW,
    config: { queueTarget: 3, editorialShare: 0.7, hunterUsageStop: 0.8 },
    book: { version: 1, contacts: [writer('sam')] },
    state: { sends: [], processed: [], escalated: {} },
    drafts: [sentPitch('sam')],
    prTargets: { pitch_targets: [{ domain: 'sam.example.com', author_url: 'https://sam.example.com/author/sam' }] },
    linkGap: { opportunities: [] },
    pressFacts: FACTS, postalAddress: '1 Example St',
    findAddress: async () => ({ address: null, reason: 'none', spentHunter: 0 }),
    fetchArticle, generate: goodGenerate,
    draftPitch: async () => ({ ok: false, reason: 'not under test' }),
    saveBook: () => {}, saveDraft: (d) => saved.drafts.push(d), saveState: (s) => saved.states.push(JSON.parse(JSON.stringify(s))),
    log: () => {},
    ...over,
  };
  return { args, saved };
}

test('--draft writes a followup draft for a due thread, threaded under the pitch, before any pitch', async () => {
  const { args, saved } = draftHarness();
  const r = await runDrafting(args);
  assert.equal(r.followUps.length, 1, JSON.stringify(r.followUpFailed));
  const d = saved.drafts.find((x) => x.kind === 'followup');
  assert.ok(d);
  assert.equal(d.n, 1);
  assert.match(d.id, /^20261007-sam-followup1$/);
  assert.equal(d.status, 'pending');
  assert.equal(d.to, 'sam@sam.example.com');
  assert.equal(d.subject, 'Re: Coconut lotion for your roundup');
  assert.equal(d.in_reply_to, '<sam-p@realskincare.com>');
  assert.deepEqual(d.references, ['<sam-p@realskincare.com>']);
  assert.equal(d.article_url, 'https://sam.example.com/2026/hand-creams-cold-weather', 'the newest piece, never the pitched one');
  assert.equal(d.article_quote, 'cracked knuckles are the first sign that winter has arrived');
  assert.equal(d.original_source, 'draft');
  assert.match(d.text, /^Hi Sam,\n\n/);
  assert.match(d.text, /\n\nSean$/);
  assert.ok(!/coconut oil/i.test(d.new_fact || ''), 'the new fact is not one the pitch already used');
  assert.equal(saved.drafts[0].kind, 'followup', 'follow-ups are drafted first');
});

test('--draft skips a contact with an open followup or bump draft', async () => {
  for (const kind of ['followup', 'bump']) {
    const open = { id: `20261005-sam-${kind}${kind === 'followup' ? 1 : ''}`, kind, n: 1, contact_id: 'sam', status: 'pending', created_at: '2026-10-05T00:00:00Z', to: 'sam@sam.example.com' };
    const { args, saved } = draftHarness({ drafts: [sentPitch('sam'), open] });
    const r = await runDrafting(args);
    assert.equal(r.followUps.length, 0);
    assert.ok(!saved.drafts.some((d) => d.kind === 'followup'));
    assert.ok(r.followUpSkipped.some((s) => /already waiting/.test(s.reason)));
  }
});

test('--draft reads the Sent folder for a September pitch with no draft file; none at all fails with the reason and counts an attempt', async () => {
  const sept = writer('ann', { date: '2026-09-21', last_sent_at: '2026-09-21T17:00:00Z', draft_id: undefined, message_id: '<hand-ann@hushmail>' });
  let asked = null;
  const sentBodies = async (q) => { asked = q; return [{ to: ['ann@ann.example.com'], subject: 'Coconut lotion for your roundup', date: '2026-09-21T17:00:00.000Z', messageId: '<hand-ann@hushmail>', text: 'Hi Ann, our lotion pitch body by hand.' }]; };
  const { args, saved } = draftHarness({ book: { version: 1, contacts: [sept] }, drafts: [], readSentBodies: sentBodies, prTargets: { pitch_targets: [] } });
  const goodNoArticle = async (prompt) => JSON.stringify({ body: 'Ann, our Body Lotion also comes in Rose Petal, which might suit a winter gift list. Would a bottle be useful?', article_quote: null });
  args.generate = goodNoArticle;
  const r = await runDrafting(args);
  assert.deepEqual(asked.recipients, ['ann@ann.example.com']);
  assert.equal(r.followUps.length, 1, JSON.stringify(r.followUpFailed));
  assert.equal(saved.drafts.find((d) => d.kind === 'followup').original_source, 'sent-folder');

  const none = draftHarness({ book: { version: 1, contacts: [sept] }, drafts: [], readSentBodies: async () => [], prTargets: { pitch_targets: [] } });
  const r2 = await runDrafting(none.args);
  assert.equal(r2.followUps.length, 0);
  assert.match(r2.followUpFailed[0].reason, /no copy of the original pitch/);
  assert.equal(none.args.state.followup_attempts['ann:2026-09-21:1'], 1);
});

test('--draft: two follow-ups opening with the same sentence in one run: the second costs its retry and fails', async () => {
  const same = async () => JSON.stringify({ body: 'Our Body Lotion comes in Rose Petal now. Would a bottle help your next list?', article_quote: null });
  const { args, saved } = draftHarness({ book: { version: 1, contacts: [writer('sam'), writer('kim')] }, drafts: [sentPitch('sam'), sentPitch('kim')], generate: same, prTargets: { pitch_targets: [] } });
  const r = await runDrafting(args);
  assert.equal(r.followUps.length, 1);
  assert.equal(r.followUpFailed.length, 1);
  assert.match(r.followUpFailed[0].reason, /opener-collision/);
  assert.equal(saved.drafts.filter((d) => d.kind === 'followup').length, 1);
});

test('--draft: follow-ups count toward the queue target', async () => {
  const { args } = draftHarness({ config: { queueTarget: 1, editorialShare: 0.7 } });
  let pitched = 0;
  args.draftPitch = async () => { pitched += 1; return { ok: false, reason: 'x' }; };
  const r = await runDrafting(args);
  assert.equal(r.followUps.length, 1);
  assert.equal(pitched, 0, 'the follow-up used the whole budget');
});

test('findOriginalPitch strips the opt-out and postal lines from a sent draft', () => {
  const o = findOriginalPitch({ contact: writer('sam'), pitch: writer('sam').pitches[0], drafts: [sentPitch('sam')] });
  assert.equal(o.source, 'draft');
  assert.ok(!o.body.includes('no thanks'));
  assert.ok(o.body.includes('richer lotion'));
});

// --redraft-bumps
const oldBump = (id, status = 'pending') => {
  const b = newDraft({ kind: 'bump', contactId: id, to: `${id}@${id}.example.com`, subject: 'Re: Coconut lotion for your roundup', text: `Hi,\n\nBumping this in case it got buried.\n\nSean`, inReplyTo: `<hand-${id}@hushmail>`, references: [`<hand-${id}@hushmail>`], concept: 'intro', now: Date.parse('2026-10-04T10:00:00Z') });
  return status === 'approved' ? approveDraft(b, { now: Date.parse('2026-10-04T11:00:00Z') }) : b;
};
const sept = (id) => writer(id, { date: '2026-09-21', last_sent_at: '2026-09-21T17:00:00Z', draft_id: undefined, message_id: `<hand-${id}@hushmail>`, follow_ups_sent: 2 });
const septSent = (id) => ({ to: [`${id}@${id}.example.com`], subject: 'Coconut lotion for your roundup', date: '2026-09-21T17:00:00.000Z', messageId: `<hand-${id}@hushmail>`, text: `Hi ${id}, the September pitch body.` });

function redraftWorld(over = {}) {
  const calls = { moved: [], saved: [], restored: [], order: [], generated: 0 };
  const args = {
    apply: true, now: DNOW, book: { contacts: [sept('jane'), sept('lee')] },
    drafts: [oldBump('jane'), oldBump('lee', 'approved')],
    pressFacts: FACTS, authorUrls: new Map(), fetchPage: fetchArticle,
    readSentBodies: async () => [septSent('jane'), septSent('lee')],
    generate: async (p) => { calls.generated += 1; return goodGenerate(p).then((j) => JSON.stringify({ ...JSON.parse(j), body: JSON.parse(j).body.replace(/, your line that "[^"]+" stuck with me/, ', a winter list idea'), article_quote: null })); },
    moveAside: (d) => { calls.order.push(`move:${d.id}`); calls.moved.push(d.id); return `/backups/oldbump-${d.id}.json`; },
    restore: (d) => calls.restored.push(d.id),
    saveDraft: (d) => { calls.order.push(`save:${d.id}`); calls.saved.push(d); },
    log: () => {},
    ...over,
  };
  return { args, calls };
}

test('--redraft-bumps moves every pending/approved bump aside and creates a followup n=1 on the same thread', async () => {
  const { args, calls } = redraftWorld();
  const r = await runRedraftBumps(args);
  assert.equal(r.redrafted.length, 2, JSON.stringify(r.failed));
  assert.deepEqual(calls.moved.sort(), ['20261004-jane-bump', '20261004-lee-bump']);
  for (const d of calls.saved) {
    assert.equal(d.kind, 'followup');
    assert.equal(d.n, 1);
    assert.equal(d.status, 'pending', 'a redraft waits for approval again');
    assert.equal(d.subject, 'Re: Coconut lotion for your roundup');
    assert.equal(d.in_reply_to, `<hand-${d.contact_id}@hushmail>`);
    assert.equal(d.original_source, 'sent-folder');
  }
  assert.ok(calls.order.indexOf('move:20261004-jane-bump') < calls.order.findIndex((x) => x.startsWith('save:') && x.includes('jane')), 'the bump is moved before the follow-up is saved');
});

test('--redraft-bumps dry run lists the plan and moves, saves and generates nothing', async () => {
  const { args, calls } = redraftWorld({ apply: false });
  const r = await runRedraftBumps(args);
  assert.equal(r.wouldRedraft.length, 2);
  assert.deepEqual(calls.moved, []);
  assert.deepEqual(calls.saved, []);
  assert.equal(calls.generated, 0);
});

test('--redraft-bumps keeps a bump whose follow-up fails, and puts it back if the save fails', async () => {
  const bad = redraftWorld({ generate: async () => JSON.stringify({ body: 'Just circling back here. Any thoughts?', article_quote: null }) });
  const r = await runRedraftBumps(bad.args);
  assert.equal(r.redrafted.length, 0);
  assert.equal(r.failed.length, 2);
  assert.deepEqual(bad.calls.moved, [], 'nothing moved when no follow-up was written');

  const boom = redraftWorld({ saveDraft: () => { throw new Error('disk full'); } });
  const r2 = await runRedraftBumps(boom.args);
  assert.equal(r2.failed.length, 2);
  assert.deepEqual(boom.calls.restored.sort(), ['20261004-jane-bump', '20261004-lee-bump']);
});
