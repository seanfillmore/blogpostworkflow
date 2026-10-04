#!/usr/bin/env node
/**
 * Press Outreach — pitches journalists and creators from sean@realskincare.com,
 * reads their replies, follows up when they go quiet, and hands Sean anything a
 * person should answer.
 *
 * What it does on each run, in order:
 *   1. expires drafts nobody approved within draftExpiryDays
 *   2. reads every open pitch's replies (every folder but Sent/Drafts/Trash, so a
 *      reply inbox-sorter filed into "Cold Pitches" still counts) and Sean's own
 *      Sent mail to those people
 *   3. treats a message Sean wrote by hand as a touch: no automatic follow-up
 *      lands on top of his own conversation, and an escalation he answered clears
 *   4. answers replies by fixed rules (lib/press-replies.js). Every AUTOMATIC
 *      action (sample-yes, address-given, opt-out, decline) is confirmed by one
 *      model call first; anything unconfirmed or unclear is ESCALATED to Sean and
 *      nothing goes back to the writer
 *   5. sends threaded follow-ups (at most 2 per pitch, days 5 and 12)
 *   6. sends first pitches and bumps ONLY from drafts Sean approved (sendOrder)
 *
 * Usage:
 *   node agents/press-outreach/index.js                    # dry run: plan, send nothing
 *   node agents/press-outreach/index.js --apply            # send (cron does this)
 *   node agents/press-outreach/index.js --apply --init     # first run: create the state file
 *   node agents/press-outreach/index.js --test-send you@example.com
 *   node agents/press-outreach/index.js --resume           # clear an auto-pause
 *   node agents/press-outreach/index.js --backfill [--apply] [--set <id>=<outcome>[:<order>]]...
 *                                                          # one-off: thread ids, existing replies, bump drafts
 *
 * Cron: every 30 minutes (scripts/setup-cron.sh). Sends happen only Mon-Fri
 * 16:00-24:00 UTC, at least minGapMinutes apart, under a daily cap that ramps
 * after two clean weeks. Any spam complaint or a >3% bounce rate pauses
 * everything until --resume.
 *
 * Off switch: config/press-outreach.json "enabled": false.
 * Requires HUSHMAIL_USER, HUSHMAIL_PASSWORD and RESEND_API_KEY in .env.
 *
 * State, all under data/press/ (GITIGNORED, backed up offsite as `press`):
 *   contacts.json         the contact book (lib/press-contacts.js)
 *   outreach-state.json   sends, processed reply ids, escalations, pause
 *   drafts/               the approval queue (lib/press-drafts.js)
 *   backups/              a copy of contacts.json before each run's first write
 *
 * PRIVACY: this repository is public. Everything above holds named people's
 * addresses and messages and must never be committed; fixtures use example.com.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync, copyFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { hushmailCredentials, sendMail, fetchFromAllFolders, fetchSentTo, isTransientNetworkError } from '../../lib/hushmail.js';
import {
  loadContacts, validateContacts, recordPitch, updatePitch, autoFollowUpsDue, openPitchByAddress,
  emailOf, lastPitch, MAX_FOLLOW_UPS, PRESS_CONTACTS_PATH, PITCHABLE_STATUSES, PITCH_OUTCOMES,
  OPEN_OUTCOMES, DEFAULT_COOLDOWN_DAYS,
} from '../../lib/press-contacts.js';
import { DRAFTS_DIR, newDraft, markSent, expireDrafts, sendOrder, loadDrafts, saveDraft as saveDraftFile } from '../../lib/press-drafts.js';
import { classifyReply } from '../../lib/press-replies.js';
import {
  DEFAULT_CONFIG, inSendWindow, dailyCap, stripDashes, followUpText, askAddressText,
  checkOutgoingCopy, shouldPause, firstName, bumpText,
} from '../../lib/press-outreach.js';
import { transientStreak, TRANSIENT_ESCALATE_AFTER } from '../creator-outreach/index.js';
import { LLM_MODELS } from '../../config/llm-models.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRESS_DIR = join(ROOT, 'data', 'press');
export const STATE_PATH = join(PRESS_DIR, 'outreach-state.json');
const CONFIG_PATH = join(ROOT, 'config', 'press-outreach.json');
const LOCK_PATH = join(PRESS_DIR, '.lock');
const TRANSIENT_PATH = join(PRESS_DIR, '.transient-failures.json');
const BACKUP_DIR = join(PRESS_DIR, 'backups');
const BRAND_KIT_PATH = join(ROOT, 'data', 'brand', 'brand-kit.json');
const LOOKBACK_DAYS = 45;
const DAY = 86_400_000;
const MAX_PROCESSED = 2000;
const MAX_REFS = 20;
const CONFIRM_MODEL = LLM_MODELS.standard;
const SEND_FAILURES_REPORT_AT = 3;
const AUTO_KINDS = new Set(['sample-yes', 'address-given', 'opt-out', 'decline']);

function loadEnv(root = ROOT) {
  try {
    const env = {};
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
}

export function loadConfig(path = CONFIG_PATH) {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, 'utf8')) }; } catch { return { ...DEFAULT_CONFIG }; }
}

export function readState(path = STATE_PATH) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeState(state, path = STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function readBook() {
  return loadContacts(PRESS_CONTACTS_PATH, { readFile: (p) => readFileSync(join(ROOT, p), 'utf8') });
}

let backedUp = false;
/** Validated, atomic write. The pre-run file is copied to backups/ once per process. */
export function writeBook(doc) {
  const v = validateContacts(doc);
  if (!v.ok) throw new Error(`refusing to write an invalid contact book: ${v.errors.slice(0, 3).join('; ')}`);
  const path = join(ROOT, PRESS_CONTACTS_PATH);
  if (!backedUp && existsSync(path)) {
    mkdirSync(BACKUP_DIR, { recursive: true });
    copyFileSync(path, join(BACKUP_DIR, `contacts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    backedUp = true;
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2));
  renameSync(tmp, path);
}

function readPostalAddress() {
  try { return JSON.parse(readFileSync(BRAND_KIT_PATH, 'utf8')).postal_address || null; } catch { return null; }
}

const KIND_DEFINITIONS = [
  'sample-yes: the writer clearly accepts free product samples, with no condition, question or delay attached.',
  'address-given: the writer gives a mailing address for us to ship samples to.',
  'opt-out: the writer asks not to be contacted or emailed again.',
  'decline: the writer politely says no to this pitch (not interested, not a fit, passing).',
].join('\n');

/** Default confirmer: one standard-tier call. Only an exact YES confirms. */
async function confirmWithModel(msg, kind, env) {
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: CONFIRM_MODEL,
    max_tokens: 10,
    system: 'You check how a brand should read one email reply from a journalist or creator it pitched. Answer only YES or NO.',
    messages: [{
      role: 'user',
      content: `Definitions:\n${KIND_DEFINITIONS}\n\nThe writer's message:\n"""\n${msg.text || ''}\n"""\n\nIs this message unambiguously ${kind}? Answer only YES or NO.`,
    }],
  });
  if (res.stop_reason === 'max_tokens') return false;
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim() === 'YES';
}

