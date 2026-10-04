import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateContacts, loadContacts, contactsByDomain, dueFollowUps, eligibleFor,
  recordPitch, setOutcome, normalizeDomain, addDays, lastPitch, splitDomainHits,
  DEFAULT_COOLDOWN_DAYS, PITCHABLE_STATUSES,
  updatePitch, autoFollowUpsDue, openPitchByAddress, emailOf, PITCH_OUTCOMES,
} from '../../lib/press-contacts.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'press-contacts.example.json');
const doc = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

test('the fake fixture is valid, and contains no real-looking address', () => {
  const d = doc();
  assert.deepEqual(validateContacts(d), { ok: true, errors: [] });
  // The fixture is committed to a PUBLIC repo; every address must be invented.
  for (const c of d.contacts) {
    for (const ch of c.channels) {
      if (ch.type === 'email') assert.match(ch.address, /@example\.com$/, `${c.id} email must be on example.com`);
    }
  }
});

test('validation catches the mistakes that matter', () => {
  const d = doc();
  d.contacts[0].channels[0].source = undefined;            // verified with no source
  d.contacts[1].status = 'friendly';                        // bad status
  d.contacts.push({ ...d.contacts[2] });                    // duplicate id
  d.contacts[3].channels[0] = { type: 'email', address: 'not-an-email', verified: false };
  d.contacts[0].pitches[0].outcome = 'ghosted';             // bad outcome
  const v = validateContacts(d);
  assert.equal(v.ok, false);
  const all = v.errors.join('\n');
  assert.match(all, /verified channel needs a source/);
  assert.match(all, /status "friendly"/);
  assert.match(all, /duplicate id/);
  assert.match(all, /not an email address/);
  assert.match(all, /outcome "ghosted"/);
});

test('loadContacts fails OPEN and says why', () => {
  const missing = loadContacts('x.json', { readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /no contact book/);
  const garbled = loadContacts('x.json', { readFile: () => '{not json' });
  assert.equal(garbled.available, false);
  assert.match(garbled.reason, /not valid JSON/);
  const invalid = loadContacts('x.json', { readFile: () => JSON.stringify({ contacts: [{ id: 'A B' }] }) });
  assert.equal(invalid.available, false);
  assert.match(invalid.reason, /failed validation/);
  const ok = loadContacts('x.json', { readFile: () => readFileSync(FIXTURE, 'utf8') });
  assert.equal(ok.available, true);
  assert.equal(ok.contacts.length, 4);
});

test('normalizeDomain strips scheme, www, path and port', () => {
  assert.equal(normalizeDomain('https://www.Cosmopolitan.com/style/x'), 'cosmopolitan.com');
  assert.equal(normalizeDomain('nbcnews.com:443'), 'nbcnews.com');
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain(''), null);
});

test('contactsByDomain merges www and bare spellings onto one outlet', () => {
  const map = contactsByDomain(doc().contacts);
  const mag = map.get('examplemag.com');
  assert.equal(mag.length, 2, 'www.examplemag.com and examplemag.com are the same outlet');
  assert.deepEqual(mag.map((x) => x.id).sort(), ['ada-writer', 'dee-nofit']);
  assert.equal(mag.find((x) => x.id === 'ada-writer').last_pitched, '2026-09-21');
  // A departed contact still maps, so the flag can show their status.
  assert.equal(map.get('oldmag.example.com')[0].status, 'left_outlet');
});

test('dueFollowUps: due on the day, not the day before, and never for a non-pitchable contact', () => {
  const contacts = doc().contacts;
  assert.equal(dueFollowUps(contacts, '2026-09-30').length, 0);
  const due = dueFollowUps(contacts, '2026-10-01');
  assert.equal(due.length, 1);
  assert.equal(due[0].contact.id, 'ada-writer');
  assert.equal(due[0].overdue_days, 0);
  assert.equal(dueFollowUps(contacts, '2026-10-05')[0].overdue_days, 4);
});

test('dueFollowUps: a replied pitch is no longer due', () => {
  const d = setOutcome(doc(), 'ada-writer', 'replied');
  assert.equal(dueFollowUps(d.contacts, '2026-10-05').length, 0);
});

test('eligibleFor: status, cooldown, concept and fit each exclude WITH a reason', () => {
  const contacts = doc().contacts;
  const r = eligibleFor(contacts, { products: ['lotion'], concept: 'intro-2026-09', today: '2026-10-01' });
  const why = Object.fromEntries(r.excluded.map((x) => [x.contact.id, x.reason]));
  assert.match(why['ada-writer'], /already pitched "intro-2026-09"/);
  assert.match(why['cy-gone'], /status: left_outlet/);
  assert.match(why['bo-creator'], /fit deodorant/);
  // Dee has NO fit recorded: unknown fit is unchecked, not unsuitable.
  assert.deepEqual(r.eligible.map((c) => c.id), ['dee-nofit']);
});

test('eligibleFor: the cooldown counts days since the LAST pitch', () => {
  const contacts = doc().contacts;
  const early = eligibleFor(contacts, { concept: 'gift-guide-2026', today: '2026-10-15' });
  assert.match(early.excluded.find((x) => x.contact.id === 'ada-writer').reason, /cooldown/);
  const later = addDays('2026-09-21', DEFAULT_COOLDOWN_DAYS);
  const ok = eligibleFor(contacts, { concept: 'gift-guide-2026', today: later });
  assert.ok(ok.eligible.some((c) => c.id === 'ada-writer'), `eligible again on ${later}`);
});

