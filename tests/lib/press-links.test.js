import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPitchByAddress } from '../../lib/press-contacts.js';
import { findOurPresence, linkCandidates, funnel, checkLinks, articleLinks, referringDomainsChange } from '../../lib/press-links.js';
import { authorUrlsFromTargets, renderLinkDigest } from '../../agents/press-outreach/index.js';

const NOW = Date.parse('2026-10-12T12:00:00Z'), D = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const contact = (id, pitch, extra = {}) => ({
  id, name: id, status: 'active', domains: ['example.com'], channels: [{ type: 'email', address: `${id}@example.com` }],
  pitches: [{ date: iso(NOW - 10 * D).slice(0, 10), concept: 'intro', outcome: 'replied', target_url: `https://example.com/${id}/story`, ...pitch }], ...extra,
});

test('findOurPresence: dofollow, nofollow sponsored, mention, lookalike domain', () => {
  assert.deepEqual(findOurPresence('<a href="https://www.realskincare.com/products/x">x</a>'), { linked: true, dofollow: true, href: 'https://www.realskincare.com/products/x', mentioned: false });
  const nf = findOurPresence('<a href="https://realskincare.com/" rel="nofollow sponsored">Real Skin Care</a>');
  assert.equal(nf.linked, true); assert.equal(nf.dofollow, false); assert.equal(nf.mentioned, false);
  const m = findOurPresence("<p>We tried Real Skin Care's coconut lotion.</p>");
  assert.deepEqual([m.linked, m.dofollow, m.mentioned], [false, null, true]);
  const fake = findOurPresence('<a href="https://notrealskincare.com/">go</a>');
  assert.equal(fake.linked, false);
});

test('linkCandidates excludes declined, 121-day-old and already-linked pitches', () => {
  const rows = [
    contact('ok', {}),
    contact('declined', { outcome: 'declined' }),
    contact('old', { date: iso(NOW - 121 * D).slice(0, 10) }),
    contact('done', { link_earned: { url: 'https://example.com/a', found_at: iso(NOW) } }),
    contact('author', {}, { author_url: 'https://example.com/authors/a' }),
  ];
  const got = linkCandidates(rows, NOW);
  assert.deepEqual(got.map((c) => c.contact.id), ['ok', 'author']);
  assert.equal(got[1].urls.length, 2);
});

test('funnel counts a small fixture', () => {
  const drafts = [
    { kind: 'pitch', status: 'sent', created_at: iso(NOW - 3 * D), approved_at: iso(NOW - 2 * D), sent_at: iso(NOW - 2 * D) },
    { kind: 'pitch', status: 'pending', created_at: iso(NOW - 60 * D) },
  ];
  const f = funnel([contact('a', { link_earned: { url: 'u', found_at: iso(NOW - D) }, outcome: 'placed' })], drafts, NOW);
  assert.deepEqual(f.allTime, { drafted: 2, approved: 1, sent: 1, replied: 1, samples: 0, links: 1, mentions: 0 });
  assert.equal(f.last28.drafted, 1); assert.equal(f.last28.links, 1);
});

test('checkLinks records a link as placed, counts unreachable pages, never reads them as absent', async () => {
  const book = { contacts: [contact('hit', {}), contact('blocked', {}), contact('mention', {})] };
  const pages = {
    'https://example.com/hit/story': { outcome: 'ok', html: '<a href="https://realskincare.com/">us</a>' },
    'https://example.com/blocked/story': { outcome: 'blocked', html: null },
    'https://example.com/mention/story': { outcome: 'ok', html: 'Real Skin Care is mentioned' },
  };
  const r = await checkLinks({ book, nowMs: NOW, fetchPage: async (u) => pages[u] });
  assert.deepEqual(r.found.map((x) => [x.id, x.kind]), [['hit', 'link'], ['mention', 'mention']]);
  const hit = r.book.contacts.find((c) => c.id === 'hit').pitches[0];
  assert.equal(hit.outcome, 'placed'); assert.equal(hit.link_earned.dofollow, true);
  assert.equal(r.book.contacts.find((c) => c.id === 'blocked').pitches[0].outcome, 'replied');
  assert.deepEqual(r.tally, { ok: 2, blocked: 1 });
});

