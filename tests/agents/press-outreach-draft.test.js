import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDrafting, htmlToText, upsertProspectContact, makeFindAddress, renderDraftSummary, loadPressFacts } from '../../agents/press-outreach/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateContacts } from '../../lib/press-contacts.js';

// FAKE DATA ONLY: invented people on example domains.
const NOW = Date.parse('2026-10-05T14:20:00Z');
const CONFIG = { queueTarget: 3, editorialShare: 0.7, hunterUsageStop: 0.8 };

const row = (n) => ({
  domain: `outlet${n}.example.com`, author: `Writer${n} Person`, author_url: `https://outlet${n}.example.com/author/w${n}`,
  enrich_fetch: 'ok', pitch_url: `https://outlet${n}.example.com/best-lotion`, publication: `Outlet ${n}`,
  prompts: ['best natural lotion'], score: 10 - n,
});
const prTargets = (count) => ({ pitch_targets: Array.from({ length: count }, (_, i) => row(i + 1)) });
const emptyBook = () => ({ version: 1, contacts: [] });

function harness(over = {}) {
  const saved = { books: [], drafts: [], states: [] };
  const args = {
    apply: true,
    now: NOW,
    config: CONFIG,
    book: emptyBook(),
    state: { sends: [], processed: [], escalated: {} },
    drafts: [],
    prTargets: prTargets(4),
    linkGap: { opportunities: [] },
    pressFacts: { brand: { facts: [] }, products: {} },
    postalAddress: '1 Example St',
    findAddress: async (p) => ({ address: `${p.person.name.split(' ')[0].toLowerCase()}@${p.domain}`, source: `published:${p.person.authorUrl}`, verified: true, spentHunter: 0 }),
    fetchArticle: async () => ({ outcome: 'ok', html: '<html><script>var x=1</script><p>A long article about lotion.</p></html>' }),
    draftPitch: async ({ prospect, contact }) => ({ ok: true, draft: { subject: `Note for ${contact.name}`, text: `Hi ${contact.name}`, openerQuote: 'a long article about lotion', products: ['lotion'] } }),
    saveBook: (b) => saved.books.push(b),
    saveDraft: (d) => saved.drafts.push(d),
    saveState: (s) => saved.states.push(JSON.parse(JSON.stringify(s))),
    log: () => {},
    ...over,
  };
  return { args, saved };
}

test('queueTarget 3 with 1 pending draft makes exactly 2 drafts', async () => {
  const { args, saved } = harness({ drafts: [{ id: 'x', kind: 'pitch', status: 'pending', created_at: '2026-10-04T00:00:00Z', to: 'a@other.example.com' }] });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 2);
  assert.equal(saved.drafts.length, 2);
  for (const d of saved.drafts) {
    assert.equal(d.kind, 'pitch');
    assert.equal(d.status, 'pending');
    assert.equal(d.concept, 'pitch-2026-10');
    assert.equal(d.source, 'pr-target');
    assert.match(d.address_source, /^published:/);
  }
  const book = saved.books.at(-1);
  assert.ok(validateContacts(book).ok);
  const c = book.contacts.find((x) => x.id === 'writer1-person');
  assert.equal(c.status, 'active');
  assert.equal(c.kind, 'journalist');
  assert.deepEqual(c.domains, ['outlet1.example.com']);
  assert.deepEqual(c.outlets, ['Outlet 1']);
  assert.deepEqual(c.channels, [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 'published:https://outlet1.example.com/author/w1' }]);
});

test('a full queue drafts nothing', async () => {
  const pending = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, kind: 'pitch', status: i ? 'approved' : 'pending', created_at: '2026-10-04T00:00:00Z' }));
  const { args, saved } = harness({ drafts: pending });
  const r = await runDrafting(args);
  assert.equal(r.want, 0);
  assert.equal(saved.drafts.length, 0);
});

test('--limit overrides want', async () => {
  const { args, saved } = harness({ limit: 1 });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 1);
  assert.equal(saved.drafts.length, 1);
});

test('a prospect with no address creates an unverified contact and no draft', async () => {
  const { args, saved } = harness({
    prTargets: prTargets(1),
    findAddress: async () => ({ address: null, reason: 'hunter: accept_all', spentHunter: 2 }),
  });
  const r = await runDrafting(args);
  assert.equal(r.noAddress.length, 1);
  assert.equal(r.drafted.length, 0);
  assert.equal(saved.drafts.length, 0);
  assert.equal(r.hunterSpent, 2);
  const c = saved.books.at(-1).contacts[0];
  assert.equal(c.status, 'unverified');
  assert.deepEqual(c.channels, []);
  assert.ok(c.notes.some((n) => n.includes('https://outlet1.example.com/author/w1')));
  assert.ok(validateContacts(saved.books.at(-1)).ok);
});