const isoOf = (ms) => new Date(ms).toISOString();
const reSubject = (s) => (/^re:/i.test(String(s || '').trim()) ? String(s).trim() : `Re: ${String(s || '').trim()}`);
const refsOf = (list, id) => [...new Set([...(list || []), id].filter(Boolean))].slice(-MAX_REFS);

/** A fresh state object, the shape every run expects. */
export function emptyState(nowMs = Date.now()) {
  return { created_at: isoOf(nowMs), sends: [], processed: [], escalated: {} };
}

/** Add reply Message-IDs to state.processed: unique, newest kept, capped. Mutates and returns state. */
export function markProcessed(state, ids) {
  const seen = new Set(state.processed ||= []);
  for (const id of ids || []) {
    if (!id || seen.has(id)) continue;
    state.processed.push(id);
    seen.add(id);
  }
  if (state.processed.length > MAX_PROCESSED) state.processed = state.processed.slice(-MAX_PROCESSED);
  return state;
}

/**
 * First-run state (`--init`). Reads replies exactly as a run would (every open
 * pitch, LOOKBACK_DAYS) and marks them ALL processed without classifying any:
 * a reply that arrived before the agent existed was Sean's to answer, and the
 * first live run must not answer it a second time.
 */
export async function initState({ book, readReplies, now = Date.now() }) {
  const senders = [...openPitchByAddress(book.contacts).keys()];
  const state = emptyState(now);
  if (!senders.length) return state;
  const want = new Set(senders);
  const replies = await readReplies({ senders, since: new Date(now - LOOKBACK_DAYS * DAY) });
  return markProcessed(state, replies.filter((m) => m.messageId && want.has(String(m.from || '').toLowerCase())).map((m) => m.messageId));
}

/**
 * One run. All I/O is injected so the orchestration is testable without a
 * mailbox, a model, or the real contact book.
 */
