#!/usr/bin/env node
/**
 * press-contacts — read and update the PR contact book.
 *
 *   node scripts/press-contacts.mjs                         summary of every contact
 *   node scripts/press-contacts.mjs --due [--date D]        follow-ups due by D (default today)
 *   node scripts/press-contacts.mjs --eligible [--products lotion,soap] [--concept NAME]
 *                                   [--cooldown DAYS] [--date D]
 *                                                           who can be pitched a concept
 *   node scripts/press-contacts.mjs --show ID               one contact in full
 *   node scripts/press-contacts.mjs --validate              check the file, exit 1 on errors
 *   node scripts/press-contacts.mjs --record ID --concept NAME --products a,b
 *                                   --channel email --subject "..." [--date D] --apply
 *                                                           log a pitch you have SENT
 *   node scripts/press-contacts.mjs --outcome ID replied [--date D] --apply
 *                                                           mark a pitch replied/bounced/...
 *   add --json to any read command for machine output.
 *
 * THE BOOK LIVES AT data/press/contacts.json AND IS GITIGNORED ON PURPOSE —
 * this repository is public, and the book holds named people's addresses. The
 * server copy is authoritative and is backed up offsite weekly. See
 * lib/press-contacts.js for why.
 *
 * WRITES ARE DRY BY DEFAULT. `--record` and `--outcome` print what they would
 * change and only write with --apply, after copying the current file to
 * data/press/backups/contacts-<stamp>.json. The write is temp-file + rename, so
 * a crash can never leave a half-written book (every reader treats an
 * unparseable book as absent, which would silently disarm the finder's flag).
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRESS_CONTACTS_PATH, PRODUCTS, CHANNEL_TYPES,
  loadContacts, validateContacts, dueFollowUps, eligibleFor, lastPitch, recordPitch, setOutcome,
  DEFAULT_COOLDOWN_DAYS,
} from '../lib/press-contacts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = join(ROOT, PRESS_CONTACTS_PATH);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : undefined; };
const today = val('--date') || new Date().toISOString().slice(0, 10);
const asJson = has('--json');
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);

function fail(msg, code = 1) { console.error(`press-contacts: ${msg}`); process.exit(code); }

const book = loadContacts(PATH, { readFile: (p) => readFileSync(p, 'utf8') });

if (has('--validate')) {
  if (!existsSync(PATH)) fail(`no contact book at ${PRESS_CONTACTS_PATH}`);
  let doc;
  try { doc = JSON.parse(readFileSync(PATH, 'utf8')); } catch (e) { fail(`not valid JSON: ${e.message}`); }
  const v = validateContacts(doc);
  if (v.ok) { console.log(`OK — ${doc.contacts.length} contacts, no problems.`); process.exit(0); }
  console.error(`${v.errors.length} problem(s):`);
  v.errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

if (!book.available) fail(book.reason);
const contacts = book.contacts;

function primaryChannel(c) {
  const ch = (c.channels || []).find((x) => x.verified) || (c.channels || [])[0];
  return ch ? `${ch.type}: ${ch.address}${ch.verified ? '' : ' (unverified)'}` : '(no channel)';
}

function writeBook(next, what) {
  const v = validateContacts(next);
  if (!v.ok) fail(`refusing to write an invalid book: ${v.errors.join('; ')}`);
  if (!has('--apply')) {
    console.log(`DRY RUN — would ${what}. Re-run with --apply to write.`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups = join(dirname(PATH), 'backups');
  mkdirSync(backups, { recursive: true });
  copyFileSync(PATH, join(backups, `contacts-${stamp}.json`));
  const tmp = `${PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  JSON.parse(readFileSync(tmp, 'utf8'));
  renameSync(tmp, PATH);
  console.log(`Wrote: ${what}. Backup in data/press/backups/.`);
}

if (has('--record')) {
  const id = val('--record');
  const concept = val('--concept');
  const products = list(val('--products'));
  const channel = val('--channel');
  if (!id || !concept) fail('--record needs an ID and --concept');
  const bad = products.filter((p) => !PRODUCTS.includes(p));
  if (bad.length) fail(`unknown product(s) ${bad.join(', ')}; use ${PRODUCTS.join(', ')}`);
  if (channel && !CHANNEL_TYPES.includes(channel)) fail(`--channel must be one of ${CHANNEL_TYPES.join(', ')}`);
  const pitch = { date: today, concept, products, ...(channel ? { channel } : {}), ...(val('--subject') ? { subject: val('--subject') } : {}) };
  const next = recordPitch(book.doc, id, pitch);
  writeBook(next, `log a ${concept} pitch to ${id} dated ${today}`);
  process.exit(0);
}

if (has('--outcome')) {
  const id = val('--outcome');
  const outcome = args[args.indexOf('--outcome') + 2];
  if (!id || !outcome) fail('--outcome needs an ID and an outcome, e.g. --outcome jane-doe replied');
  const next = setOutcome(book.doc, id, outcome, { date: val('--date') || null });
  writeBook(next, `mark ${id}'s pitch as ${outcome}`);
  process.exit(0);
}

if (has('--show')) {
  const c = contacts.find((x) => x.id === val('--show'));
  if (!c) fail(`no contact with id "${val('--show')}"`);
  console.log(JSON.stringify(c, null, 2));
  process.exit(0);
}

if (has('--due')) {
  const rows = dueFollowUps(contacts, today);
  if (asJson) { console.log(JSON.stringify(rows.map((r) => ({ id: r.contact.id, name: r.contact.name, due: r.due, overdue_days: r.overdue_days, channel: primaryChannel(r.contact), subject: r.pitch.subject || null })), null, 2)); process.exit(0); }
  console.log(`\nFollow-ups due by ${today}: ${rows.length}\n`);
  for (const r of rows) {
    console.log(`  ${r.due}${r.overdue_days > 0 ? ` (+${r.overdue_days}d)` : ''}  ${r.contact.name} — ${r.contact.outlets?.join(', ') || ''}`);
    console.log(`      ${primaryChannel(r.contact)}${r.pitch.subject ? `  ·  "${r.pitch.subject}"` : ''}`);
  }
  console.log('');
  process.exit(0);
}

if (has('--eligible')) {
  const cooldown = val('--cooldown') ? Number(val('--cooldown')) : DEFAULT_COOLDOWN_DAYS;
  const { eligible, excluded } = eligibleFor(contacts, {
    products: list(val('--products')), concept: val('--concept') || null, today, cooldownDays: cooldown,
  });
  if (asJson) { console.log(JSON.stringify({ eligible: eligible.map((c) => c.id), excluded: excluded.map((x) => ({ id: x.contact.id, reason: x.reason })) }, null, 2)); process.exit(0); }
  console.log(`\nEligible on ${today}: ${eligible.length} of ${contacts.length}  (cooldown ${cooldown}d)\n`);
  for (const c of eligible) console.log(`  ${c.name.padEnd(28)} ${(c.outlets || []).join(', ').slice(0, 40).padEnd(40)} ${primaryChannel(c)}`);
  const why = excluded.reduce((m, x) => { const k = x.reason.replace(/\d+d ago/, 'Nd ago'); m[k] = (m[k] || 0) + 1; return m; }, {});
  console.log(`\nExcluded ${excluded.length}: ${Object.entries(why).map(([r, n]) => `${r} ×${n}`).join(' · ') || '—'}\n`);
  process.exit(0);
}

// default: summary
if (asJson) { console.log(JSON.stringify(contacts.map((c) => ({ id: c.id, name: c.name, status: c.status, outlets: c.outlets, last_pitched: lastPitch(c)?.date || null })), null, 2)); process.exit(0); }
const byStatus = contacts.reduce((m, c) => { m[c.status] = (m[c.status] || 0) + 1; return m; }, {});
const pitched = contacts.filter((c) => (c.pitches || []).length).length;
console.log(`\nPress contacts: ${contacts.length}  ·  ${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(' · ')}  ·  ${pitched} pitched\n`);
for (const c of contacts.slice().sort((a, b) => a.name.localeCompare(b.name))) {
  const last = lastPitch(c);
  console.log(`  ${c.status.padEnd(14)} ${c.name.padEnd(26)} ${(c.outlets || []).join(', ').slice(0, 34).padEnd(34)} ${last ? `${last.date} ${last.outcome}` : 'never pitched'}`);
}
console.log(`\nFollow-ups due today or earlier: ${dueFollowUps(contacts, today).length}  ·  run --due for the list\n`);