test('eligibleFor refuses a missing date rather than guessing', () => {
  assert.throws(() => eligibleFor(doc().contacts, {}), /today as YYYY-MM-DD/);
});

test('recordPitch appends, defaults outcome and follow-up, and never mutates its input', () => {
  const before = doc();
  const after = recordPitch(before, 'bo-creator', { date: '2026-11-02', concept: 'gift-guide-2026', products: ['deodorant'] });
  assert.equal(before.contacts[1].pitches.length, 0, 'input untouched');
  const p = lastPitch(after.contacts[1]);
  assert.equal(p.outcome, 'sent');
  assert.equal(p.follow_up_due, '2026-11-12');
  assert.throws(() => recordPitch(before, 'nobody', { date: '2026-11-02', concept: 'x' }), /no contact/);
  assert.throws(() => recordPitch(before, 'bo-creator', { date: '11/02', concept: 'x' }), /invalid/);
});

test('splitDomainHits: a researched-but-unpitched contact is NOT "already pitched"', () => {
  // The live bug on 2026-09-21: an outlet whose writer was only researched read
  // as already pitched, which would steer outreach away from an unpitched target.
  const map = contactsByDomain(doc().contacts);
  const mag = splitDomainHits(map.get('examplemag.com'));
  assert.deepEqual(mag.pitched.map((h) => h.id), ['ada-writer']);
  assert.deepEqual(mag.onFile.map((h) => h.id), ['dee-nofit']);
  const old = splitDomainHits(map.get('oldmag.example.com'));
  assert.equal(old.pitched.length, 0, 'never pitched');
  assert.equal(old.onFile[0].status, 'left_outlet', 'status carried so the flag can show it');
  assert.deepEqual(splitDomainHits(undefined), { pitched: [], onFile: [] });
});

test('only active and unverified contacts can be pitched', () => {
  assert.deepEqual([...PITCHABLE_STATUSES].sort(), ['active', 'unverified']);
});

// Task 1: Extend the contact book

const H = 3_600_000, D = 24 * H;
const book = (pitchOver = {}, contactOver = {}) => ({ contacts: [{
  id: 'jane-doe', name: 'Jane Doe', status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: 'Jane@Example.com', verified: true, source: 'https://example.com/about' }],
  pitches: [{ date: '2026-10-01', concept: 'intro', outcome: 'sent', message_id: '<a@realskincare.com>',
    last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
  ...contactOver,
}] });

test('new outcomes are valid', () => {
  assert.ok(PITCH_OUTCOMES.includes('sample-accepted'));
  assert.ok(PITCH_OUTCOMES.includes('escalated'));
});

test('validation rejects a malformed new field and accepts a good one', () => {
  assert.equal(validateContacts(book()).ok, true);
  assert.equal(validateContacts(book({ follow_ups_sent: 3 })).ok, false);
  assert.equal(validateContacts(book({ source: 'blast' })).ok, false);
  assert.equal(validateContacts(book({ link_earned: { url: 'x' } })).ok, false, 'link_earned needs found_at');
});

test('updatePitch merges onto the latest pitch and re-validates', () => {
  const next = updatePitch(book(), 'jane-doe', { follow_ups_sent: 1, last_sent_at: '2026-10-06T17:00:00Z' });
  assert.equal(next.contacts[0].pitches[0].follow_ups_sent, 1);
  assert.throws(() => updatePitch(book(), 'jane-doe', { outcome: 'nope' }));
  assert.throws(() => updatePitch(book(), 'nobody', {}));
});

test('first follow-up is due 5 days after the pitch, second 7 days after the first', () => {
  const now = Date.parse('2026-10-06T18:00:00Z');
  assert.deepEqual(autoFollowUpsDue(book().contacts, now).map((r) => r.n), [1]);
  assert.equal(autoFollowUpsDue(book().contacts, now - D).length, 0, 'day 4: not yet');
  const after1 = book({ follow_ups_sent: 1, last_sent_at: '2026-10-06T17:00:00Z' }).contacts;
  assert.equal(autoFollowUpsDue(after1, Date.parse('2026-10-12T18:00:00Z')).length, 0);
  assert.deepEqual(autoFollowUpsDue(after1, Date.parse('2026-10-13T18:00:00Z')).map((r) => r.n), [2]);
  const after2 = book({ follow_ups_sent: 2 }).contacts;
  assert.equal(autoFollowUpsDue(after2, Date.parse('2026-12-01T00:00:00Z')).length, 0, 'never a third');
});

test('no automatic follow-up without a thread id, a non-sent outcome, or a non-pitchable contact', () => {
  const now = Date.parse('2026-10-20T18:00:00Z');
  assert.equal(autoFollowUpsDue(book({ message_id: undefined }).contacts, now).length, 0);
  assert.equal(autoFollowUpsDue(book({ outcome: 'replied' }).contacts, now).length, 0);
  assert.equal(autoFollowUpsDue(book({}, { status: 'do_not_contact' }).contacts, now).length, 0);
});

test('openPitchByAddress keys on the lowercased email of contacts whose latest pitch is open', () => {
  const m = openPitchByAddress(book().contacts);
  assert.equal(m.get('jane@example.com').contact.id, 'jane-doe');
  assert.equal(emailOf(book().contacts[0]), 'jane@example.com');
  assert.equal(openPitchByAddress(book({ outcome: 'declined' }).contacts).size, 0);
});
