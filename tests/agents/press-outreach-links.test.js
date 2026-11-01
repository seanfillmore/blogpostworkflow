import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runLinkCheckFlow, LINK_CHECK_LOCK_WAIT_MS, contactBlocker } from '../../agents/press-outreach/index.js';
import { applyLinkFindings } from '../../lib/press-links.js';

// FAKE DATA ONLY: invented people on example domains.
const NOW = Date.parse('2026-10-12T14:25:00Z'), D = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const contact = (id, pitch = {}, extra = {}) => ({
  id, name: id, status: 'active', domains: ['example.com'], channels: [{ type: 'email', address: `${id}@example.com` }],
  pitches: [{ date: iso(NOW - 10 * D).slice(0, 10), concept: 'intro', outcome: 'replied', target_url: `https://example.com/${id}/story`, ...pitch }], ...extra,
});
const LINKED = { outcome: 'ok', html: '<a href="https://realskincare.com/">us</a>' };
const clone = (x) => JSON.parse(JSON.stringify(x));

function flow({ snapshot, freshBook = null, lock = true, apply = true } = {}) {
  const order = [];
  const written = [];
  const notes = [];
  let reads = 0;
  const opts = {
    apply, nowMs: NOW,
    readBook: () => { reads += 1; order.push(`read${reads}`); return { available: true, doc: clone(reads === 1 ? snapshot : (freshBook || snapshot)) }; },
    writeBook: (b) => { order.push('write'); written.push(b); },
    fetchPage: async (u) => { order.push(`fetch ${u}`); return LINKED; },
    waitForLock: async () => { order.push('wait'); return lock; },
    releaseLock: () => order.push('release'),
    notify: async (m) => { notes.push(m); },
    log: () => {},
  };
  return { opts, order, written, notes };
}

test('C1: the fetch runs WITHOUT the lock; the write applies to a fresh re-read under it', async () => {
  const snapshot = { contacts: [contact('hit')] };
  // Between the snapshot and the lock a drafting run added a contact and a field.
  const freshBook = { contacts: [contact('hit', { subject: 'edited meanwhile' }), contact('newcomer', { outcome: 'sent' })] };
  const w = flow({ snapshot, freshBook });
  const r = await runLinkCheckFlow(w.opts);
  assert.ok(w.order.indexOf('fetch https://example.com/hit/story') < w.order.indexOf('wait'), w.order.join(' > '));
  assert.deepEqual(w.order.slice(w.order.indexOf('wait')), ['wait', 'read2', 'write', 'release']);
  assert.equal(w.written.length, 1);
  const out = w.written[0];
  assert.ok(out.contacts.some((c) => c.id === 'newcomer'), 'the concurrent write survives');
  const hit = out.contacts.find((c) => c.id === 'hit').pitches[0];
  assert.equal(hit.subject, 'edited meanwhile');
  assert.equal(hit.outcome, 'placed');
  assert.ok(hit.link_earned);
  assert.equal(r.written, true);
  assert.doesNotMatch(w.notes[0].body, /NOT WRITTEN/);
});

test('C1: the lock never comes free: nothing is written, the digest still goes out and says so', async () => {
  const w = flow({ snapshot: { contacts: [contact('hit')] }, lock: false });
  const r = await runLinkCheckFlow(w.opts);
  assert.equal(w.written.length, 0);
  assert.ok(!w.order.includes('release'), 'a lock never taken is never released');
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0].body, /NOT WRITTEN to the contact book this week/);
  assert.match(w.notes[0].body, /LINK/);
  assert.match(w.notes[0].subject, /not written/);
  assert.equal(r.written, false);
});

test('C1: findings are re-checked against the fresh pitch', async () => {
  const snapshot = { contacts: [contact('a'), contact('b'), contact('c')] };
  const freshBook = { contacts: [
    contact('a', { link_earned: { url: 'https://example.com/x', found_at: iso(NOW - D), dofollow: true }, outcome: 'placed' }),
    contact('b', { outcome: 'sample-accepted' }),
    contact('c', { outcome: 'declined' }),
  ] };
  const w = flow({ snapshot, freshBook });
  await runLinkCheckFlow(w.opts);
  const out = w.written[0];
  const p = (id) => out.contacts.find((c) => c.id === id).pitches[0];
  assert.equal(p('a').link_earned.url, 'https://example.com/x', 'an existing link is not overwritten');
  assert.equal(p('b').outcome, 'sample-accepted', 'a sample in flight keeps its stage on the FRESH outcome');
  assert.ok(p('b').link_earned);
  assert.equal(p('c').outcome, 'declined');
  assert.equal(p('c').link_earned, undefined);
});

test('C1: nothing found takes no lock; the wait budget covers the drafting cutoff', async () => {
  const w = flow({ snapshot: { contacts: [] } });
  await runLinkCheckFlow(w.opts);
  assert.ok(!w.order.includes('wait'));
  assert.equal(w.notes.length, 1);
  // --draft starts 14:20 and may run to 15:30; the check starts 14:25.
  assert.ok(LINK_CHECK_LOCK_WAIT_MS >= 66 * 60_000);
});

test('applyLinkFindings refuses a finding for a pitch that has since been replaced', () => {
  const book = { contacts: [contact('n', { date: iso(NOW).slice(0, 10), outcome: 'sent' })] };
  const r = applyLinkFindings(book, [{ id: 'n', kind: 'link', pitch_date: iso(NOW - 10 * D).slice(0, 10), url: 'https://example.com/n', found_at: iso(NOW), dofollow: true }]);
  assert.equal(r.applied.length, 0);
  assert.match(r.dropped[0].reason, /newer pitch/);
});

test('I2: a placed writer is not an open conversation; the 60-day cooldown applies', () => {
  const at = (days) => contact('p', { outcome: 'placed', date: iso(NOW - days * D).slice(0, 10), link_earned: { url: 'https://example.com/a', found_at: iso(NOW - 5 * D), dofollow: true } });
  assert.equal(contactBlocker(at(61), {}, NOW), null);
  const b = contactBlocker(at(59), {}, NOW);
  assert.match(b.reason, /pitched within 60 days/);
  assert.equal(b.permanent, false);
});

test('M7: runLinkCheck takes no unused env', () => {
  const src = readFileSync(new URL('../../agents/press-outreach/index.js', import.meta.url), 'utf8');
  assert.match(src, /async function runLinkCheck\(apply, config\)/);
});

test('C1: the cron comment no longer claims drafting has released the lock', () => {
  const src = readFileSync(new URL('../../scripts/setup-cron.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /after\s*\n?#?\s*the 14:20 drafting run has released the shared lock/);
});