test('a link-gap prospect with no address is skipped, no contact', async () => {
  const { args, saved } = harness({
    prTargets: { pitch_targets: [] },
    linkGap: { opportunities: [{ domain: 'gap.example.com', linking_url: 'https://gap.example.com/best-natural-lotions', competitors: ['rival.example.com'] }] },
    findAddress: async () => ({ address: null, reason: 'no published address; hunter unavailable' }),
  });
  const r = await runDrafting(args);
  assert.equal(r.skipped.length, 1);
  assert.equal(saved.books.length, 0);
  assert.equal(saved.drafts.length, 0);
});

test('a homepage-only link-gap row spends nothing: no fetch, no address lookup, no draft', async () => {
  let fetched = 0; let looked = 0;
  const { args, saved } = harness({
    prTargets: { pitch_targets: [] },
    linkGap: { opportunities: [{ domain: 'adlibrary.com', competitors: ["Schmidt's Naturals"] }] },
    fetchArticle: async () => { fetched += 1; return { outcome: 'ok', html: '<p>Save. Tag. Reuse. Build your swipe file.</p>' }; },
    findAddress: async () => { looked += 1; return { address: 'marketing@adlibrary.com', source: 'hunter' }; },
  });
  await runDrafting(args);
  assert.equal(fetched, 0);
  assert.equal(looked, 0);
  assert.equal(saved.drafts.length, 0);
});

test('a failed article fetch drafts nothing and counts an attempt; two attempts skip it', async () => {
  const { args, saved } = harness({ prTargets: prTargets(1), fetchArticle: async () => ({ outcome: 'blocked', html: null }) });
  const r = await runDrafting(args);
  assert.equal(r.failed.length, 1);
  assert.equal(saved.drafts.length, 0);
  assert.equal(saved.states.at(-1).draft_attempts['pr-target:outlet1.example.com'], 1);

  let looked = 0;
  const second = harness({
    prTargets: prTargets(1),
    state: { sends: [], processed: [], escalated: {}, draft_attempts: { 'pr-target:outlet1.example.com': 2 } },
    findAddress: async () => { looked += 1; return { address: null }; },
  });
  const r2 = await runDrafting(second.args);
  assert.equal(looked, 0);
  // Excluded from the pool, counted as dead, never reported as a skip (no daily notify).
  assert.equal(r2.skipped.length, 0);
  assert.equal(r2.dead, 1);
});

test('a draft failure is recorded with its reason and clears nothing', async () => {
  const { args, saved } = harness({ prTargets: prTargets(1), draftPitch: async () => ({ ok: false, reason: 'fabricated-opener: nope' }) });
  const r = await runDrafting(args);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].reason, /fabricated-opener/);
  assert.equal(saved.drafts.length, 0);
  assert.equal(saved.books.length, 0);
});

test('dry run saves nothing', async () => {
  const { args, saved } = harness({ apply: false });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 3);
  assert.equal(saved.books.length, 0);
  assert.equal(saved.drafts.length, 0);
  assert.equal(saved.states.length, 0);
});

test('htmlToText drops script and style and tags', () => {
  const t = htmlToText('<style>p{color:red}</style><script>alert(1)</script><p>Hello&nbsp;<b>world</b> &amp; more</p>');
  assert.equal(t, 'Hello world & more');
});

test('upsert: an existing contact keeps its status and gains the email only if absent', () => {
  const book = { contacts: [{ id: 'writer1-person', name: 'Writer1 Person', status: 'unverified', domains: ['outlet1.example.com'], channels: [], pitches: [] }] };
  const prospect = { source: 'pr-target', domain: 'outlet1.example.com', person: { name: 'Writer1 Person' }, publication: 'Outlet 1' };
  const a = upsertProspectContact(book, prospect, { address: 'w1@outlet1.example.com', source: 'published:https://outlet1.example.com', today: '2026-10-05' });
  assert.equal(a.contactId, 'writer1-person');
  assert.equal(a.created, false);
  const c = a.book.contacts[0];
  // M4: gaining a verified email channel promotes unverified to active.
  assert.equal(c.status, 'active');
  assert.equal(c.channels.length, 1);
  const b = upsertProspectContact(a.book, prospect, { address: 'w1@outlet1.example.com', source: 'other', today: '2026-10-05' });
  assert.equal(b.book.contacts[0].channels.length, 1);
});