export async function runPressOutreach({
  env = {},
  apply = false,
  now = Date.now(),
  config = DEFAULT_CONFIG,
  book,
  state,
  drafts = [],
  readReplies,
  readSent,
  send,
  saveBook = writeBook,
  saveState = writeState,
  saveDraft = (d) => saveDraftFile(join(ROOT, DRAFTS_DIR), d),
  readDraft = (id) => JSON.parse(readFileSync(join(ROOT, DRAFTS_DIR, `${id}.json`), 'utf8')),
  escalate = async () => {},
  onAddress,
  confirmReply,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  postalAddress = null,
  reportError = async (subject, body) => notify({ subject, body, status: 'error', category: 'press' }),
  log = console.log,
} = {}) {
  const creds = hushmailCredentials(env);
  readReplies ||= (q) => fetchFromAllFolders(creds, q);
  readSent ||= (q) => fetchSentTo(creds, { recipients: q.senders, since: q.since });
  send ||= (m) => sendMail(creds, { ...m, agent: 'press-outreach' }, { via: config.sendVia, resendKey: env.RESEND_API_KEY, agent: 'press-outreach' });
  confirmReply ||= (msg, kind) => confirmWithModel(msg, kind, env);

  if (!apply) {
    // Dry run: every side effect only says what it would have done.
    let n = 0;
    send = async (m) => { log(`  [dry run] would send to ${m.to}: ${m.subject}`); n += 1; return { messageId: `<dry-run-${n}@realskincare.com>`, resendId: null }; };
    saveBook = () => {};
    saveState = () => {};
    saveDraft = () => {};
    escalate = async (c, _msg, reason) => { log(`  [dry run] would escalate ${c.name} to Sean: ${reason}`); };
    onAddress = async (c) => { log(`  [dry run] would record ${c.name}'s address and tell Sean`); };
    sleep = async () => {};
    reportError = async (subject) => { log(`  [dry run] would report: ${subject}`); };
  }
  // PR 1: an address is recorded by the run; this tells Sean to place the order.
  // The contact is escalated too, so their next message reaches Sean rather than
  // going back through automatic classification while an order is pending.
  onAddress ||= async (c, _pitch, _address, msg) => {
    const reason = 'address received, create the PR Package order';
    state.escalated[c.id] = { at: isoOf(now), reason, message_id: msg?.messageId || null };
    await escalate(c, msg, reason);
  };

  state.sends ||= [];
  state.processed ||= [];
  state.escalated ||= {};
  const result = { replies: [], escalations: [], followUps: [], sent: [], skipped: [], expired: [], failed: [], paused: Boolean(state.paused), imapDown: false };
  const at = isoOf(now);
  const today = at.slice(0, 10);

  const find = (id) => book.contacts.find((c) => c.id === id);
  /** Adopt `next` in memory, then persist. A failed write is reported, never thrown: returns false. */
  const commit = (next, row = {}) => {
    book = next;
    try { saveBook(book); return true; } catch (err) {
      result.failed.push({ ...row, kind: row.kind || 'book', error: `bookkeeping: contact book write failed: ${err.message}` });
      return false;
    }
  };
  /** After a SEND: the change must hold in memory even if validation or the write fails. */
  const commitAfterSend = (id, patch, row) => {
    let next;
    try { next = updatePitch(book, id, patch); } catch (err) {
      result.failed.push({ ...row, error: `bookkeeping: sent, but the pitch update was invalid: ${err.message}` });
      next = { ...book, contacts: book.contacts.map((x) => {
        if (x.id !== id) return x;
        const lp = lastPitch(x);
        return { ...x, pitches: (x.pitches || []).map((q) => (q === lp ? { ...q, ...patch } : q)) };
      }) };
    }
    commit(next, { ...row, kind: row.kind });
  };
  /** Persist state; a failed write is reported in the run result, never thrown. */
  const persistState = (row = {}) => {
    try { saveState(state); return true; } catch (err) {
      result.failed.push({ ...row, kind: row.kind || 'state', error: `bookkeeping: state write failed: ${err.message}` });
      return false;
    }
  };
  // Contacts with a reply this run that was not fully handled: no automatic
  // follow-up may land on top of a conversation still waiting for an answer.
  const held = new Set();
  // Escalating marks the pitch `escalated` only where that cannot erase a later
  // stage: a sample already accepted or shipped stays recorded as such (no
  // automatic follow-up fires for those outcomes, and state.escalated holds the rest).
  const escalatedOutcome = (pitch) => (['sent', 'replied'].includes(pitch.outcome) ? { outcome: 'escalated' } : {});

  // ── spacing and cap ──
  const gapMs = (config.minGapMinutes || DEFAULT_CONFIG.minGapMinutes) * 60_000;
  const maxPerRun = Math.ceil(30 / (config.minGapMinutes || DEFAULT_CONFIG.minGapMinutes));
  let runSends = 0;
  const sentToday = () => state.sends.filter((s) => String(s.at).slice(0, 10) === today).length;
  const canSend = () => runSends < maxPerRun && sentToday() < dailyCap(config, state, now);
  let needGap = false;
  /**
   * Send one message, minGapMinutes after the previous one. `precheck` runs AFTER
   * the gap sleep and right before the send: a non-empty string it returns is
   * why the message must not go, and doSend returns { skipped: reason }.
   */
  async function doSend(message, { contactId, kind, draftId = null, pitchDate = null, precheck = null }) {
    if (needGap) { await sleep(gapMs); needGap = false; }
    if (precheck) {
      const why = precheck();
      if (why) return { skipped: why };
    }
    runSends += 1;
    needGap = true;
    let r;
    try {
      r = await send(message);
    } catch (err) {
      state.send_failures = (state.send_failures || 0) + 1;
      if (state.send_failures === SEND_FAILURES_REPORT_AT) {
        try { await reportError('Press outreach: sends are failing', `${SEND_FAILURES_REPORT_AT} consecutive sends failed. Latest: ${err.message}`); } catch { /* the console has it */ }
      }
      try { saveState(state); } catch { /* best effort */ }
      throw err;
    }
    state.send_failures = 0;
    // draft_id / pitch_date make a send recognisable on the next run even if every
    // bookkeeping write after it failed, so it is never sent a second time.
    state.sends.push({
      at: isoOf(now), contact_id: contactId, kind,
      ...(draftId ? { draft_id: draftId } : {}), ...(pitchDate ? { pitch_date: pitchDate } : {}),
      message_id: r.messageId, resend_id: r.resendId || null, last_event: 'sent',
    });
    // Persisted at once, so cap accounting survives a crash before any bookkeeping.
    try { saveState(state); } catch (err) { log(`  could not save state after a send: ${err.message}`); }
    return r;
  }

  // ── 1. expire drafts ──
  const ex = expireDrafts(drafts, now, config.draftExpiryDays);
  drafts = ex.drafts;
  for (const d of ex.expired) {
    try { saveDraft(d); } catch (err) { log(`  could not save expired draft ${d.id}: ${err.message}`); }
    result.expired.push({ id: d.id, contact_id: d.contact_id });
  }

  // ── 2. read mail ──
  const open = openPitchByAddress(book.contacts);
  const senders = [...open.keys()];
  const since = new Date(now - LOOKBACK_DAYS * DAY);
  let replies = [];
  let sentBySean = [];
  if (senders.length) {
    try {
      replies = await readReplies({ senders, since });
      sentBySean = await readSent({ senders, since });
    } catch (err) {
      if (!isTransientNetworkError(err)) throw err;
      result.imapDown = true;
      log(`  IMAP unavailable (${err.message}); skipping replies and follow-ups this run`);
    }
  }

  if (!result.imapDown) {
    // ── 3. Sean's hand-sent mail is a touch ──
    for (const m of sentBySean) {
      for (const addr of m.to || []) {
        const hit = open.get(String(addr).toLowerCase());
        if (!hit) continue;
        const c = find(hit.contact.id);
        const p = lastPitch(c);
        const prev = Date.parse(p.last_sent_at || `${p.date}T00:00:00Z`);
        if (!(Date.parse(m.date) > prev)) continue;
        const when = /Z$/.test(String(m.date)) ? m.date : isoOf(Date.parse(m.date));
        const patch = { last_sent_at: when, follow_ups_sent: MAX_FOLLOW_UPS };
        if (state.escalated[c.id]) {
          delete state.escalated[c.id];
          patch.outcome = 'replied';
        }
        commit(updatePitch(book, c.id, patch), { id: c.id, name: c.name });
        saveState(state);
        log(`  Sean wrote to ${c.name} himself; no automatic follow-up`);
      }
    }

    // ── 4. replies, oldest first ──
    // The latest message Sean sent each address by hand. A reply older than it
    // is one he has already answered himself, so nothing may answer it again.
    const seanLatest = new Map();
    for (const m of sentBySean) {
      const t = Date.parse(m.date);
      if (!Number.isFinite(t)) continue;
      for (const addr of m.to || []) {
        const a = String(addr).toLowerCase();
        if (!(seanLatest.get(a) >= t)) seanLatest.set(a, t);
      }
    }
    const done = new Set(state.processed);
    const markDone = (id) => {
      state.processed.push(id);
      done.add(id);
      if (state.processed.length > MAX_PROCESSED) state.processed = state.processed.slice(-MAX_PROCESSED);
    };
    for (const msg of replies.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
      if (!msg.messageId || done.has(msg.messageId)) continue;
      const hit = open.get(String(msg.from || '').toLowerCase());
      if (!hit) continue;
      const c = find(hit.contact.id);
      const p = lastPitch(c);
      // A message from before this pitch belongs to an older conversation.
      if (Date.parse(msg.date) < Date.parse(`${p.date}T00:00:00Z`)) continue;
      const row = { id: c.id, name: c.name, said: String(msg.text || '').slice(0, 300) };
      if (seanLatest.get(String(msg.from || '').toLowerCase()) > Date.parse(msg.date)) {
        log(`  ${c.name}: Sean already answered this reply himself; leaving it`);
        markDone(msg.messageId);
        persistState();
        continue;
      }

      const toSean = async (reason) => {
        try {
          await escalate(c, msg, reason);
          result.escalations.push({ ...row, reason });
          return true;
        } catch (err) {
          result.failed.push({ ...row, kind: 'escalation', error: err.message });
          return false;
        }
      };

      if (state.escalated[c.id]) {
        // While escalated, every message goes to Sean.
        if (await toSean('a new message while this contact is waiting on you')) markDone(msg.messageId);
        else held.add(c.id);
        saveState(state);
        continue;
      }

      let verdict = classifyReply(msg, { awaitingAddress: p.outcome === 'sample-accepted' });
      // An automatic answer is only right at the stage it was written for: a
      // "yes" from someone whose samples already shipped is not a sample request.
      const stageOk = verdict.kind === 'sample-yes' ? p.outcome === 'sent'
        : verdict.kind === 'address-given' ? (p.outcome === 'sample-accepted' || (p.outcome === 'sent' && verdict.reason === 'accepted with address'))
          : verdict.kind === 'decline' ? p.outcome === 'sent'
            : true;
      if (!stageOk) verdict = { kind: 'escalate', reason: 'reply does not fit the conversation stage' };
      if (verdict.kind === 'sample-yes' && !canSend()) {
        result.skipped.push({ ...row, reason: 'sample-yes waiting: send cap reached, retrying next run' });
        held.add(c.id);
        continue; // left unprocessed on purpose
      }
      if (AUTO_KINDS.has(verdict.kind)) {
        let ok = false;
        try { ok = (await confirmReply(msg, verdict.kind)) === true; } catch { ok = false; }
        if (!ok) verdict = { kind: 'escalate', reason: `model did not confirm ${verdict.kind}` };
      }

      let handled = true;
      if (verdict.kind === 'ignore') {
        log(`  ignored ${c.name}: ${verdict.reason}`);
      } else if (verdict.kind === 'opt-out') {
        const next = updatePitch(book, c.id, { outcome: 'declined' });
        handled = commit({ ...next, contacts: next.contacts.map((x) => (x.id === c.id ? { ...x, status: 'do_not_contact' } : x)) }, row);
        result.replies.push({ ...row, kind: 'opt-out' });
      } else if (verdict.kind === 'decline') {
        handled = commit(updatePitch(book, c.id, { outcome: 'declined' }), row);
        result.replies.push({ ...row, kind: 'decline' });
      } else if (verdict.kind === 'sample-yes') {
        const text = stripDashes(askAddressText({ firstName: firstName(c) }));
        const subject = stripDashes(reSubject(msg.subject || p.subject));
        const gate = checkOutgoingCopy({ subject, text, kind: 'reply' });
        if (!gate.ok) {
          const reason = `could not send the address request: ${gate.problems.join('; ')}`;
          commit(updatePitch(book, c.id, escalatedOutcome(p)), row);
          state.escalated[c.id] = { at: isoOf(now), reason, message_id: msg.messageId };
          handled = await toSean(reason);
        } else {
          let sent = false;
          try {
            const refs = refsOf(msg.references, msg.messageId);
            await doSend({ to: emailOf(c), subject, text, inReplyTo: msg.messageId, references: refs.join(' ') }, { contactId: c.id, kind: 'ask-address' });
            sent = true;
          } catch (err) {
            result.failed.push({ ...row, kind: 'ask-address', error: err.message });
            handled = false;
          }
          if (sent) {
            // Sent: the reply is handled whatever happens to the bookkeeping below.
            commitAfterSend(c.id, { outcome: 'sample-accepted', last_sent_at: isoOf(now) }, { ...row, kind: 'ask-address' });
            result.replies.push({ ...row, kind: 'sample-yes' });
          }
        }
      } else if (verdict.kind === 'address-given') {
        handled = commit(updatePitch(book, c.id, { outcome: 'sample-accepted', sample_address: { lines: verdict.address.lines, zip: verdict.address.zip, received_at: isoOf(Date.parse(msg.date)) } }), row);
        if (handled) try {
          await onAddress(find(c.id), lastPitch(find(c.id)), verdict.address, msg);
          result.replies.push({ ...row, kind: 'address-given' });
        } catch (err) {
          result.failed.push({ ...row, kind: 'address-given', error: err.message });
          handled = false;
        }
      } else {
        if (Object.keys(escalatedOutcome(p)).length) commit(updatePitch(book, c.id, escalatedOutcome(p)), row);
        state.escalated[c.id] = { at: isoOf(now), reason: verdict.reason, message_id: msg.messageId };
        handled = await toSean(verdict.reason);
      }

      if (handled) markDone(msg.messageId);
      else held.add(c.id);
      saveState(state);
    }

    // ── 5. follow-ups ──
    if (inSendWindow(now)) {
      const due = autoFollowUpsDue(book.contacts, now)
        .sort((a, b) => String(a.pitch.last_sent_at || a.pitch.date).localeCompare(String(b.pitch.last_sent_at || b.pitch.date)));
      for (const { contact, pitch, n } of due) {
        if (held.has(contact.id)) { result.skipped.push({ id: contact.id, name: contact.name, reason: `follow-up ${n} held: a reply from them is still being handled` }); continue; }
        const prior = state.sends.find((s) => s.contact_id === contact.id && s.kind === `follow-up-${n}` && s.pitch_date === pitch.date);
        if (prior) {
          // Sent by an earlier run whose book write failed: repair, never resend.
          commitAfterSend(contact.id, { follow_ups_sent: n, last_sent_at: prior.at, references: refsOf(refsOf(pitch.references, pitch.message_id), prior.message_id) }, { id: contact.id, name: contact.name, kind: `follow-up-${n}` });
          result.skipped.push({ id: contact.id, name: contact.name, reason: `follow-up ${n} was already sent by an earlier run; book repaired` });
          continue;
        }
        if (!canSend()) { result.skipped.push({ id: contact.id, name: contact.name, reason: `follow-up ${n} deferred: send cap reached` }); continue; }
        if (!pitch.subject) { result.skipped.push({ id: contact.id, name: contact.name, reason: 'pitch has no subject to reply under' }); continue; }
        const text = stripDashes(followUpText({ firstName: firstName(contact), n }));
        const subject = stripDashes(reSubject(pitch.subject));
        const gate = checkOutgoingCopy({ subject, text, kind: 'follow-up' });
        if (!gate.ok) { result.skipped.push({ id: contact.id, name: contact.name, reason: `follow-up failed the copy gate: ${gate.problems.join('; ')}` }); continue; }
        const refs = refsOf(pitch.references, pitch.message_id);
        let r;
        try {
          r = await doSend({ to: emailOf(contact), subject, text, inReplyTo: pitch.message_id, references: refs.join(' ') }, { contactId: contact.id, kind: `follow-up-${n}`, pitchDate: pitch.date });
        } catch (err) {
          result.failed.push({ id: contact.id, name: contact.name, kind: `follow-up-${n}`, error: err.message });
          continue;
        }
        commitAfterSend(contact.id, { follow_ups_sent: n, last_sent_at: isoOf(now), references: refsOf(refs, r.messageId) }, { id: contact.id, name: contact.name, kind: `follow-up-${n}` });
        result.followUps.push({ id: contact.id, name: contact.name, n });
      }
    }
  }

  // ── 6. approved drafts (first pitches do not depend on reading mail) ──
  // Drafts were read at run start; the dashboard can reject, edit or demote one
  // while this run sleeps. Every write and every send re-reads the file first.
  const CHANGED = 'changed in dashboard since the run started; left as it is';
  const draftUnchanged = (d) => {
    let cur = null;
    try { cur = readDraft(d.id); } catch { cur = null; }
    return Boolean(cur) && cur.status === 'approved' && cur.approved_at === d.approved_at && cur.subject === d.subject && cur.text === d.text;
  };
  /** Write `next` over draft `d` only if nobody changed the file since the run read it. */
  const saveIfUnchanged = (d, next, row) => {
    if (!draftUnchanged(d)) { result.skipped.push({ ...row, reason: CHANGED }); return false; }
    try { saveDraft(next); } catch (err) { log(`  could not save draft ${d.id}: ${err.message}`); }
    return true;
  };
  /** The book's record of a sent draft. Idempotent: a pitch already recorded for this draft is not added twice. */
  const recordDraftSent = (d, c, { messageId, sentAt, subject, row }) => {
    try {
      if (d.kind === 'pitch') {
        if ((c.pitches || []).some((p) => p.draft_id === d.id)) return;
        commit(recordPitch(book, c.id, {
          date: sentAt.slice(0, 10), concept: d.concept, products: d.products || [], channel: 'email', subject,
          outcome: 'sent', message_id: messageId, references: [], last_sent_at: sentAt, follow_ups_sent: 0,
          source: d.source || 'manual', target_url: d.target_url || null, draft_id: d.id,
        }), row);
      } else {
        const lp = lastPitch(c);
        const later = !lp?.last_sent_at || Date.parse(sentAt) > Date.parse(lp.last_sent_at);
        commit(updatePitch(book, c.id, { follow_ups_sent: Math.max(lp?.follow_ups_sent || 0, 1), ...(later ? { last_sent_at: sentAt } : {}) }), row);
      }
    } catch (err) {
      result.failed.push({ ...row, error: `sent, but the book was not updated: ${err.message}` });
    }
  };

  if (inSendWindow(now) && !state.paused) {
    for (const d of sendOrder(drafts)) {
      const row = { id: d.contact_id, draft_id: d.id, kind: d.kind };
      const c = find(d.contact_id);
      const prior = state.sends.find((s) => s.draft_id === d.id);
      if (prior) {
        // Sent by an earlier run whose bookkeeping failed: repair the file and the book, never resend.
        try { saveDraft(markSent(d, { now: Date.parse(prior.at), messageId: prior.message_id, resendId: prior.resend_id || null })); } catch (err) { log(`  could not repair sent draft ${d.id}: ${err.message}`); }
        if (c) recordDraftSent(d, c, { messageId: prior.message_id, sentAt: prior.at, subject: stripDashes(d.subject), row });
        result.skipped.push({ ...row, reason: 'already sent by an earlier run; draft and book repaired' });
        continue;
      }
      if (!canSend()) { result.skipped.push({ ...row, reason: 'approved, waiting: send cap reached' }); continue; }
      if (d.kind === 'pitch' && !postalAddress) { result.skipped.push({ ...row, reason: 'no postal address in data/brand/brand-kit.json; first pitches refused' }); continue; }
      if (!c) { result.skipped.push({ ...row, reason: 'contact not in the book' }); continue; }
      if (!PITCHABLE_STATUSES.includes(c.status)) { result.skipped.push({ ...row, reason: `contact status is ${c.status}` }); continue; }
      if (d.kind === 'pitch') {
        // A first pitch is only a first pitch to someone we are not already talking to.
        const lp = lastPitch(c);
        let problem = null;
        if (state.escalated[c.id] || (lp && OPEN_OUTCOMES.includes(lp.outcome))) problem = 'contact has an open conversation';
        else if (lp && now - Date.parse(`${lp.date}T00:00:00Z`) < DEFAULT_COOLDOWN_DAYS * DAY) problem = `contact pitched within ${DEFAULT_COOLDOWN_DAYS} days (last ${lp.date})`;
        if (problem) {
          if (saveIfUnchanged(d, { ...d, status: 'pending', gate_problems: [problem] }, row)) result.skipped.push({ ...row, reason: `back to pending: ${problem}` });
          continue;
        }
      }
      if (d.kind === 'bump') {
        // A bump re-opens a quiet thread. It is only right while the thread is
        // still quiet, which we can only know when the mail was read this run.
        if (result.imapDown || held.has(c.id)) { result.skipped.push({ ...row, reason: 'bump held: replies could not be read this run' }); continue; }
        if (lastPitch(c)?.outcome !== 'sent') {
          const gone = { ...d, status: 'expired', expired_at: isoOf(now), expired_reason: 'thread moved on' };
          if (saveIfUnchanged(d, gone, row)) result.expired.push({ id: d.id, contact_id: d.contact_id, reason: 'thread moved on' });
          continue;
        }
      }
      const subject = stripDashes(d.subject);
      const text = stripDashes(d.text);
      const gate = checkOutgoingCopy({ subject, text, kind: d.kind, ...(d.kind === 'pitch' ? { postalAddress } : {}) });
      if (!gate.ok) {
        if (saveIfUnchanged(d, { ...d, status: 'pending', gate_problems: gate.problems }, row)) result.skipped.push({ ...row, reason: `back to pending: ${gate.problems.join('; ')}` });
        continue;
      }
      let r;
      try {
        const threaded = d.kind === 'bump' && d.in_reply_to;
        r = await doSend({
          to: d.to, subject, text,
          ...(threaded ? { inReplyTo: d.in_reply_to, references: refsOf(d.references, d.in_reply_to).join(' ') } : {}),
        }, { contactId: c.id, kind: d.kind, draftId: d.id, precheck: () => (draftUnchanged(d) ? null : CHANGED) });
      } catch (err) {
        result.failed.push({ ...row, error: err.message });
        continue;
      }
      if (r.skipped) { result.skipped.push({ ...row, reason: r.skipped }); continue; }
      const sentAt = isoOf(now);
      // Sent: from here on nothing may make it look unsent.
      try { saveDraft(markSent(d, { now: Date.parse(sentAt), messageId: r.messageId, resendId: r.resendId || null })); } catch (err) { log(`  could not save sent draft ${d.id}: ${err.message}`); }
      recordDraftSent(d, c, { messageId: r.messageId, sentAt, subject, row });
      state.first_sent_at ||= sentAt;
      saveState(state);
      result.sent.push({ ...row, to: d.to });
    }
  }

  result.paused = Boolean(state.paused);
  return { ...result, book };
}

