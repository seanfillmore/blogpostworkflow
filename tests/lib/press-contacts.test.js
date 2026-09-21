import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateContacts, loadContacts, contactsByDomain, dueFollowUps, eligibleFor,
  recordPitch, setOutcome, normalizeDomain, addDays, lastPitch, splitDomainHits,
  DEFAULT_COOLDOWN_DAYS, PITCHABLE_STATUSES,
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