test('upsert: same name on a different outlet is a different person, suffixed by domain stem', () => {
  const book = { contacts: [{ id: 'writer1-person', name: 'Writer1 Person', status: 'active', domains: ['outlet1.example.com'], channels: [], pitches: [] }] };
  const prospect = { source: 'pr-target', domain: 'othermag.com', person: { name: 'Writer1 Person' }, publication: 'Other Mag' };
  const r = upsertProspectContact(book, prospect, { address: 'w1@othermag.com', source: 'published:x', today: '2026-10-05' });
  assert.equal(r.contactId, 'writer1-person-othermag');
  assert.equal(r.book.contacts.length, 2);
  assert.ok(validateContacts(r.book).ok);
});

test('upsert: a link-gap outlet becomes kind outlet named by publication or domain', () => {
  const prospect = { source: 'link-gap', domain: 'gap.example.com', person: null, publication: null };
  const r = upsertProspectContact({ contacts: [] }, prospect, { address: 'editor@gap.example.com', source: 'published:https://gap.example.com/contact', today: '2026-10-05' });
  const c = r.book.contacts[0];
  assert.equal(c.kind, 'outlet');
  assert.equal(c.name, 'gap.example.com');
  assert.equal(c.id, 'gap-example-com');
  assert.equal(c.status, 'active');
});

// ── fix round 1 ──
const existingWithEmail = (over = {}) => ({
  id: 'writer1-person', name: 'Writer1 Person', kind: 'journalist', status: 'active',
  domains: ['oldmag.example.com'], outlets: ['Old Mag'],
  channels: [{ type: 'email', address: 'writer1@oldmag.example.com', verified: true, source: 'published:https://oldmag.example.com' }],
  pitches: [], ...over,
});
// name+domain match needs the domain; same person found on outlet1 via the book:
const sameDomain = (over = {}) => existingWithEmail({ domains: ['oldmag.example.com', 'outlet1.example.com'], ...over });

test('an existing contact with an email on file is drafted to THAT address, finder never called', async () => {
  let looked = 0;
  const { args, saved } = harness({
    prTargets: prTargets(1),
    book: { version: 1, contacts: [sameDomain()] },
    findAddress: async () => { looked += 1; return { address: 'other@outlet1.example.com', source: 'hunter:verified:x', spentHunter: 2 }; },
  });
  const r = await runDrafting(args);
  assert.equal(looked, 0);
  assert.equal(r.hunterSpent, 0);
  assert.equal(r.drafted.length, 1);
  assert.equal(saved.drafts[0].to, 'writer1@oldmag.example.com');
  const c = saved.books.at(-1).contacts[0];
  assert.equal(c.channels.length, 1);
});

test('a found address that belongs to a DIFFERENT existing contact is skipped with an attempt', async () => {
  const other = { id: 'someone-else', name: 'Someone Else', status: 'active', domains: ['x.example.com'], channels: [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 's' }], pitches: [] };
  const { args, saved } = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [other] } });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 0);
  assert.equal(saved.drafts.length, 0);
  assert.match(r.skipped[0].reason, /belongs to someone-else/);
  assert.equal(saved.states.at(-1).draft_attempts['pr-target:outlet1.example.com'], 1);
});

test('upsert never appends a second email channel; it extends domains when drafting', () => {
  const book = { contacts: [sameDomain()] };
  const prospect = { source: 'pr-target', domain: 'outlet1.example.com', person: { name: 'Writer1 Person' }, publication: 'Outlet 1' };
  const r = upsertProspectContact(book, prospect, { address: 'new@outlet1.example.com', source: 'x', today: '2026-10-05' });
  assert.equal(r.book.contacts[0].channels.length, 1);
  const third = upsertProspectContact({ contacts: [existingWithEmail({ domains: ['outlet1.example.com'] })] }, { ...prospect, domain: 'outlet1.example.com' }, { address: 'writer1@oldmag.example.com', source: 'x', today: '2026-10-05' });
  assert.equal(third.book.contacts[0].channels.length, 1);
});

test('drafting for an existing contact matched by name on a known domain extends its domains', async () => {
  const c0 = existingWithEmail({ channels: [], domains: ['outlet1.example.com'] });
  const { args, saved } = harness({
    prTargets: prTargets(1),
    book: { version: 1, contacts: [c0] },
  });
  await runDrafting(args);
  const c = saved.books.at(-1).contacts[0];
  assert.equal(c.channels.length, 1);
  assert.deepEqual(c.domains, ['outlet1.example.com']);
});