test('author page: follows recent same-domain articles', async () => {
  const author = 'https://example.com/authors/a';
  const book = { contacts: [contact('w', { target_url: 'https://example.com/w/story' }, { author_url: author })] };
  const pages = {
    'https://example.com/w/story': { outcome: 'ok', html: 'nothing' },
    [author]: { outcome: 'ok', html: '<a href="/w/new-piece">n</a><a href="https://other.com/x/y">o</a><a href="/">home</a>' },
    'https://example.com/w/new-piece': { outcome: 'ok', html: '<a href="https://realskincare.com/products/a" rel="ugc">r</a>' },
  };
  assert.deepEqual(articleLinks(pages[author].html, author), ['https://example.com/w/new-piece']);
  const r = await checkLinks({ book, nowMs: NOW, fetchPage: async (u) => pages[u] });
  assert.equal(r.found[0].url, 'https://example.com/w/new-piece');
  assert.equal(r.found[0].dofollow, false);
});

test('no candidates: fails open with an empty result', async () => {
  const r = await checkLinks({ book: { contacts: [] }, nowMs: NOW, fetchPage: async () => { throw new Error('no network'); } });
  assert.deepEqual(r.found, []);
});

test('referring domain change, author map and digest render', () => {
  assert.deepEqual(referringDomainsChange([{ date: '2026-10-05', referringDomains: 40 }, { date: '2026-10-12', referringDomains: 43 }]).delta, 3);
  assert.equal(referringDomainsChange([{ date: 'x', referringDomains: 1 }]), null);
  assert.equal(authorUrlsFromTargets({ pitch_targets: [{ domain: 'www.example.com', author_url: 'https://example.com/a' }] }).get('example.com'), 'https://example.com/a');
  const f = funnel([], [], NOW);
  const d = renderLinkDigest({ found: [], candidates: [], tally: {}, f, change: { from: 40, to: 43, delta: 3, prevDate: 'a', date: 'b' }, apply: true });
  assert.match(d.body, /not attributed to outreach/);
});

test('brand mention ignores generic phrases and lookalike words', () => {
  for (const t of ['a real skin care routine', 'Real Skin Care routine tips', 'unreal skin care', 'surreal skin care', 'real skin care deodorant']) {
    assert.equal(findOurPresence(`<p>${t}</p>`).mentioned, false, t);
  }
});

test('a link on a samples-sent pitch keeps the outcome, and still counts as a link', async () => {
  const book = { contacts: [contact('s', { outcome: 'samples-sent', sample_order: '#1001' })] };
  const r = await checkLinks({ book, nowMs: NOW, fetchPage: async () => ({ outcome: 'ok', html: '<a href="https://realskincare.com/">r</a>' }) });
  const p = r.book.contacts[0].pitches[0];
  assert.equal(p.outcome, 'samples-sent'); assert.ok(p.link_earned); assert.equal(p.sample_order, '#1001');
  assert.equal(openPitchByAddress(r.book.contacts).size, 1);
  assert.equal(funnel(r.book.contacts, [], NOW).allTime.links, 1);
});

test('author pages on a foreign host are not fetched', () => {
  const c = contact('f', {}, { author_url: 'https://evil.net/a' });
  assert.equal(linkCandidates([c], NOW)[0].urls.length, 1);
  const sub = contact('g', {}, { author_url: 'https://writers.example.com/a' });
  assert.equal(linkCandidates([sub], NOW)[0].urls.length, 2);
  assert.equal(linkCandidates([contact('h', {})], NOW, { authorUrlOf: () => 'https://evil.net/x' })[0].urls.length, 1);
});