const BUMP_AFTER_DAYS = 12;
const fold = (s) => String(s || '').trim().toLowerCase();

/**
 * One-off backfill for pitches Sean sent by hand before this agent existed.
 * Pure: reads the book plus the Sent copies and replies, and returns what to
 * change. It acts on nothing and calls no model.
 *   1. thread ids: finds the Sent copy of each sent pitch and patches in its
 *      message_id, subject and last_sent_at (no Sent copy: noted, never followed up)
 *   2. replies since the pitch: reported with their classification; only
 *      decline and opt-out are patched, everything else is left for Sean
 *   3. bump drafts: one per pitch still `sent`, threaded, older than 12 days
 *   4. processed: the Message-ID of every reply read from a book contact, so the
 *      first live run never answers a reply Sean already handled by hand
 * @returns {{patches: {id: string, patch: object, contactStatus?: string}[], drafts: object[], notes: string[], processed: string[]}}
 */
export function planBackfill({ book, sentCopies = [], replies = [], now = Date.now(), drafts = [] } = {}) {
  const patches = [];
  const out = [];
  const notes = [];
  const bookEmails = new Set(book.contacts.map(emailOf).filter(Boolean));
  const processed = [...new Set(replies.filter((m) => m.messageId && bookEmails.has(String(m.from || '').toLowerCase())).map((m) => m.messageId))];
  for (const c of book.contacts) {
    const p = lastPitch(c);
    if (!p || p.outcome !== 'sent') continue;
    const email = emailOf(c);
    if (!email) continue;
    const pitchStart = Date.parse(`${p.date}T00:00:00Z`);
    const patch = {};
    let messageId = p.message_id || null;
    let lastSent = p.last_sent_at || null;

    // 1. thread ids. Exact subject (case-folded, "Re:" NOT stripped, so Sean's later
    // reply never matches), on or after the pitch date, earliest wins.
    let threadOk = true;
    if (!messageId) {
      const want = fold(p.subject);
      if (!want) {
        notes.push(`${c.name} (${c.id}): no subject recorded; cannot match the Sent copy safely`);
        threadOk = false;
      } else {
        const copy = sentCopies
          .filter((m) => (m.to || []).some((a) => String(a).toLowerCase() === email) && m.messageId && fold(m.subject) === want && Date.parse(m.date) >= pitchStart)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
        if (!copy) {
          notes.push(`${c.name} (${c.id}): no Sent copy of "${p.subject}" found, so no thread id and no follow-up`);
          threadOk = false;
        } else {
          messageId = copy.messageId;
          lastSent = new Date(Date.parse(copy.date)).toISOString();
          patch.message_id = messageId;
          patch.subject = copy.subject;
          patch.last_sent_at = lastSent;
          // A hand-sent September pitch never gets AUTOMATIC follow-ups: its one
          // follow-up is the bump draft below, which only sends once Sean approves it.
          patch.follow_ups_sent = MAX_FOLLOW_UPS;
          notes.push(`${c.name} (${c.id}): thread id found (${messageId})`);
        }
      }
    }

    // 2. replies since the pitch (scanned whether or not a Sent copy was found)
    let conversation = false;
    let declined = false;
    for (const m of replies.filter((r) => String(r.from || '').toLowerCase() === email && Date.parse(r.date) >= pitchStart)) {
      const v = classifyReply(m);
      if (v.kind === 'ignore') { notes.push(`${c.name} (${c.id}): ignored a message (${v.reason})`); continue; }
      conversation = true;
      const said = String(m.text || '').replace(/\s+/g, ' ').slice(0, 120);
      if (v.kind === 'decline' || v.kind === 'opt-out') {
        declined = true;
        patch.outcome = 'declined';
        notes.push(`${c.name} (${c.id}): ${v.kind} reply, marked declined${v.kind === 'opt-out' ? ' and do_not_contact' : ''}: "${said}"`);
        if (v.kind === 'opt-out') patches.push({ id: c.id, patch: {}, contactStatus: 'do_not_contact' });
      } else {
        notes.push(`${c.name} (${c.id}): ${v.kind} reply NOT acted on, for Sean${v.reason ? ` (${v.reason})` : ''}: "${said}"`);
      }
    }
    if (Object.keys(patch).length) patches.push({ id: c.id, patch });
    if (!threadOk || declined || conversation) continue;

    // 3. bump draft
    const age = (now - Date.parse(lastSent || `${p.date}T00:00:00Z`)) / DAY;
    if (age <= BUMP_AFTER_DAYS) continue;
    if (drafts.some((d) => d.contact_id === c.id && ['pending', 'approved'].includes(d.status))) {
      notes.push(`${c.name} (${c.id}): a draft is already waiting, no bump created`);
      continue;
    }
    const subject = reSubject(patch.subject || p.subject);
    out.push(newDraft({
      kind: 'bump', contactId: c.id, to: email, subject, text: bumpText({ firstName: firstName(c) }),
      inReplyTo: messageId, references: [messageId], concept: p.concept || 'intro', products: p.products || [], now,
    }));
  }
  return { patches, drafts: out, notes, processed };
}