test('existing contact found by EMAIL on a new domain gets the domain added', async () => {
  const c0 = existingWithEmail({ channels: [], domains: ['oldmag.example.com'] });
  c0.channels = [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 's' }];
  // same name, same address, other outlet -> the same person (owner by email)
  const { args, saved } = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [c0] } });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 1);
  assert.deepEqual(saved.books.at(-1).contacts[0].domains, ['oldmag.example.com', 'outlet1.example.com']);
});

for (const [label, over, st] of [
  ['escalated', {}, { escalated: { 'writer1-person': { at: '2026-10-01' } } }],
  ['open conversation', { pitches: [{ date: '2026-06-01', concept: 'c', outcome: 'replied' }] }, {}],
]) {
  test(`existing contact with ${label} is skipped before the finder, NO attempt (temporary)`, async () => {
    let looked = 0;
    const { args, saved } = harness({
      prTargets: prTargets(1),
      book: { version: 1, contacts: [sameDomain(over)] },
      state: { sends: [], processed: [], escalated: {}, ...st },
      findAddress: async () => { looked += 1; return { address: null }; },
    });
    const r = await runDrafting(args);
    assert.equal(looked, 0);
    assert.equal(r.drafted.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(saved.states.at(-1)?.draft_attempts?.['pr-target:outlet1.example.com'], undefined);
  });
}

test('existing contact with a non-pitchable status is skipped before the finder, attempt recorded', async () => {
  let looked = 0;
  const contact = sameDomain({ status: 'left_outlet', name: 'Someone Gone' });
  contact.domains = ['outlet1.example.com'];
  const { args, saved } = harness({
    prTargets: { pitch_targets: [{ ...row(1), author: 'Writer1 Person' }] },
    book: { version: 1, contacts: [{ ...contact, name: 'Writer1 Person', status: 'inactive' }] },
    findAddress: async () => { looked += 1; return { address: null }; },
  });
  const r = await runDrafting(args);
  // buildProspects itself drops a non-pitchable same-name contact; either way nothing is spent.
  assert.equal(looked, 0);
  assert.equal(r.drafted.length, 0);
  // a found-by-email contact with bad status: finder ran, but the skip records an attempt
  let found = 0;
  const owner = { id: 'dnc', name: 'Other Name', status: 'do_not_contact', domains: ['z.example.com'], channels: [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 's' }], pitches: [] };
  const h2 = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [owner] }, findAddress: async (p) => { found += 1; return { address: 'writer1@outlet1.example.com', source: 'published:x', spentHunter: 0 }; } });
  const r2 = await runDrafting(h2.args);
  assert.equal(found, 1);
  assert.equal(r2.drafted.length, 0);
  assert.equal(h2.saved.states.at(-1).draft_attempts['pr-target:outlet1.example.com'], 1);
  void saved;
});

test('dead keys do not clog the pool: live prospects behind them still draft, dead ones are not reported', async () => {
  const dead = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`pr-target:outlet${n}.example.com`, 2]));
  const { args } = harness({
    limit: 1, prTargets: prTargets(8),
    state: { sends: [], processed: [], escalated: {}, draft_attempts: dead },
  });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 1);
  assert.equal(r.drafted[0].domain, 'outlet7.example.com');
  assert.equal(r.skipped.length, 0);
  assert.equal(r.dead, 6);
});

test('two prospects resolving to the same contact make only one draft this run', async () => {
  const { args, saved } = harness({
    prTargets: { pitch_targets: [{ ...row(1), author: 'Same Person' }, { ...row(2), author: 'Same Person' }] },
    findAddress: async () => ({ address: 'same@shared.example.com', source: 'published:x', spentHunter: 0 }),
  });
  const r = await runDrafting(args);
  assert.equal(saved.drafts.length, 1);
  assert.equal(r.drafted.length, 1);
});

test('a no-address saveBook failure still counts the attempt', async () => {
  const { args, saved } = harness({
    prTargets: prTargets(1),
    findAddress: async () => ({ address: null, reason: 'none' }),
    saveBook: () => { throw new Error('disk full'); },
  });
  const r = await runDrafting(args);
  assert.equal(r.failed.length, 1);
  assert.equal(saved.states.at(-1).draft_attempts['pr-target:outlet1.example.com'], 1);
});

test('hunterSpent survives a finder that throws with partial spend', async () => {
  const { args } = harness({
    prTargets: prTargets(1),
    findAddress: async () => { const e = new Error('boom'); e.spentHunter = 1; throw e; },
  });
  const r = await runDrafting(args);
  assert.equal(r.hunterSpent, 1);
});

