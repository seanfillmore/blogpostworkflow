/**
 * press-contacts — the PR contact book: who we can reach, how, and what we have
 * already sent them.
 *
 * THE DATA IS PRIVATE AND THE CODE IS PUBLIC, and that split is the whole design.
 * This repository is PUBLIC on GitHub. The contact book holds named journalists'
 * and creators' addresses — several of them personal Gmail accounts they publish
 * for pitches — so committing it would republish a scraped contact list of real
 * people to anyone, permanently, in git history. So:
 *
 *   data/press/contacts.json   GITIGNORED, server-authoritative, backed up
 *                              offsite by scripts/backup-snapshots-offsite.sh
 *                              (set `press`). tests/repo/press-contacts-private
 *                              .test.js fails if it is ever tracked.
 *   this module + the CLI      public, pure, tested against a FAKE fixture.
 *
 * Everything here is pure: no I/O except `loadContacts`, which takes its reader
 * as an argument so tests never touch the real file.
 *
 * WHAT A RECORD IS FOR. Pitches go out "throughout the year for different
 * concepts" (Sean, 2026-09-21), so the book has to answer three questions:
 *   1. who can I pitch THIS concept to?            eligibleFor()
 *   2. who is owed a follow-up today?               dueFollowUps()
 *   3. which outlets has the target finder found
 *      that we have ALREADY pitched?                contactsByDomain()
 * The first 29 pitches all went out on 2026-09-21 with no such record, and the
 * second and third target lists were deduplicated by a hand-typed list of
 * domains in a shell command. That is what this replaces.
 */

export const PRESS_CONTACTS_PATH = 'data/press/contacts.json';

// Every contact carries exactly one. Only `active` and `unverified` can be
// pitched; the others are kept BECAUSE they were researched — a record that says
// "left People for Travel Curator" stops the next person re-researching her.
export const CONTACT_STATUSES = Object.freeze([
  'active',          // at the outlet, on the beat, reachable
  'unverified',      // reachable, but currency or address not confirmed
  'left_outlet',     // moved on; the OUTLET may still be worth a pitch
  'inactive',        // stopped publishing
  'do_not_contact',  // e.g. a probable fabricated persona, or an explicit no
]);

export const PITCHABLE_STATUSES = Object.freeze(['active', 'unverified']);

export const CHANNEL_TYPES = Object.freeze([
  'email', 'instagram', 'x', 'contact_form', 'substack', 'shopmy', 'muckrack',
]);

// The catalogue, not the marketing names. A concept is matched on these.
export const PRODUCTS = Object.freeze([
  'lotion', 'body-cream', 'soap', 'deodorant', 'toothpaste', 'lip-balm', 'hand-soap',
]);

export const PITCH_OUTCOMES = Object.freeze([
  'sent', 'replied', 'declined', 'bounced', 'samples-sent', 'placed', 'no-response',
]);

// How long after a pitch before the same person may be pitched a NEW concept.
// A judgement, not a measurement: it is roughly two follow-up cycles, and
// re-pitching inside it reads as a blast. Overridable per call.
export const DEFAULT_COOLDOWN_DAYS = 60;