/**
 * Pure: the book and state a backfill plan leaves behind. `state` may be null
 * (no state file yet), in which case a fresh one is created; either way every
 * reply the backfill read is marked processed.
 */
export function applyBackfill({ book, plan, state, now = Date.now() }) {
  let next = book;
  for (const { id, patch, contactStatus } of plan.patches) {
    if (Object.keys(patch).length) next = updatePitch(next, id, patch);
    if (contactStatus) next = { ...next, contacts: next.contacts.map((x) => (x.id === id ? { ...x, status: contactStatus } : x)) };
  }
  const st = state ? { ...state, processed: [...(state.processed || [])] } : emptyState(now);
  st.sends ||= [];
  st.escalated ||= {};
  return { book: next, state: markProcessed(st, plan.processed || []) };
}

/** `id=outcome[:order]` -> { id, outcome, sampleOrder } or throws. */
export function parseSet(arg) {
  const m = /^([^=]+)=([^:]+)(?::(.+))?$/.exec(String(arg || ''));
  if (!m) throw new Error(`--set wants <id>=<outcome>[:<order>], got "${arg}"`);
  if (!PITCH_OUTCOMES.includes(m[2])) throw new Error(`--set outcome "${m[2]}" must be one of ${PITCH_OUTCOMES.join(', ')}`);
  return { id: m[1], outcome: m[2], sampleOrder: m[3] || null };
}