test('an after-finder temporary block caches the found address, no attempt; the next run reuses it with zero finder calls', async () => {
  const c0 = existingWithEmail({ channels: [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 's' }], pitches: [{ date: '2026-09-20', concept: 'c', outcome: 'declined' }] });
  let calls = 0;
  const finder = async () => { calls += 1; return { address: 'writer1@outlet1.example.com', source: 'hunter:verified:2026-10-05', spentHunter: 2 }; };
  const first = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [c0] }, findAddress: finder });
  const r = await runDrafting(first.args);
  assert.equal(calls, 1);
  assert.equal(r.drafted.length, 0);
  assert.match(r.skipped[0].reason, /pitched within 60 days/);
  const st = first.saved.states.at(-1);
  assert.equal(st.draft_attempts['pr-target:outlet1.example.com'], undefined);
  assert.deepEqual(st.found_addresses['pr-target:outlet1.example.com'], { address: 'writer1@outlet1.example.com', source: 'hunter:verified:2026-10-05', at: '2026-10-05T14:20:00.000Z' });

  // Next run, still in cooldown: no finder call, still no attempt.
  const second = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [c0] }, findAddress: finder, state: st });
  const r2 = await runDrafting(second.args);
  assert.equal(calls, 1);
  assert.equal(r2.hunterSpent, 0);
  assert.equal(r2.drafted.length, 0);

  // After the cooldown: drafted from the cached address, still no finder call, cache cleared.
  const later = Date.parse('2026-11-25T14:20:00Z');
  const third = harness({ now: later, prTargets: prTargets(1), book: { version: 1, contacts: [c0] }, findAddress: finder, state: JSON.parse(JSON.stringify(st)) });
  const r3 = await runDrafting(third.args);
  assert.equal(calls, 1);
  assert.equal(r3.drafted.length, 1);
  assert.equal(third.saved.drafts[0].to, 'writer1@outlet1.example.com');
  assert.equal(third.saved.drafts[0].address_source, 'hunter:verified:2026-10-05');
  assert.equal(third.saved.states.at(-1).found_addresses['pr-target:outlet1.example.com'], undefined);
});

test('a contact pitched 50 days ago is skipped without an attempt and drafted once the cooldown passes', async () => {
  // Matched by name, on another outlet's domain list plus this one; the last pitch is on a different
  // domain, so buildProspects' own domain cooldown does not see it.
  const c0 = existingWithEmail({ domains: ['oldmag.example.com', 'outlet1.example.com'], pitches: [{ date: '2026-08-16', concept: 'c', outcome: 'declined' }] });
  let looked = 0;
  const finder = async () => { looked += 1; return { address: null }; };
  const first = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [c0] }, findAddress: finder });
  const r = await runDrafting(first.args);
  assert.equal(r.drafted.length, 0);
  assert.equal(r.skipped.length + r.queueSkipped >= 1, true);
  assert.equal(first.saved.states.at(-1)?.draft_attempts?.['pr-target:outlet1.example.com'], undefined);

  const later = Date.parse('2026-10-20T14:20:00Z');
  const second = harness({ now: later, prTargets: prTargets(1), book: { version: 1, contacts: [c0] }, findAddress: finder, state: { sends: [], processed: [], escalated: {}, draft_attempts: {} } });
  const r2 = await runDrafting(second.args);
  assert.equal(r2.drafted.length, 1);
  assert.equal(second.saved.drafts[0].to, 'writer1@oldmag.example.com');
  assert.equal(looked, 0);
});

test('a same-name owner found by email with status do_not_contact is skipped, attempt recorded, no draft', async () => {
  const owner = existingWithEmail({ status: 'do_not_contact', domains: ['oldmag.example.com'], channels: [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 's' }] });
  const { args, saved } = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [owner] } });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 0);
  assert.equal(saved.drafts.length, 0);
  assert.match(r.skipped[0].reason, /status do_not_contact/);
  assert.equal(saved.states.at(-1).draft_attempts['pr-target:outlet1.example.com'], 1);
});

// ── final review fixes (PR 2) ──

test('M4: upsert never promotes a non-pitchable status, and keeps an existing channel-less unverified when no address', () => {
  const prospect = { source: 'pr-target', domain: 'outlet1.example.com', person: { name: 'Writer1 Person' }, publication: 'Outlet 1' };
  const left = { contacts: [{ id: 'writer1-person', name: 'Writer1 Person', status: 'inactive', domains: ['outlet1.example.com'], channels: [], pitches: [] }] };
  assert.equal(upsertProspectContact(left, prospect, { address: 'w1@outlet1.example.com', source: 's', today: '2026-10-05' }).book.contacts[0].status, 'inactive');
  const unv = { contacts: [{ id: 'writer1-person', name: 'Writer1 Person', status: 'unverified', domains: ['outlet1.example.com'], channels: [], pitches: [] }] };
  assert.equal(upsertProspectContact(unv, prospect, { address: null, reason: 'x', today: '2026-10-05' }).book.contacts[0].status, 'unverified');
});

