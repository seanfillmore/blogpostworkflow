import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDrafting, htmlToText, upsertProspectContact } from '../../agents/press-outreach/index.js';
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
    factSheet: 'FACTS',
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
    linkGap: { opportunities: [{ domain: 'gap.example.com', competitors: ['rival.example.com'] }] },
    findAddress: async () => ({ address: null, reason: 'no published address; hunter unavailable' }),
  });
  const r = await runDrafting(args);
  assert.equal(r.skipped.length, 1);
  assert.equal(saved.books.length, 0);
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
  assert.equal(r2.skipped.length, 1);
  assert.match(r2.skipped[0].reason, /2 failed attempts/);
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
  assert.equal(c.status, 'unverified');
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