export function escalationEmail(contact, msg, reason) {
  const p = lastPitch(contact);
  return {
    subject: `Press outreach: ${contact.name} needs your reply`,
    body: [
      `${contact.name} <${emailOf(contact) || 'no email on file'}> wrote:`,
      `Outlet: ${(contact.domains || []).join(', ') || 'unknown'}`,
      `Our pitch: ${p?.subject || '(no subject recorded)'}`,
      '', msg?.fullText || msg?.text || '', '',
      `Why it came to you: ${reason}`,
      'Nothing was sent to them. The agent will not reply to or follow up with this contact until you do.',
      '', 'Reply to them from Hushmail. Your reply is detected automatically and the agent picks the thread back up.',
    ].join('\n'),
  };
}

export function renderSummary(r, { apply, drafts = [], dashboardUrl = null } = {}) {
  const lines = [apply ? '' : 'DRY RUN: nothing was sent.'];
  if (r.paused) lines.push('PAUSED: nothing sends until `node agents/press-outreach/index.js --resume`.');
  if (r.imapDown) lines.push('IMAP was unavailable: replies and follow-ups were skipped this run.');
  if (r.sent.length) { lines.push(`${apply ? 'Sent' : 'Would send'} from approved drafts:`); for (const s of r.sent) lines.push(`  - ${s.kind} to ${s.id}`); }
  if (r.followUps.length) { lines.push('Follow-ups:'); for (const f of r.followUps) lines.push(`  - ${f.name}: follow-up ${f.n}`); }
  if (r.replies.length) { lines.push('Replies handled:'); for (const x of r.replies) lines.push(`  - ${x.name}: ${x.kind}`); }
  if (r.escalations.length) { lines.push('Sent to Sean (nothing went to the writer):'); for (const x of r.escalations) lines.push(`  - ${x.name}: ${x.reason}`); }
  if (r.expired.length) lines.push(`Expired drafts: ${r.expired.map((e) => e.id).join(', ')}`);
  if (r.skipped.length) { lines.push('Held:'); for (const s of r.skipped) lines.push(`  - ${s.name || s.id}: ${s.reason}`); }
  if (r.failed?.length) { lines.push('FAILED (retried next run):'); for (const f of r.failed) lines.push(`  - ${f.name || f.id} (${f.kind}): ${f.error}`); }
  const pending = drafts.filter((d) => d.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (pending.length) {
    const where = dashboardUrl ? `${dashboardUrl.replace(/\/$/, '')}/#outreach` : 'the dashboard, #outreach';
    lines.push(`${pending.length} ${pending.length === 1 ? 'pitch' : 'pitches'} waiting for approval: ${where}`);
    for (const d of pending.slice(0, 5)) lines.push(`  - ${d.contact_id}: ${d.subject} (drafted ${d.created_at.slice(0, 10)})`);
  }
  const subject = `Press outreach: ${r.sent.length} sent · ${r.followUps.length} follow-ups · ${r.replies.length} replies · ${r.escalations.length} escalated${r.failed?.length ? ` · ${r.failed.length} FAILED` : ''}`;
  return { subject, body: lines.filter((l, i) => i > 0 || l).join('\n') || 'Nothing to do.' };
}

/** Single-instance guard, the same 25-minute staleness rule as creator-outreach. */
function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  if (existsSync(LOCK_PATH) && Date.now() - statSync(LOCK_PATH).mtimeMs < 25 * 60_000) return false;
  writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}