test('M4: drafting to an unverified contact that gains a verified email makes it active', async () => {
  const c0 = { id: 'writer1-person', name: 'Writer1 Person', kind: 'journalist', status: 'unverified', domains: ['outlet1.example.com'], outlets: ['Outlet 1'], channels: [], pitches: [], notes: ['2026-10-01: no published or verified address; try by hand: x'] };
  const { args, saved } = harness({ prTargets: prTargets(1), book: { version: 1, contacts: [c0] } });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 1);
  const c = saved.books.at(-1).contacts[0];
  assert.equal(c.status, 'active');
  assert.ok(validateContacts(saved.books.at(-1)).ok);
});

const contactOn = (domains, over = {}) => ({
  id: 'writer1-person', name: 'Writer1 Person', kind: 'journalist', status: 'active', domains, outlets: ['Outlet 1'],
  channels: [{ type: 'email', address: 'writer1@outlet1.example.com', verified: true, source: 'published:x' }], pitches: [], ...over,
});

for (const [label, draft] of [
  ['pending', { status: 'pending' }],
  ['approved', { status: 'approved', approved_at: '2026-10-04T15:00:00Z' }],
  ['rejected 10 days ago', { status: 'rejected', rejected_at: '2026-09-25T10:00:00Z' }],
]) {
  test(`I1/I2: a contact with a ${label} draft (reached via a second domain) gets no new draft, no fetch, no finder, no attempt`, async () => {
    let fetched = 0; let looked = 0;
    // The writer is on file under outlet1, and now shows up as the author on outlet2.
    const book = { version: 1, contacts: [contactOn(['outlet1.example.com', 'outlet2.example.com'])] };
    const existing = { id: '20260920-writer1-person-pitch', kind: 'pitch', contact_id: 'writer1-person', to: 'writer1@outlet1.example.com', target_url: 'https://outlet1.example.com/best-lotion', created_at: '2026-09-20T14:20:00Z', ...draft };
    const { args, saved } = harness({
      prTargets: { pitch_targets: [{ ...row(2), author: 'Writer1 Person' }] },
      book, drafts: [existing],
      fetchArticle: async () => { fetched += 1; return { outcome: 'ok', html: '<p>x y z</p>' }; },
      findAddress: async () => { looked += 1; return { address: null, spentHunter: 0 }; },
    });
    const r = await runDrafting(args);
    assert.equal(r.drafted.length, 0);
    assert.equal(saved.drafts.length, 0);
    assert.equal(fetched, 0, 'no article fetch for a blocked contact');
    assert.equal(looked, 0, 'no finder spend for a blocked contact');
    assert.match(r.skipped[0].reason, /draft/);
    assert.equal(saved.states.at(-1)?.draft_attempts?.['pr-target:outlet2.example.com'] ?? 0, 0);
  });
}

test('I1: a contact whose draft was rejected 61 days ago can be drafted again', async () => {
  const book = { version: 1, contacts: [contactOn(['outlet1.example.com', 'outlet2.example.com'])] };
  const existing = { id: '20260805-writer1-person-pitch', kind: 'pitch', contact_id: 'writer1-person', to: 'writer1@outlet1.example.com', target_url: 'https://outlet1.example.com/x', created_at: '2026-08-05T14:20:00Z', status: 'rejected', rejected_at: '2026-08-05T15:00:00Z' };
  const { args } = harness({ prTargets: { pitch_targets: [{ ...row(2), author: 'Writer1 Person' }] }, book, drafts: [existing] });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 1);
});

test('I2: an address found by the finder whose owner already has an approved draft is not drafted again', async () => {
  // Owner is matched by EMAIL after the finder, so the check must apply there too.
  // Their address is on a personal domain, so the outlet1 prospect is not
  // already filtered by the draft's domain: only the contact check can stop it.
  const owner = contactOn(['oldmag.example.com'], { channels: [{ type: 'email', address: 'writer1@personal.example.com', verified: true, source: 'published:x' }] });
  const existing = { id: '20261005-writer1-person-pitch', kind: 'pitch', contact_id: 'writer1-person', to: 'writer1@personal.example.com', target_url: 'https://oldmag.example.com/x', created_at: '2026-10-05T09:00:00Z', status: 'approved', approved_at: '2026-10-05T10:00:00Z' };
  const { args, saved } = harness({
    prTargets: prTargets(1), book: { version: 1, contacts: [owner] }, drafts: [existing],
    findAddress: async () => ({ address: 'writer1@personal.example.com', source: 'published:https://outlet1.example.com/author/w1', spentHunter: 0 }),
  });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 0);
  assert.equal(saved.drafts.length, 0);
  assert.match(r.skipped[0].reason, /approved draft/);
});