// A pitch with no follow-up date gets one this many days out.
export const DEFAULT_FOLLOW_UP_DAYS = 10;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** `www.Example.com` -> `example.com`. Null for anything unparseable. */
export function normalizeDomain(d) {
  if (typeof d !== 'string' || !d.trim()) return null;
  let s = d.trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0];
  s = s.replace(/^www\./, '');
  return s.includes('.') ? s : null;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function addDays(isoDate, days) {
  const t = Date.parse(`${isoDate}T00:00:00Z`) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Validate the whole document. Returns every problem rather than the first, so
 * one run of `--validate` lists everything to fix.
 */
export function validateContacts(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.contacts)) {
    return { ok: false, errors: ['document must be an object with a contacts[] array'] };
  }
  const ids = new Set();
  doc.contacts.forEach((c, i) => {
    const at = `contacts[${i}]${c?.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') { errors.push(`${at}: not an object`); return; }
    if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) errors.push(`${at}: id must be kebab-case`);
    else if (ids.has(c.id)) errors.push(`${at}: duplicate id`);
    else ids.add(c.id);
    if (typeof c.name !== 'string' || !c.name.trim()) errors.push(`${at}: name is required`);
    if (!CONTACT_STATUSES.includes(c.status)) errors.push(`${at}: status "${c.status}" not in ${CONTACT_STATUSES.join('/')}`);
    if (!Array.isArray(c.domains)) errors.push(`${at}: domains[] is required (may be empty)`);
    else c.domains.forEach((d) => { if (!normalizeDomain(d)) errors.push(`${at}: bad domain "${d}"`); });
    if (!Array.isArray(c.channels)) errors.push(`${at}: channels[] is required (may be empty)`);
    else c.channels.forEach((ch, j) => {
      const cat = `${at}.channels[${j}]`;
      if (!CHANNEL_TYPES.includes(ch?.type)) errors.push(`${cat}: type "${ch?.type}" not in ${CHANNEL_TYPES.join('/')}`);
      if (typeof ch?.address !== 'string' || !ch.address.trim()) errors.push(`${cat}: address is required`);
      if (ch?.type === 'email' && ch?.address && !EMAIL.test(ch.address)) errors.push(`${cat}: "${ch.address}" is not an email address`);
      // A verified address must say where it was verified — that is the whole
      // difference between a found address and a guessed one.
      if (ch?.verified === true && !ch.source) errors.push(`${cat}: verified channel needs a source URL`);
    });
    (Array.isArray(c.fit) ? c.fit : []).forEach((p) => {
      if (!PRODUCTS.includes(p)) errors.push(`${at}: fit product "${p}" not in ${PRODUCTS.join('/')}`);
    });
    if (c.pitches != null && !Array.isArray(c.pitches)) errors.push(`${at}: pitches must be an array`);
    (c.pitches || []).forEach((p, j) => {
      const pat = `${at}.pitches[${j}]`;
      if (!ISO_DATE.test(p?.date || '')) errors.push(`${pat}: date must be YYYY-MM-DD`);
      if (typeof p?.concept !== 'string' || !p.concept.trim()) errors.push(`${pat}: concept is required`);
      if (!PITCH_OUTCOMES.includes(p?.outcome)) errors.push(`${pat}: outcome "${p?.outcome}" not in ${PITCH_OUTCOMES.join('/')}`);
      (p?.products || []).forEach((x) => { if (!PRODUCTS.includes(x)) errors.push(`${pat}: product "${x}" unknown`); });
      if (p?.follow_up_due != null && !ISO_DATE.test(p.follow_up_due)) errors.push(`${pat}: follow_up_due must be YYYY-MM-DD`);
    });
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Load the book, failing OPEN and SAYING SO. A missing file is the normal state
 * on any checkout that is not the server; the caller decides whether that
 * matters. Returns { available, contacts, reason }.
 */
export function loadContacts(path = PRESS_CONTACTS_PATH, { readFile } = {}) {
  let raw;
  try { raw = readFile(path); }
  catch { return { available: false, contacts: [], reason: `no contact book at ${path}` }; }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { return { available: false, contacts: [], reason: `contact book at ${path} is not valid JSON (${e.message})` }; }
  const v = validateContacts(doc);
  if (!v.ok) {
    return { available: false, contacts: [], reason: `contact book at ${path} failed validation: ${v.errors.slice(0, 3).join('; ')}${v.errors.length > 3 ? ` (+${v.errors.length - 3} more)` : ''}` };
  }
  return { available: true, contacts: doc.contacts, reason: null, doc };
}

export function lastPitch(contact) {
  const ps = (contact.pitches || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  return ps.length ? ps[ps.length - 1] : null;
}

/**
 * Map normalized domain -> contacts on it, with the last pitch date. Used by
 * agents/pr-target-finder to flag outlets we have already pitched.
 * A contact who has LEFT still maps: the flag is about the outlet having been
 * approached, and the status tells a reader not to pitch that person there.
 */
export function contactsByDomain(contacts) {
  const map = new Map();
  for (const c of contacts || []) {
    const last = lastPitch(c);
    for (const d of c.domains || []) {
      const key = normalizeDomain(d);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ id: c.id, name: c.name, status: c.status, last_pitched: last ? last.date : null });
    }
  }
  return map;
}

/**
 * Split one domain's contacts into the two things a target list needs to say
 * differently. `pitched` — someone there has actually been sent a pitch.
 * `onFile` — we researched someone there but never pitched them.
 *
 * Conflating the two was a live bug on the day this shipped: The Strategist and
 * Non-Toxic Lab read "ALREADY PITCHED" because their writers were in the book
 * as research, which would have steered outreach AWAY from an unpitched top
 * target. A "do not contact" record belongs in `onFile` with its status shown.
 */
export function splitDomainHits(hits) {
  const pitched = [];
  const onFile = [];
  for (const h of hits || []) (h.last_pitched ? pitched : onFile).push(h);
  return { pitched, onFile };
}

/**
 * Pitches whose follow-up is due on or before `today` and that have not moved
 * past `sent`. One row per contact (their latest pitch), oldest first.
 */
export function dueFollowUps(contacts, today) {
  const rows = [];
  for (const c of contacts || []) {
    if (!PITCHABLE_STATUSES.includes(c.status)) continue;
    const p = lastPitch(c);
    if (!p || p.outcome !== 'sent') continue;
    const due = p.follow_up_due || addDays(p.date, DEFAULT_FOLLOW_UP_DAYS);
    if (due <= today) rows.push({ contact: c, pitch: p, due, overdue_days: daysBetween(due, today) });
  }
  return rows.sort((a, b) => a.due.localeCompare(b.due) || a.contact.name.localeCompare(b.contact.name));
}

/**
 * Who can be pitched a concept today. Returns BOTH lists — `excluded` names the
 * reason for every contact left out, so "nobody is eligible" is never a mystery.
 *
 *   products     optional list; a contact qualifies if their `fit` overlaps it.
 *                A contact with no `fit` recorded is NOT excluded for it —
 *                unknown fit means unchecked, not unsuitable.
 *   concept      optional; anyone already pitched this concept is excluded.
 *   cooldownDays default DEFAULT_COOLDOWN_DAYS since their last pitch.
 */
export function eligibleFor(contacts, { products = [], concept = null, today, cooldownDays = DEFAULT_COOLDOWN_DAYS } = {}) {
  if (!ISO_DATE.test(today || '')) throw new Error('eligibleFor needs today as YYYY-MM-DD');
  const eligible = [];
  const excluded = [];
  for (const c of contacts || []) {
    if (!PITCHABLE_STATUSES.includes(c.status)) { excluded.push({ contact: c, reason: `status: ${c.status}` }); continue; }
    if (!(c.channels || []).length) { excluded.push({ contact: c, reason: 'no channel on record' }); continue; }
    if (concept && (c.pitches || []).some((p) => p.concept === concept)) {
      excluded.push({ contact: c, reason: `already pitched "${concept}"` }); continue;
    }
    const last = lastPitch(c);
    if (last) {
      const since = daysBetween(last.date, today);
      if (since < cooldownDays) { excluded.push({ contact: c, reason: `pitched ${since}d ago (cooldown ${cooldownDays}d)` }); continue; }
    }
    if (products.length && Array.isArray(c.fit) && c.fit.length && !c.fit.some((p) => products.includes(p))) {
      excluded.push({ contact: c, reason: `fit ${c.fit.join(',')} does not include ${products.join(',')}` }); continue;
    }
    eligible.push(c);
  }
  return { eligible, excluded };
}

/** Pure: return a new document with a pitch appended to one contact. */
export function recordPitch(doc, id, pitch) {
  const idx = doc.contacts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`no contact with id "${id}"`);
  // Only derive a follow-up from a well-formed date. A malformed one must reach
  // validation below and fail with a readable message, not throw a RangeError
  // out of the date arithmetic first.
  const derivable = typeof pitch.date === 'string' && ISO_DATE.test(pitch.date);
  const full = {
    outcome: 'sent',
    ...(pitch.follow_up_due || derivable
      ? { follow_up_due: pitch.follow_up_due || addDays(pitch.date, DEFAULT_FOLLOW_UP_DAYS) }
      : {}),
    ...pitch,
  };
  const contacts = doc.contacts.slice();
  contacts[idx] = { ...contacts[idx], pitches: [...(contacts[idx].pitches || []), full] };
  const next = { ...doc, contacts };
  const v = validateContacts(next);
  if (!v.ok) throw new Error(`recording that pitch would make the book invalid: ${v.errors.join('; ')}`);
  return next;
}

/** Pure: set the outcome of a contact's pitch on a given date (latest if omitted). */
export function setOutcome(doc, id, outcome, { date = null } = {}) {
  if (!PITCH_OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${PITCH_OUTCOMES.join('/')}`);
  const idx = doc.contacts.findIndex((c) => c.id === id);
  if (idx === -1) throw new Error(`no contact with id "${id}"`);
  const pitches = (doc.contacts[idx].pitches || []).slice();
  if (!pitches.length) throw new Error(`${id} has no pitches to update`);
  let pi = -1;
  if (date) pi = pitches.map((p) => p.date).lastIndexOf(date);
  else pi = pitches.reduce((best, p, i) => (best === -1 || p.date >= pitches[best].date ? i : best), -1);
  if (pi === -1) throw new Error(`${id} has no pitch dated ${date}`);
  pitches[pi] = { ...pitches[pi], outcome };
  const contacts = doc.contacts.slice();
  contacts[idx] = { ...contacts[idx], pitches };
  return { ...doc, contacts };
}