/** A run sleeps between sends; keep the lock fresh so it is never read as stale mid-run. */
function touchLock() { try { const t = new Date(); utimesSync(LOCK_PATH, t, t); } catch { /* best effort */ } }

function refusedToday(tag) {
  const marker = join(PRESS_DIR, `.refused-${tag}-${new Date().toISOString().slice(0, 10)}`);
  if (existsSync(marker)) return true;
  mkdirSync(PRESS_DIR, { recursive: true });
  writeFileSync(marker, '');
  return false;
}

/** Pull Resend's delivery outcome for recent sends, then auto-pause on complaints or bounces. */
async function refreshEvents(state, env, nowMs) {
  if (!env.RESEND_API_KEY) return;
  const stale = state.sends.filter((s) => s.last_event === 'sent' && s.resend_id && nowMs - Date.parse(s.at) > 3_600_000).slice(0, 20);
  for (const s of stale) {
    try {
      const res = await fetch(`https://api.resend.com/emails/${s.resend_id}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
      if (!res.ok) continue;
      const body = await res.json();
      if (body.last_event) s.last_event = body.last_event;
    } catch { /* next run tries again */ }
  }
}

function readStreak() { try { return JSON.parse(readFileSync(TRANSIENT_PATH, 'utf8')); } catch { return null; } }
function writeStreak(v) {
  try { if (v) writeFileSync(TRANSIENT_PATH, JSON.stringify(v)); else if (existsSync(TRANSIENT_PATH)) unlinkSync(TRANSIENT_PATH); } catch { /* best effort */ }
}

async function runBackfill(args, apply, creds) {
  if (apply && !acquireLock()) throw new Error('another press-outreach run holds the lock (data/press/.lock); try again in a few minutes');
  try {
    const sets = [];
    args.forEach((a, i) => { if (a === '--set') sets.push(parseSet(args[i + 1])); });
    const loaded = readBook();
    if (!loaded.available) throw new Error(`contact book unavailable: ${loaded.reason}`);
    if (!creds) throw new Error('HUSHMAIL_USER / HUSHMAIL_PASSWORD are not in .env');
    let book = loaded.doc;
    const now = Date.now();
    for (const s of sets) {
      const patch = { outcome: s.outcome, ...(s.sampleOrder ? { sample_order: s.sampleOrder } : {}) };
      console.log(`${apply ? '' : '[dry run] would '}set ${s.id}: ${JSON.stringify(patch)}`);
      book = updatePitch(book, s.id, patch);
    }
    const senders = [...openPitchByAddress(book.contacts).keys()];
    const since = new Date(now - 90 * DAY);
    const replies = senders.length ? await fetchFromAllFolders(creds, { senders, since }) : [];
    const sentCopies = senders.length ? await fetchSentTo(creds, { recipients: senders, since }) : [];
    const draftsDir = join(ROOT, DRAFTS_DIR);
    const existing = loadDrafts(draftsDir);
    const plan = planBackfill({ book, sentCopies, replies, now, drafts: existing });
    for (const n of plan.notes) console.log(`  ${n}`);
    console.log(`${plan.patches.length} patches, ${plan.drafts.length} bump drafts${apply ? '' : ' (dry run: nothing written; add --apply)'}`);
    for (const d of plan.drafts) console.log(`  bump ${d.id}: ${d.subject}`);
    console.log(`${plan.processed.length} replies marked as already handled`);
    if (apply) {
      const applied = applyBackfill({ book, plan, state: readState(), now });
      book = applied.book;
      writeBook(book);
      writeState(applied.state);
      for (const d of plan.drafts) {
        try { saveDraftFile(draftsDir, d); } catch (err) { console.log(`  could not save ${d.id}: ${err.message}`); }
      }
      console.log('backfill applied');
    }
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const env = loadEnv();
  const config = loadConfig();
  const creds = hushmailCredentials(env);

  if (args.includes('--test-send')) {
    const to = args[args.indexOf('--test-send') + 1];
    if (!creds) throw new Error('HUSHMAIL_USER / HUSHMAIL_PASSWORD are not in .env');
    const r = await sendMail(creds, { to, subject: 'Press outreach test', text: 'This is a test from the press-outreach agent.\n\nSean', agent: 'press-outreach' }, { via: config.sendVia, resendKey: env.RESEND_API_KEY, agent: 'press-outreach' });
    console.log(`sent test to ${to} via ${config.sendVia}: ${r.messageId}`);
    return { imapDown: false };
  }
  if (args.includes('--resume')) {
    const state = readState();
    if (!state) throw new Error(`no state file at ${STATE_PATH}`);
    delete state.paused;
    writeState(state);
    console.log('press outreach resumed');
    return { imapDown: false };
  }
  if (args.includes('--backfill')) {
    await runBackfill(args, apply, creds);
    return { imapDown: false };
  }

  console.log(`Press outreach${apply ? '' : ' (dry run)'}`);
  if (!config.enabled) { console.log('disabled in config/press-outreach.json'); return { imapDown: false }; }
  if (!creds) { console.log('HUSHMAIL_USER / HUSHMAIL_PASSWORD not in .env; nothing to do'); return { imapDown: false }; }

  // The lock comes BEFORE the book and state are read: a run that read them
  // while another run was still writing would act on a stale copy.
  if (apply && !acquireLock()) { console.log('another run is in progress'); return { imapDown: false }; }
  try {
    const loaded = readBook();
    if (!loaded.available) {
      if (!apply) { console.log(`contact book unavailable: ${loaded.reason}`); return { imapDown: false }; }
      // Cron runs every 30 minutes: report the refusal once a day, not 48 times.
      if (refusedToday('book')) { console.log('contact book unavailable; refusal already reported today'); return { imapDown: false }; }
      throw new Error(`Refusing to send: ${loaded.reason}. Without the contact book the agent cannot know who it already pitched.`);
    }

    let state = readState();
    if (!state) {
      if (apply && !args.includes('--init')) {
        if (refusedToday('state')) { console.log('no state file; refusal already reported today'); return { imapDown: false }; }
        throw new Error(`no state file at ${STATE_PATH}. Refusing to send: without it every reply would be handled again. Restore it from backup, or run once with --init if this is genuinely the first run.`);
      }
      if (apply) {
        // --init: every reply already in the mailbox was Sean's to answer.
        state = await initState({ book: loaded.doc, readReplies: (q) => fetchFromAllFolders(creds, q) });
        writeState(state);
        console.log(`state created; ${state.processed.length} existing replies marked as already handled`);
      } else {
        state = emptyState();
      }
    }
    const postalAddress = readPostalAddress();
    const drafts = loadDrafts(join(ROOT, DRAFTS_DIR));
    const run = await runPressOutreach({
      env, apply, config, book: loaded.doc, state, drafts, postalAddress,
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, ms)); touchLock(); },
      escalate: async (c, msg, reason) => { await notify({ ...escalationEmail(c, msg, reason), status: 'info', category: 'press', immediate: true }); },
    });

    if (apply) {
      await refreshEvents(state, env, Date.now());
      const verdict = shouldPause(state.sends);
      if (verdict.pause && !state.paused) {
        state.paused = { at: new Date().toISOString(), reason: verdict.reason };
        run.paused = true;
        await notify({ immediate: true, status: 'info', category: 'press', subject: 'Press outreach PAUSED', body: `${verdict.reason}. Run node agents/press-outreach/index.js --resume after checking Resend.` });
      }
      writeState(state);
    }

    const { subject, body } = renderSummary(run, { apply, drafts: loadDrafts(join(ROOT, DRAFTS_DIR)), dashboardUrl: process.env.DASHBOARD_URL || env.DASHBOARD_URL || null });
    const noAddress = postalAddress ? '' : '\nNo postal_address in data/brand/brand-kit.json: first pitches are refused until it is set.';
    console.log(`\n${subject}\n\n${body}${noAddress}`);
    const acted = run.sent.length || run.followUps.length || run.replies.length || run.escalations.length || run.expired.length || run.failed.length;
    if (apply && acted) await notify({ subject, body: body + noAddress, status: 'info', category: 'press' });
    return run;
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

async function reportFailure(err) {
  try {
    await notify({ subject: 'Press outreach failed', body: String(err?.stack || err), status: 'error', category: 'press' });
  } catch { /* the console already has it */ }
}

if (isDirectRun(import.meta.url)) {
  main().then(async (run) => {
    // An IMAP outage inside the run is caught (first pitches still go), so the
    // streak is counted here as well as in the crash path below.
    if (!run?.imapDown) { writeStreak(null); return; }
    const { next, report } = transientStreak(readStreak(), { failed: true });
    writeStreak(next);
    if (report) await reportFailure(new Error(`IMAP has been unreachable ${next.count} consecutive runs since ${next.since}`));
    else console.error(`IMAP unavailable ${next.count}/${TRANSIENT_ESCALATE_AFTER}; the next run retries, not reported`);
  }).catch(async (err) => {
    console.error(err);
    if (isTransientNetworkError(err)) {
      const { next, report } = transientStreak(readStreak(), { failed: true });
      writeStreak(next);
      if (!report) {
        console.error(`transient connection failure ${next.count}/${TRANSIENT_ESCALATE_AFTER}; the next run retries, not reported`);
        process.exit(0);
      }
      err = new Error(`IMAP connection has failed ${next.count} consecutive runs since ${next.since}: ${err.message}`);
    }
    await reportFailure(err);
    process.exit(1);
  });
}