test('I3: a no-address editorial prospect spends Hunter on day 1 only; day 2 runs the free pass with zero Hunter calls', async () => {
  const calls = { account: 0, finder: 0, verify: 0, domainSearch: 0 };
  const hunter = {
    account: async () => { calls.account += 1; return { data: { requests: { searches: { used: 1, available: 100 }, verifications: { used: 1, available: 100 } } } }; },
    finder: async () => { calls.finder += 1; return { data: { email: null } }; },
    verify: async () => { calls.verify += 1; return { data: { status: 'valid' } }; },
    domainSearch: async () => { calls.domainSearch += 1; return { data: { emails: [] } }; },
  };
  const fetchPage = async () => ({ outcome: 'ok', html: '<p>no addresses here</p>' });
  const findAddress = makeFindAddress({ fetchPage, tavilySearch: null, hunter, budget: {}, today: '2026-10-05' });
  const day1 = harness({ prTargets: prTargets(1), findAddress });
  const r1 = await runDrafting(day1.args);
  assert.equal(r1.noAddress.length, 1);
  assert.equal(r1.hunterSpent, 1);
  const spentDay1 = calls.account + calls.finder + calls.verify + calls.domainSearch;
  assert.ok(spentDay1 > 0);

  const day2 = harness({ prTargets: prTargets(1), findAddress, now: NOW + 86_400_000, book: r1.book, state: r1.state });
  const r2 = await runDrafting(day2.args);
  assert.equal(calls.account + calls.finder + calls.verify + calls.domainSearch, spentDay1, 'no Hunter call on day 2');
  assert.equal(r2.hunterSpent, 0);
});

test('I3: a contact carrying the no-address note gets the free pass only, even with no state record', async () => {
  const seen = [];
  const c0 = { id: 'writer1-person', name: 'Writer1 Person', kind: 'journalist', status: 'unverified', domains: ['outlet1.example.com'], outlets: ['Outlet 1'], channels: [], pitches: [], notes: ['2026-10-01: no published or verified address (hunter: accept_all); try by hand: x'] };
  const { args } = harness({
    prTargets: prTargets(1), book: { version: 1, contacts: [c0] },
    findAddress: async (p, opts = {}) => { seen.push(opts); return { address: null, reason: 'nothing', spentHunter: 0 }; },
  });
  await runDrafting(args);
  assert.deepEqual(seen, [{ hunter: false }]);
});

test('I4: a run stops starting prospects at the deadline and reports how many were left', async () => {
  let t = NOW;
  const { args, saved } = harness({
    prTargets: prTargets(6), config: { queueTarget: 6, editorialShare: 1 },
    clock: () => t,
    deadline: NOW + 25 * 60_000,
    fetchArticle: async () => { t += 10 * 60_000; return { outcome: 'ok', html: '<p>A long article about lotion.</p>' }; },
  });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 3, 'attempts start at 0, 10 and 20 minutes; the 30-minute one does not');
  assert.equal(saved.drafts.length, 3);
  assert.equal(r.stoppedAtDeadline, true);
  assert.equal(r.leftAtDeadline, 3);
  const { body, subject } = renderDraftSummary(r, { apply: true });
  assert.match(body, /Stopped at the deadline \(\d\d:\d\d UTC\), 3 prospects left/);
  assert.match(subject, /stopped at deadline/);
});

test('I4: the default deadline is 15:30 UTC of the run day, and never more than 60 minutes', async () => {
  // Starts 15:00 UTC: 15:30 comes first.
  let t = Date.parse('2026-10-05T15:00:00Z');
  const a = harness({
    now: t, prTargets: prTargets(6), config: { queueTarget: 6, editorialShare: 1 }, clock: () => t,
    fetchArticle: async () => { t += 11 * 60_000; return { outcome: 'ok', html: '<p>A long article about lotion.</p>' }; },
  });
  const ra = await runDrafting(a.args);
  assert.equal(ra.drafted.length, 3, '15:00, 15:11, 15:22 start; 15:33 does not');
  assert.equal(ra.stoppedAtDeadline, true);
  // Starts 13:00 UTC: the 60-minute cap comes first.
  t = Date.parse('2026-10-05T13:00:00Z');
  const b = harness({
    now: t, prTargets: prTargets(9), config: { queueTarget: 9, editorialShare: 1 }, clock: () => t,
    fetchArticle: async () => { t += 25 * 60_000; return { outcome: 'ok', html: '<p>A long article about lotion.</p>' }; },
  });
  const rb = await runDrafting(b.args);
  assert.equal(rb.drafted.length, 3, '13:00, 13:25, 13:50 start; 14:15 is past 14:00');
  assert.equal(rb.stoppedAtDeadline, true);
});

test('I4: one run drafts at most draftRunMax (default 10), however short the queue', async () => {
  const { args, saved } = harness({ prTargets: prTargets(15), config: { queueTarget: 25, editorialShare: 1 } });
  const r = await runDrafting(args);
  assert.equal(r.want, 10);
  assert.equal(r.drafted.length, 10);
  assert.equal(saved.drafts.length, 10);
  const small = harness({ prTargets: prTargets(15), config: { queueTarget: 25, editorialShare: 1, draftRunMax: 4 } });
  assert.equal((await runDrafting(small.args)).drafted.length, 4);
});

test('M9: the lock is refreshed inside a prospect, not only between prospects', async () => {
  const events = [];
  const { args } = harness({
    limit: 1,
    onProgress: () => events.push('touch'),
    fetchArticle: async () => { events.push('fetch'); return { outcome: 'ok', html: '<p>A long article about lotion.</p>' }; },
    findAddress: async (p) => { events.push('find'); return { address: `w@${p.domain}`, source: 'published:x', verified: true, spentHunter: 0 }; },
    draftPitch: async ({ contact }) => { events.push('draft'); return { ok: true, draft: { subject: `Note for ${contact.name}`, text: 'Hi', openerQuote: 'a long article about lotion', products: [] } }; },
  });
  const r = await runDrafting(args);
  assert.equal(r.drafted.length, 1);
  const between = (a, b) => events.slice(events.indexOf(a) + 1, events.indexOf(b)).includes('touch');
  assert.ok(between('fetch', 'find'), events.join(' > '));
  assert.ok(between('find', 'draft'), events.join(' > '));
  assert.equal(events.at(-1), 'touch');
});

test('press facts: the drafting run reports every fact the gate skipped, and the draft call gets the document', async () => {
  const pressFacts = { brand: { facts: ['Our antiperspirant formula is loved'] }, products: { lotion: { name: 'Body Lotion', facts: ['heals eczema overnight', 'unscented option'] } } };
  const seen = [];
  const { args } = harness({
    pressFacts, config: { queueTarget: 1, editorialShare: 1 },
    draftPitch: async (a) => { seen.push(a.pressFacts); return { ok: true, draft: { subject: 'Note', text: 'Hi', openerQuote: 'q', products: ['lotion'] } }; },
  });
  const r = await runDrafting(args);
  assert.equal(r.skippedFacts.length, 2);
  assert.equal(seen[0], pressFacts);
  const { body } = renderDraftSummary(r, { apply: true });
  assert.match(body, /Facts skipped by the claim gate \(never sent\):/);
  assert.match(body, /brand\.facts: "Our antiperspirant formula is loved"/);
  assert.match(body, /products\.lotion\.facts: "heals eczema overnight"/);
  const clean = renderDraftSummary({ ...r, skippedFacts: [] }, { apply: true }).body;
  assert.doesNotMatch(clean, /Facts skipped/);
});

test('press facts: a missing or unparseable file refuses with a clear message, never a fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'press-facts-'));
  const bad = join(dir, 'press-facts.json');
  assert.throws(() => loadPressFacts(bad), /Refusing to draft: cannot read .*press-facts\.json/);
  writeFileSync(bad, '{ not json');
  assert.throws(() => loadPressFacts(bad), /Refusing to draft: .*not valid JSON/);
  writeFileSync(bad, JSON.stringify({ brand: {} }));
  assert.throws(() => loadPressFacts(bad), /Refusing to draft: .*no products/);
  writeFileSync(bad, JSON.stringify({ brand: {}, products: { lotion: { name: 'L' } } }));
  assert.equal(loadPressFacts(bad).products.lotion.name, 'L');
});

test('an explicit --limit above draftRunMax is honoured for pitches (no follow-ups due)', async () => {
  const { args, saved } = harness({ config: { ...CONFIG, draftRunMax: 2 }, limit: 5, prTargets: prTargets(5), deadline: NOW + 3600e3, clock: () => NOW });
  const r = await runDrafting(args);
  assert.equal(r.followUps.length, 0);
  assert.equal(r.drafted.length, 5);
  assert.equal(saved.drafts.filter((d) => d.kind === 'pitch').length, 5);
});
