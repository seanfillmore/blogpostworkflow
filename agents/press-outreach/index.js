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
 *   5. sends NO follow-up on its own: the daily --draft run writes one per due
 *      thread (lib/press-followup.js, at most 2 per pitch, days 5 and 12) and
 *      it sends in step 6 only once Sean approves it
 *   5b. samples (lib/press-samples.js): an address becomes a $0 "PR Package"
 *      order when the app holds write_draft_orders (else Sean is asked to place
 *      it); any PR Package order for an accepted sample, hand-made ones too, is
 *      found by shipping name or email, its tracking emailed once it ships, and
 *      one check-in sent 21 days after delivery if the thread stayed quiet
 *   6. sends first pitches and follow-ups ONLY from drafts Sean approved (sendOrder)
 *
 * Usage:
 *   node agents/press-outreach/index.js                    # dry run: plan, send nothing
 *   node agents/press-outreach/index.js --apply            # send (cron does this)
 *   node agents/press-outreach/index.js --apply --init     # first run: create the state file, marking
 *                                                          # every reply already in the mailbox handled
 *   node agents/press-outreach/index.js --test-send you@example.com
 *   node agents/press-outreach/index.js --resume           # clear an auto-pause
 *   node agents/press-outreach/index.js --backfill [--apply] [--set <id>=<outcome>[:<order>]]...
 *                                                          # one-off: thread ids, existing replies, follow-up drafts
 *   node agents/press-outreach/index.js --redraft-bumps [--apply]
 *                                                          # replace old fixed-template bump drafts with written follow-ups
 *   node agents/press-outreach/index.js --redraft-followups [--apply]
 *                                                          # rewrite every pending follow-up draft as one batch (variety rules)
 *   node agents/press-outreach/index.js --draft [--apply] [--limit <n>]
 *                                                          # daily: follow-up drafts for due threads, then pitch drafts, for approval
 *                                                          # (--limit overrides the queue target; a dry run skips Hunter)
 *   node agents/press-outreach/index.js --check-links [--apply]
 *                                                          # weekly (Mon 14:25 UTC): find earned links and mentions
 *                                                          # among engaged pitches, then send the funnel digest
 *
 * Cron (UTC, scripts/setup-cron.sh):
 *   17,47 * * * *   --apply              replies, escalations, samples, Sean-approved sends
 *   20 14 * * *     --draft --apply       follow-up drafts for due threads first, then the prospect queue (~70% pr-target-finder, ~30% backlink-opportunity),
 *                                         at most 10 drafts a run, no new prospect after 15:30 UTC
 *   25 14 * * 1     --check-links --apply earned-link check and funnel digest
 *   (--backfill was a one-time run, done 2026-10-04; --resume, --init and --test-send are by hand.)
 * Every first pitch and follow-up waits for Sean's approval in the dashboard Outreach tab. Sends happen only Mon-Fri
 * 16:00-24:00 UTC, at least minGapMinutes apart, under a daily cap of 10 that ramps to 25 after 14 days with no
 * auto-pause. A spam complaint or a >3% hard-bounce rate over the last 50 sends pauses everything until --resume.
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

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync, copyFileSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { hushmailCredentials, sendMail, fetchFromAllFolders, fetchSentTo, fetchSentBodiesTo, isTransientNetworkError } from '../../lib/hushmail.js';
import {
  loadContacts, validateContacts, recordPitch, updatePitch, autoFollowUpsDue, openPitchByAddress,
  emailOf, lastPitch, MAX_FOLLOW_UPS, PRESS_CONTACTS_PATH, PITCHABLE_STATUSES, PITCH_OUTCOMES,
  OPEN_OUTCOMES, DEFAULT_COOLDOWN_DAYS, normalizeDomain,
} from '../../lib/press-contacts.js';
import { buildProspects, draftBlockReason } from '../../lib/press-prospects.js';
import { findAddress as findAddressLib, hunterClient, tavilyClient } from '../../lib/contact-finder.js';
import { buildFactSheet, draftPitch as draftPitchLib } from '../../lib/press-pitch.js';
import { fetchWithOutcome, renderOutcomeTally } from '../../lib/fetch-pool.js';
import { checkLinks, applyLinkFindings, funnel, renderFunnel, referringDomainsChange, articleLinks } from '../../lib/press-links.js';
import { draftFollowUp as draftFollowUpLib, pickNewFact, isArticleUrl, offerGiftHook, createFollowUpRun } from '../../lib/press-followup.js';
import { DRAFTS_DIR, newDraft, markSent, expireDrafts, sendOrder, loadDrafts, saveDraft as saveDraftFile } from '../../lib/press-drafts.js';
import { classifyReply } from '../../lib/press-replies.js';
import {
  DEFAULT_CONFIG, inSendWindow, dailyCap, stripDashes, askAddressText,
  checkOutgoingCopy, shouldPause, firstName, OPT_OUT_LINE,
} from '../../lib/press-outreach.js';
import {
  hasDraftOrderScope, fetchPrPackageOrders, fetchOrderByName, countMonthKits, planSample, buildDraftOrderInput,
  createSampleOrder, matchOrder, trackingOf, deliveredAtOf, checkinDue, thanksText, trackingText, checkinText,
  orderRequestEmail, defaultGraphql,
} from '../../lib/press-samples.js';
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
const PRESS_FACTS_PATH = join(ROOT, 'config', 'press-facts.json');
const LOOKBACK_DAYS = 45;
const DAY = 86_400_000;
const MAX_PROCESSED = 2000;
const MAX_REFS = 20;
const CONFIRM_MODEL = LLM_MODELS.standard;
const SEND_FAILURES_REPORT_AT = 3;
const CHECKIN_GIVE_UP_DAYS = 90;
const AUTO_KINDS = new Set(['sample-yes', 'address-given', 'opt-out', 'decline']);
// Drafts that reply under an existing pitch thread.
const THREADED_KINDS = new Set(['followup', 'bump']);

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

/**
 * config/press-facts.json, the only source of facts a pitch may use. Missing,
 * unparseable or product-less refuses the drafting run: there is no fallback
 * to another file, because a silent fallback is how an unvetted fact ships.
 */
export function loadPressFacts(path = PRESS_FACTS_PATH) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch (err) { throw new Error(`Refusing to draft: cannot read ${path} (${err.code || err.message})`); }
  let doc;
  try { doc = JSON.parse(raw); } catch (err) { throw new Error(`Refusing to draft: ${path} is not valid JSON (${err.message})`); }
  if (!doc || typeof doc !== 'object' || !doc.products || typeof doc.products !== 'object' || !Object.keys(doc.products).length) {
    throw new Error(`Refusing to draft: ${path} has no products`);
  }
  return doc;
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
  const senders = [...openPitchByAddress(book.contacts, now).keys()];
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
  now: nowArg = Date.now(),
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
  tellSean = async () => {},
  graphql = defaultGraphql,
  confirmReply,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  postalAddress = null,
  reportError = async (subject, body) => notify({ subject, body, status: 'error', category: 'press' }),
  log = console.log,
} = {}) {
  // `now` may be a number (the run's time) or a clock function. The run's
  // decisions use its start time; every SEND re-reads the clock, so a run that
  // started inside the window cannot send after it closes (M1).
  const clock = typeof nowArg === 'function' ? nowArg : () => nowArg;
  const now = clock();
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
    onAddress = async (c) => { log(`  [dry run] would record ${c.name}'s address and create a PR Package order (or ask Sean to)`); };
    tellSean = async (m) => { log(`  [dry run] would tell Sean: ${m.subject}`); };
    sleep = async () => {};
    reportError = async (subject) => { log(`  [dry run] would report: ${subject}`); };
  }
  state.sends ||= [];
  state.processed ||= [];
  state.escalated ||= {};
  const result = { replies: [], escalations: [], followUps: [], sent: [], skipped: [], expired: [], failed: [], samples: [], paused: Boolean(state.paused), imapDown: false };
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
  async function doSend(message, { contactId, kind, draftId = null, pitchDate = null, precheck = null, windowed = true }) {
    if (needGap) { await sleep(gapMs); needGap = false; }
    if (windowed && !inSendWindow(clock())) return { skipped: 'outside the send window now; waits for the next window' };
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
    const sentAt = isoOf(clock());
    // draft_id / pitch_date make a send recognisable on the next run even if every
    // bookkeeping write after it failed, so it is never sent a second time.
    state.sends.push({
      at: sentAt, contact_id: contactId, kind,
      ...(draftId ? { draft_id: draftId } : {}), ...(pitchDate ? { pitch_date: pitchDate } : {}),
      message_id: r.messageId, resend_id: r.resendId || null, last_event: 'sent',
    });
    // Persisted at once, so cap accounting survives a crash before any bookkeeping.
    try { saveState(state); } catch (err) { log(`  could not save state after a send: ${err.message}`); }
    return { ...r, at: sentAt };
  }

  // ── samples ──
  // Whether the app may create draft orders, asked once per run. A failed read
  // counts as "no": the fallback (Sean places the order) is always safe.
  let scopeAnswer = null;
  const mayCreateOrders = async () => {
    if (scopeAnswer === null) {
      try { scopeAnswer = await hasDraftOrderScope({ graphql }); } catch (err) {
        log(`  could not read the app's access scopes (${err.message}); Sean places sample orders this run`);
        scopeAnswer = false;
      }
    }
    return scopeAnswer;
  };
  // The date a sample order for this pitch may carry at the earliest: the PITCH
  // date, never the address date. Sean may place the order by hand before the
  // address reaches the agent, and that order must be adopted, not duplicated.
  const sampleSince = (p) => p.date;
  // Orders this run created: Shopify's order search lags, so they are counted
  // here as well or two addresses in one run could overrun the monthly cap.
  let ordersCreatedThisRun = 0;
  /** Hand the order to Sean: the contact is escalated, so their next message reaches him. */
  const askSeanForOrder = async (c, p, address, msg, reason = null) => {
    // Escalated only once Sean has the email: if it fails this throws, the reply
    // stays unprocessed, and the next run asks him again rather than routing the
    // address to the generic "waiting on you" escalation.
    await tellSean(orderRequestEmail({ contact: c, pitch: p, address, config, reason }));
    state.escalated[c.id] = { at: isoOf(now), reason: reason ? `create the PR Package order (${reason})` : 'address received, create the PR Package order', kind: 'order-request', message_id: msg?.messageId || null };
    result.escalations.push({ id: c.id, name: c.name, reason: `PR Package order needed${reason ? `: ${reason}` : ''}` });
  };
  // An address arrived. With write_draft_orders the agent ships a $0 PR Package
  // order itself (under the monthly cap) and thanks the writer; without it, or
  // when anything about the order is off, Sean gets the address and places it.
  // Never throws for an order problem: a retry could create a second order.
  onAddress ||= async (c, p, address, msg) => {
    if (!(await mayCreateOrders())) return askSeanForOrder(c, p, address, msg);
    const since = sampleSince(p);
    const monthStart = `${new Date(now).toISOString().slice(0, 7)}-01`;
    const earliest = since < monthStart ? since : monthStart;
    const sinceDays = Math.ceil((now - Date.parse(`${earliest}T00:00:00Z`)) / DAY) + 1;
    let orders;
    try { orders = await fetchPrPackageOrders({ sinceDays, now, graphql }); } catch (err) {
      return askSeanForOrder(c, p, address, msg, `could not read existing PR Package orders: ${err.message}`);
    }
    // An order for them may already exist (Sean made one, or an earlier run did): adopt it.
    let name = matchOrder(orders, { contact: c, email: emailOf(c), sinceDate: since })?.name || null;
    let action = `adopted existing order ${name}`;
    if (!name) {
      const plan = planSample({ pitch: p, address, config, monthKits: countMonthKits(orders, now) + ordersCreatedThisRun });
      if (!plan.ok) return askSeanForOrder(c, p, address, msg, plan.reason);
      try {
        ({ name } = await createSampleOrder(buildDraftOrderInput({ contact: c, pitch: p, address, lines: plan.lines }), { graphql }));
      } catch (err) {
        const draft = err.draft ? ` after draft ${err.draft.name} (${err.draft.id}) was created; check Shopify for this draft/order before creating one` : '';
        return askSeanForOrder(c, p, address, msg, `order creation failed${draft}: ${err.message}`);
      }
      ordersCreatedThisRun += 1;
      action = `$0 PR Package order ${name} created`;
    }
    commit(updatePitch(book, c.id, { outcome: 'samples-sent', sample_order: name }), { id: c.id, name: c.name, kind: 'sample-order' });
    result.samples.push({ id: c.id, name: c.name, action });
    if (state.sends.some((s) => s.contact_id === c.id && s.kind === 'sample-thanks' && s.pitch_date === p.date)) return;
    if (!canSend()) { result.skipped.push({ id: c.id, name: c.name, reason: 'sample thanks skipped: send cap reached (tracking still follows)' }); return; }
    const text = stripDashes(thanksText({ firstName: firstName(c) }));
    const subject = stripDashes(reSubject(msg?.subject || p.subject));
    const gate = checkOutgoingCopy({ subject, text, kind: 'followup' });
    if (!gate.ok) { result.skipped.push({ id: c.id, name: c.name, reason: `sample thanks failed the copy gate: ${gate.problems.join('; ')}` }); return; }
    const refs = refsOf(msg?.references, msg?.messageId);
    let r;
    try {
      // A reply in an open conversation, like the address request: not held to the window.
      r = await doSend({ to: emailOf(c), subject, text, inReplyTo: msg?.messageId, references: refs.join(' ') }, { contactId: c.id, kind: 'sample-thanks', pitchDate: p.date, windowed: false });
    } catch (err) {
      result.failed.push({ id: c.id, name: c.name, kind: 'sample-thanks', error: err.message });
      return;
    }
    if (r.skipped) return;
    commitAfterSend(c.id, { last_sent_at: r.at, references: refsOf(refs, r.messageId) }, { id: c.id, name: c.name, kind: 'sample-thanks' });
  };

  /**
   * Tracking and the day-21 check-in, for agent-made and hand-made orders alike.
   * Finds each accepted sample's PR Package order, records it, emails tracking
   * once a fulfillment has a URL, and checks in 21 days after delivery unless the
   * writer (or Sean) has said anything since the tracking email.
   */
  async function sampleFollowThrough() {
    const pending = book.contacts.filter((c) => {
      if (!PITCHABLE_STATUSES.includes(c.status) || !emailOf(c)) return false;
      const p = lastPitch(c);
      return p && ['sample-accepted', 'samples-sent'].includes(p.outcome) && (!p.tracking_sent_at || (!p.checkin_sent_at && !p.checkin_skipped_at));
    });
    if (!pending.length) return;
    const earliest = pending.map((c) => sampleSince(lastPitch(c))).sort()[0];
    const sinceDays = Math.min(180, Math.ceil((now - Date.parse(`${earliest}T00:00:00Z`)) / DAY) + 1);
    let orders;
    try { orders = await fetchPrPackageOrders({ sinceDays, now, graphql }); } catch (err) {
      result.failed.push({ id: 'samples', kind: 'sample-orders', error: `could not read PR Package orders: ${err.message}` });
      return;
    }
    for (const c0 of pending) {
      let c = find(c0.id);
      let p = lastPitch(c);
      const row = { id: c.id, name: c.name };
      if (held.has(c.id)) { result.skipped.push({ ...row, reason: 'sample follow-through held: a reply from them is still being handled' }); continue; }
      let order = p.sample_order ? orders.find((o) => o.name === p.sample_order) : matchOrder(orders, { contact: c, email: emailOf(c), sinceDate: sampleSince(p) });
      if (!order && p.sample_order) {
        try { order = await fetchOrderByName(p.sample_order, { graphql }); } catch (err) {
          result.failed.push({ ...row, kind: 'sample-orders', error: `could not read order ${p.sample_order}: ${err.message}` });
          continue;
        }
      }
      if (!order) continue;
      if (p.outcome !== 'samples-sent' || p.sample_order !== order.name) {
        if (!commit(updatePitch(book, c.id, { outcome: 'samples-sent', sample_order: order.name }), { ...row, kind: 'sample-order' })) continue;
        result.samples.push({ ...row, action: `found PR Package order ${order.name}` });
      }
      // Sean asked to place the order has placed it: the request is done.
      if (state.escalated[c.id]?.kind === 'order-request') { delete state.escalated[c.id]; persistState(row); }
      c = find(c.id);
      p = lastPitch(c);
      if (!p.subject && !p.message_id) { result.skipped.push({ ...row, reason: 'sample email skipped: the pitch has no subject or thread to reply under' }); continue; }
      const subject = stripDashes(p.subject ? reSubject(p.subject) : 'Your Real Skin Care samples');
      const thread = p.message_id ? refsOf(p.references, p.message_id) : [];
      const sendOne = async (kind, text, field) => {
        const prior = state.sends.find((s) => s.contact_id === c.id && s.kind === kind && s.pitch_date === p.date);
        if (prior) {
          commitAfterSend(c.id, { [field]: prior.at }, { ...row, kind });
          result.skipped.push({ ...row, reason: `${kind} was already sent by an earlier run; book repaired` });
          return;
        }
        if (!canSend()) { result.skipped.push({ ...row, reason: `${kind} deferred: send cap reached` }); return; }
        const body = stripDashes(text);
        const gate = checkOutgoingCopy({ subject, text: body, kind: 'followup' });
        if (!gate.ok) { result.skipped.push({ ...row, reason: `${kind} failed the copy gate: ${gate.problems.join('; ')}` }); return; }
        let r;
        try {
          r = await doSend({ to: emailOf(c), subject, text: body, ...(p.message_id ? { inReplyTo: p.message_id, references: thread.join(' ') } : {}) }, { contactId: c.id, kind, pitchDate: p.date });
        } catch (err) {
          result.failed.push({ ...row, kind, error: err.message });
          return;
        }
        if (r.skipped) { result.skipped.push({ ...row, reason: `${kind}: ${r.skipped}` }); return; }
        commitAfterSend(c.id, { [field]: r.at, last_sent_at: r.at, ...(p.message_id ? { references: refsOf(thread, r.messageId) } : {}) }, { ...row, kind });
        result.samples.push({ ...row, action: kind === 'sample-tracking' ? 'tracking sent' : 'day-21 check-in sent' });
      };
      if (!p.tracking_sent_at) {
        const t = trackingOf(order);
        if (t) await sendOne('sample-tracking', trackingText({ firstName: firstName(c), url: t.url }), 'tracking_sent_at');
        continue;
      }
      const deliveredAt = deliveredAtOf(order);
      // Never delivered (or never scanned) 90 days on: stop asking Shopify about it.
      if (!deliveredAt && now - Date.parse(p.tracking_sent_at) >= CHECKIN_GIVE_UP_DAYS * DAY) {
        if (commit(updatePitch(book, c.id, { checkin_skipped_at: isoOf(now) }), { ...row, kind: 'sample-checkin' })) result.samples.push({ ...row, action: `check-in skipped: no delivery recorded ${CHECKIN_GIVE_UP_DAYS} days after tracking` });
        continue;
      }
      if (p.checkin_sent_at || !checkinDue({ deliveredAt, nowMs: now })) continue;
      // Only a quiet thread gets the check-in, which needs the mail read this run.
      if (result.imapDown || state.escalated[c.id]) continue;
      const after = Date.parse(p.tracking_sent_at);
      if (Date.parse(p.last_sent_at || 0) > after) continue; // Sean wrote since
      if (replies.some((m) => String(m.from || '').toLowerCase() === emailOf(c) && Date.parse(m.date) > after)) continue;
      await sendOne('sample-checkin', checkinText({ firstName: firstName(c) }), 'checkin_sent_at');
    }
  }

  // ── 1. expire drafts ──
  const ex = expireDrafts(drafts, now, config.draftExpiryDays);
  drafts = ex.drafts;
  for (const d of ex.expired) {
    try { saveDraft(d); } catch (err) { log(`  could not save expired draft ${d.id}: ${err.message}`); }
    result.expired.push({ id: d.id, contact_id: d.contact_id });
  }

  // ── 2. read mail ──
  const open = openPitchByAddress(book.contacts, now);
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
          // Only a pitch still at `sent`/`escalated` becomes `replied`; a sample
          // already accepted or shipped keeps that stage.
          if (['escalated', 'sent'].includes(p.outcome)) patch.outcome = 'replied';
        }
        commit(updatePitch(book, c.id, patch), { id: c.id, name: c.name });
        persistState({ id: c.id, name: c.name });
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
        persistState(row);
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
          let sentAt = null;
          try {
            const refs = refsOf(msg.references, msg.messageId);
            const r = await doSend({ to: emailOf(c), subject, text, inReplyTo: msg.messageId, references: refs.join(' ') }, { contactId: c.id, kind: 'ask-address', windowed: false });
            sentAt = r.at;
            sent = true;
          } catch (err) {
            result.failed.push({ ...row, kind: 'ask-address', error: err.message });
            handled = false;
          }
          if (sent) {
            // Sent: the reply is handled whatever happens to the bookkeeping below.
            commitAfterSend(c.id, { outcome: 'sample-accepted', last_sent_at: sentAt }, { ...row, kind: 'ask-address' });
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
      persistState(row);
    }

    // ── 5. follow-ups ──
    // Nothing is sent automatically any more: the daily --draft run writes a
    // personalised follow-up for every due thread, and it sends in step 6 only
    // once Sean has approved it.
  }

  // ── 5b. samples: find orders, send tracking, check in ──
  if (inSendWindow(now)) await sampleFollowThrough();

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
        // A follow-up never lowers the count: follow_ups_sent = max(existing, n).
        const lp = lastPitch(c);
        const later = !lp?.last_sent_at || Date.parse(sentAt) > Date.parse(lp.last_sent_at);
        const n = d.kind === 'followup' ? (d.n === 2 ? 2 : 1) : 1;
        commit(updatePitch(book, c.id, { follow_ups_sent: Math.max(lp?.follow_ups_sent || 0, n), ...(later ? { last_sent_at: sentAt } : {}) }), row);
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
      if (THREADED_KINDS.has(d.kind) && !d.in_reply_to) {
        const problem = 'no in_reply_to: cannot thread this under the pitch';
        if (saveIfUnchanged(d, { ...d, status: 'pending', gate_problems: [problem] }, row)) result.skipped.push({ ...row, reason: `back to pending: ${problem}` });
        continue;
      }
      if (THREADED_KINDS.has(d.kind)) {
        // A follow-up (or an old bump) re-opens a quiet thread. It is only right while the thread is
        // still quiet, which we can only know when the mail was read this run.
        if (result.imapDown || held.has(c.id)) { result.skipped.push({ ...row, reason: `${d.kind} held: replies could not be read this run` }); continue; }
        // Written for an older pitch than the latest one: that thread is over.
        if (lastPitch(c)?.outcome !== 'sent' || (d.pitch_date && d.pitch_date !== lastPitch(c)?.date)) {
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
        const threaded = THREADED_KINDS.has(d.kind) && d.in_reply_to;
        r = await doSend({
          to: d.to, subject, text,
          ...(threaded ? { inReplyTo: d.in_reply_to, references: refsOf(d.references, d.in_reply_to).join(' ') } : {}),
        }, { contactId: c.id, kind: d.kind, draftId: d.id, precheck: () => (draftUnchanged(d) ? null : CHANGED) });
      } catch (err) {
        result.failed.push({ ...row, error: err.message });
        continue;
      }
      if (r.skipped) { result.skipped.push({ ...row, reason: r.skipped }); continue; }
      const sentAt = r.at;
      // Sent: from here on nothing may make it look unsent.
      try { saveDraft(markSent(d, { now: Date.parse(sentAt), messageId: r.messageId, resendId: r.resendId || null })); } catch (err) { log(`  could not save sent draft ${d.id}: ${err.message}`); }
      recordDraftSent(d, c, { messageId: r.messageId, sentAt, subject, row });
      state.first_sent_at ||= sentAt;
      persistState(row);
      result.sent.push({ ...row, to: d.to });
      if (THREADED_KINDS.has(d.kind)) result.followUps.push({ id: c.id, name: c.name, n: d.kind === 'followup' ? d.n : 1, draft_id: d.id });
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
 *   3. follow-up candidates: one per pitch still `sent`, threaded, older than 12
 *      days (runBackfill drafts each through lib/press-followup.js for approval)
 *   4. processed: the Message-ID of every reply read from a book contact, so the
 *      first live run never answers a reply Sean already handled by hand
 * @returns {{patches: {id: string, patch: object, contactStatus?: string}[], followUps: {contactId: string, subject: string, inReplyTo: string, references: string[]}[], notes: string[], processed: string[]}}
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
          // A hand-sent September pitch is never picked up by the due-date
          // follow-ups: its one follow-up is the candidate below, drafted for
          // Sean's approval.
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

    // 3. follow-up candidate
    const age = (now - Date.parse(lastSent || `${p.date}T00:00:00Z`)) / DAY;
    if (age <= BUMP_AFTER_DAYS) continue;
    if (drafts.some((d) => d.contact_id === c.id && ['pending', 'approved'].includes(d.status))) {
      notes.push(`${c.name} (${c.id}): a draft is already waiting, no follow-up drafted`);
      continue;
    }
    // No fixed-template bump any more: the thread becomes a follow-up CANDIDATE,
    // written per writer by lib/press-followup.js and queued for Sean's approval.
    out.push({ contactId: c.id, subject: reSubject(patch.subject || p.subject), inReplyTo: messageId, references: [messageId] });
  }
  return { patches, followUps: out, notes, processed };
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

// ── Follow-ups (written for approval) ───────────────────────────────────────
//
// A follow-up is written per writer by lib/press-followup.js and queued as a
// `followup` draft; it sends only once Sean approves it (step 6 of a run).
// Four callers: the daily --draft run (threads due by the 5/7-day gaps),
// --redraft-bumps (the old fixed-template bumps), --redraft-followups (every
// pending follow-up, rewritten as one batch) and --backfill. Each batch shares
// one createFollowUpRun() state, so no two notes in it open alike or carry the
// same new fact, and only one in three gets the gift-guide hook.

const FOLLOWUP_MAX_ATTEMPTS = 2;
const findOriginalMissing = 'no copy of the original pitch (no sent draft file and no Sent folder copy)';
const RECENT_ARTICLE_MIN_CHARS = 200;
// Links considered on an author page: wider than the link checker's cap,
// because category and landing links are skipped (isArticleUrl).
const RECENT_ARTICLE_LINKS = 60;
const urlKey = (u) => {
  try { const x = new URL(u); return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`; } catch { return null; }
};

/** Pure: is draft `d` a follow-up on THIS pitch (its pitch_date, else its thread id, else drafted since the pitch)? */
export function onPitch(d, pitch) {
  if (d.pitch_date) return d.pitch_date === pitch.date;
  if (d.in_reply_to && pitch.message_id) return d.in_reply_to === pitch.message_id;
  return String(d.created_at || '').slice(0, 10) >= pitch.date;
}

/**
 * Pure: the original pitch we sent this contact, as { subject, body, source }.
 * The pitch's own sent draft file first (matched by the pitch's draft_id or
 * message_id, nothing looser), else its copy in
 * Hushmail's Sent folder (the September pitches Sean sent by hand): the same
 * Message-ID, else the same subject on or after the pitch date, earliest. Null
 * when neither exists; nothing is drafted against a pitch we cannot read.
 */
export function findOriginalPitch({ contact, pitch, drafts = [], sentCopies = [] }) {
  // Only THIS pitch's own draft: never "the newest sent draft for the contact",
  // which for a December pitch could be October's email.
  const mine = drafts.filter((d) => d.kind === 'pitch' && d.status === 'sent' && d.contact_id === contact.id && d.text);
  const file = mine.find((d) => pitch.draft_id && d.id === pitch.draft_id)
    || mine.find((d) => pitch.message_id && d.message_id === pitch.message_id);
  if (file) {
    const body = String(file.text).split(OPT_OUT_LINE)[0].trim();
    if (body) return { subject: file.subject, body, source: 'draft' };
  }
  const email = emailOf(contact);
  const start = Date.parse(`${pitch.date}T00:00:00Z`);
  const theirs = sentCopies.filter((m) => (m.to || []).includes(email) && String(m.text || '').trim());
  const copy = theirs.find((m) => pitch.message_id && m.messageId === pitch.message_id)
    || theirs.filter((m) => fold(m.subject) === fold(pitch.subject) && Date.parse(m.date) >= start)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
  return copy ? { subject: copy.subject || pitch.subject, body: String(copy.text).trim(), source: 'sent-folder' } : null;
}

/**
 * Best effort: the writer's most recent article other than the one we pitched.
 * The author page comes from the contact's own author_url, else the pr-targets
 * report by the contact's domain (or the pitched article's host); the first
 * same-host link on it that looks like an article (isArticleUrl: no category,
 * tag, author or landing page, a slug of 3+ words) and is not the pitched
 * article is fetched. No such link: no article.
 * Null on any failure: a follow-up then leans on the new fact instead.
 */
export async function findRecentArticle({ contact, pitch, authorUrls = new Map(), fetchPage }) {
  if (typeof fetchPage !== 'function') return null;
  const hosts = [...(contact.domains || [])];
  try { hosts.push(new URL(pitch.target_url).hostname); } catch { /* no target url */ }
  const authorUrl = contact.author_url || hosts.map((h) => authorUrls.get(normalizeDomain(h))).find(Boolean) || null;
  if (!authorUrl) return null;
  try {
    const page = await fetchPage(authorUrl);
    if (page?.outcome !== 'ok') return null;
    const pitched = urlKey(pitch.target_url);
    const next = articleLinks(page.html, authorUrl, RECENT_ARTICLE_LINKS).find((u) => isArticleUrl(u) && urlKey(u) !== pitched);
    if (!next) return null;
    const art = await fetchPage(next);
    if (art?.outcome !== 'ok') return null;
    const text = htmlToText(art.html);
    return text.length >= RECENT_ARTICLE_MIN_CHARS ? { url: next, text } : null;
  } catch { return null; }
}

/**
 * Write one follow-up draft for a contact. `thread` is { subject, inReplyTo,
 * references }: what the draft replies under. `run` is the batch's shared
 * createFollowUpRun() state: the openings already taken, the facts already
 * used and the gift-hook rotation. Returns { ok: true, draft } or
 * { ok: false, reason }. Saves nothing.
 */
export async function draftFollowUpForContact({
  contact, pitch, n, thread, drafts = [], sentCopies = [], authorUrls = new Map(), fetchPage, pressFacts,
  generate, run = createFollowUpRun({ drafts }), now = Date.now(), writer = draftFollowUpLib,
}) {
  const original = findOriginalPitch({ contact, pitch, drafts, sentCopies });
  if (!original) return { ok: false, reason: findOriginalMissing };
  const article = await findRecentArticle({ contact, pitch, authorUrls, fetchPage });
  const fact = pickNewFact(pressFacts, pitch.products || [], original.body, run.facts);
  const giftHook = offerGiftHook({ original, ordinal: run.ordinal, nowMs: now });
  run.ordinal += 1;
  let out;
  try {
    out = await writer({ contact, n, subject: thread.subject, original, article, fact, generate, usedOpenings: run.openings, giftHook, now });
  } catch (err) {
    return { ok: false, reason: `writer error: ${err.message}` };
  }
  if (!out?.ok) return { ok: false, reason: out?.reason || 'follow-up rejected' };
  if (fact) run.facts.add(fact);
  return {
    ok: true,
    draft: {
      ...newDraft({
        kind: 'followup', n, contactId: contact.id, to: emailOf(contact), subject: stripDashes(thread.subject), text: out.text,
        inReplyTo: thread.inReplyTo, references: thread.references || [], concept: pitch.concept || 'intro',
        products: pitch.products || [], targetUrl: pitch.target_url || null, source: pitch.source || 'manual', now,
      }),
      article_url: article?.url || null,
      article_quote: out.articleQuote || null,
      new_fact: fact,
      gift_hook: giftHook,
      original_source: original.source,
      pitch_date: pitch.date,
    },
  };
}

/** Sent-folder copies for `contacts`, read once; [] (and the reason) when the read fails. */
async function loadSentCopies(readSentBodies, contacts, nowMs, log) {
  if (typeof readSentBodies !== 'function' || !contacts.length) return { rows: [], error: readSentBodies ? null : 'no mailbox reader' };
  const dates = contacts.map((x) => Date.parse(`${x.pitch.date}T00:00:00Z`)).filter(Number.isFinite);
  const since = new Date(Math.min(...dates, nowMs) - DAY);
  try {
    return { rows: await readSentBodies({ recipients: [...new Set(contacts.map((x) => emailOf(x.contact)).filter(Boolean))], since }), error: null };
  } catch (err) {
    log(`  could not read the Sent folder (${err.message}); follow-ups without a sent draft file wait for the next run`);
    return { rows: [], error: err.message };
  }
}

/**
 * --redraft-bumps: replace every PENDING or APPROVED `bump` draft (the old
 * fixed-template re-opens) with a model-written `followup` n=1 for the same
 * thread. The bump is moved to data/press/backups/oldbump-<file>, never
 * deleted, and only once its follow-up is written: a bump whose follow-up
 * fails stays in the queue, reported, so the thread is never left with no
 * follow-up at all (these threads carry follow_ups_sent 2 from the backfill,
 * so the due-date follow-ups never pick them up). A dry run lists the plan and
 * calls no model.
 */
export async function runRedraftBumps({
  apply = false, now = Date.now(), book, drafts = [], pressFacts, authorUrls = new Map(), fetchPage, readSentBodies,
  generate, writer = draftFollowUpLib, moveAside, restore, saveDraft, log = console.log,
} = {}) {
  const result = { redrafted: [], wouldRedraft: [], failed: [], skipped: [] };
  const bumps = drafts.filter((d) => d.kind === 'bump' && ['pending', 'approved'].includes(d.status));
  const plan = [];
  for (const b of bumps) {
    const contact = book.contacts.find((c) => c.id === b.contact_id);
    const pitch = contact && lastPitch(contact);
    if (!contact || !emailOf(contact)) { result.skipped.push({ draftId: b.id, contactId: b.contact_id, reason: 'contact not in the book or has no email' }); continue; }
    if (!pitch || pitch.outcome !== 'sent') { result.skipped.push({ draftId: b.id, contactId: contact.id, reason: `thread moved on (pitch is ${pitch?.outcome || 'missing'}); the bump expires on its own` }); continue; }
    if (drafts.some((d) => d.kind === 'followup' && d.contact_id === contact.id && ['pending', 'approved'].includes(d.status))) {
      result.skipped.push({ draftId: b.id, contactId: contact.id, reason: 'a follow-up draft is already waiting' });
      continue;
    }
    const prior = drafts.find((d) => d.kind === 'followup' && d.n === 1 && d.contact_id === contact.id && onPitch(d, pitch));
    if (prior) {
      result.skipped.push({ draftId: b.id, contactId: contact.id, reason: `a follow-up 1 for this pitch already exists (${prior.id}, ${prior.status})` });
      continue;
    }
    plan.push({ bump: b, contact, pitch });
  }
  if (!apply) {
    for (const { bump, contact } of plan) {
      result.wouldRedraft.push({ draftId: bump.id, contactId: contact.id });
      log(`  [dry run] would move ${bump.id} to backups/oldbump-${bump.id}.json and draft a follow-up for ${contact.id}`);
    }
    return result;
  }
  const sent = await loadSentCopies(readSentBodies, plan, now, log);
  const run = createFollowUpRun({ drafts });
  for (const { bump, contact, pitch } of plan) {
    const row = { draftId: bump.id, contactId: contact.id };
    const thread = {
      subject: bump.subject || reSubject(pitch.subject),
      inReplyTo: bump.in_reply_to || pitch.message_id,
      references: (bump.references || []).length ? bump.references : refsOf(pitch.references, pitch.message_id),
    };
    const out = await draftFollowUpForContact({ contact, pitch, n: 1, thread, drafts, sentCopies: sent.rows, authorUrls, fetchPage, pressFacts, generate, run, now, writer });
    if (!out.ok) { result.failed.push({ ...row, reason: out.reason }); continue; }
    let moved;
    try { moved = moveAside(bump); } catch (err) { result.failed.push({ ...row, reason: `could not move the bump aside: ${err.message}` }); continue; }
    try {
      saveDraft(out.draft);
    } catch (err) {
      try { restore(bump, moved); } catch (e2) { log(`  could not restore ${bump.id} from ${moved}: ${e2.message}`); }
      result.failed.push({ ...row, reason: `could not save the follow-up (bump put back): ${err.message}` });
      continue;
    }
    result.redrafted.push({ ...row, followupId: out.draft.id, backup: moved, articleUrl: out.draft.article_url });
    log(`  ${bump.id} -> ${out.draft.id} (bump kept at ${moved})`);
  }
  return result;
}

export function renderRedraftSummary(r, { apply } = {}) {
  const lines = [apply ? '' : 'DRY RUN: nothing was moved or drafted.'];
  if (r.wouldRedraft.length) { lines.push('Would redraft:'); for (const x of r.wouldRedraft) lines.push(`  - ${x.contactId}: ${x.draftId}`); }
  if (r.redrafted.length) { lines.push('Redrafted (waiting for approval):'); for (const x of r.redrafted) lines.push(`  - ${x.contactId}: ${x.draftId} -> ${x.followupId}${x.articleUrl ? ` (latest piece ${x.articleUrl})` : ''}`); }
  if (r.failed.length) { lines.push('Not redrafted (the bump stays in the queue):'); for (const x of r.failed) lines.push(`  - ${x.contactId}: ${x.reason}`); }
  if (r.skipped.length) { lines.push('Skipped:'); for (const x of r.skipped) lines.push(`  - ${x.contactId}: ${x.reason}`); }
  if (r.redrafted.length || r.wouldRedraft.length) lines.push('Note: approved bumps become PENDING follow-ups that need your re-approval in the Outreach tab.');
  return {
    subject: `Press follow-ups: ${apply ? r.redrafted.length : r.wouldRedraft.length} bumps ${apply ? 'redrafted' : 'to redraft'} · ${r.failed.length} failed · ${r.skipped.length} skipped`,
    body: lines.filter((l, i) => i > 0 || l).join('\n') || 'No bump drafts waiting.',
  };
}

/**
 * --redraft-followups: rewrite every PENDING follow-up draft (kind followup,
 * never approved, never sent) as ONE batch, so the queue-wide variety rules
 * (openings, new facts, the gift-hook rotation) apply across all of them. Same
 * thread (subject, In-Reply-To, References) and same n. Same safety order as
 * --redraft-bumps: the new draft is written (generated) first, then the old
 * one is moved to data/press/backups/oldfollowup-<file>, then the new one is
 * saved, and a failed save puts the old one back. A draft whose rewrite fails
 * stays in the queue, reported. A dry run lists the plan and calls no model.
 */
export async function runRedraftFollowups({
  apply = false, now = Date.now(), book, drafts = [], pressFacts, authorUrls = new Map(), fetchPage, readSentBodies,
  generate, writer = draftFollowUpLib, moveAside, restore, saveDraft, log = console.log,
} = {}) {
  const result = { redrafted: [], wouldRedraft: [], failed: [], skipped: [] };
  const olds = drafts.filter((d) => d.kind === 'followup' && d.status === 'pending' && !d.approved_at && !d.sent_at);
  const plan = [];
  for (const d of olds) {
    const contact = book.contacts.find((c) => c.id === d.contact_id);
    const pitch = contact && lastPitch(contact);
    if (!contact || !emailOf(contact)) { result.skipped.push({ draftId: d.id, contactId: d.contact_id, reason: 'contact not in the book or has no email' }); continue; }
    if (!pitch || !onPitch(d, pitch)) { result.skipped.push({ draftId: d.id, contactId: contact.id, reason: 'the draft is for an older pitch; it expires on its own' }); continue; }
    if (pitch.outcome !== 'sent') { result.skipped.push({ draftId: d.id, contactId: contact.id, reason: `thread moved on (pitch is ${pitch.outcome}); the draft expires on its own` }); continue; }
    plan.push({ old: d, contact, pitch });
  }
  if (!apply) {
    for (const { old, contact } of plan) {
      result.wouldRedraft.push({ draftId: old.id, contactId: contact.id });
      log(`  [dry run] would redraft ${old.id} and move it to backups/oldfollowup-${old.id}.json`);
    }
    return result;
  }
  const sent = await loadSentCopies(readSentBodies, plan, now, log);
  // The drafts being replaced do not hold their openings: they are going away.
  const run = createFollowUpRun({ drafts, exclude: new Set(plan.map((x) => x.old.id)) });
  for (const { old, contact, pitch } of plan) {
    const row = { draftId: old.id, contactId: contact.id };
    const n = old.n === 2 ? 2 : 1;
    const thread = {
      subject: old.subject || reSubject(pitch.subject),
      inReplyTo: old.in_reply_to || pitch.message_id,
      references: (old.references || []).length ? old.references : refsOf(pitch.references, pitch.message_id),
    };
    const out = await draftFollowUpForContact({ contact, pitch, n, thread, drafts, sentCopies: sent.rows, authorUrls, fetchPage, pressFacts, generate, run, now, writer });
    if (!out.ok) { result.failed.push({ ...row, reason: out.reason }); continue; }
    let moved;
    try { moved = moveAside(old); } catch (err) { result.failed.push({ ...row, reason: `could not move the old draft aside: ${err.message}` }); continue; }
    try {
      saveDraft(out.draft);
    } catch (err) {
      try { restore(old, moved); } catch (e2) { log(`  could not restore ${old.id} from ${moved}: ${e2.message}`); }
      result.failed.push({ ...row, reason: `could not save the new draft (old one put back): ${err.message}` });
      continue;
    }
    result.redrafted.push({ ...row, newId: out.draft.id, backup: moved, fact: out.draft.new_fact, giftHook: out.draft.gift_hook, articleUrl: out.draft.article_url });
    log(`  ${old.id} -> ${out.draft.id} (old draft kept at ${moved})`);
  }
  return result;
}

export function renderRedraftFollowupsSummary(r, { apply } = {}) {
  const lines = [apply ? '' : 'DRY RUN: nothing was moved or drafted.'];
  if (r.wouldRedraft.length) { lines.push('Would redraft:'); for (const x of r.wouldRedraft) lines.push(`  - ${x.contactId}: ${x.draftId}`); }
  if (r.redrafted.length) {
    lines.push('Redrafted (waiting for approval):');
    for (const x of r.redrafted) lines.push(`  - ${x.contactId}: ${x.draftId} -> ${x.newId}${x.fact ? ` · new fact: ${x.fact}` : ''}${x.giftHook ? ' · gift hook' : ''}${x.articleUrl ? ` · latest piece ${x.articleUrl}` : ''}`);
  }
  if (r.failed.length) { lines.push('Not redrafted (the old draft stays in the queue):'); for (const x of r.failed) lines.push(`  - ${x.contactId}: ${x.reason}`); }
  if (r.skipped.length) { lines.push('Skipped:'); for (const x of r.skipped) lines.push(`  - ${x.contactId}: ${x.reason}`); }
  return {
    subject: `Press follow-ups: ${apply ? r.redrafted.length : r.wouldRedraft.length} pending follow-ups ${apply ? 'redrafted' : 'to redraft'} · ${r.failed.length} failed · ${r.skipped.length} skipped`,
    body: lines.filter((l, i) => i > 0 || l).join('\n') || 'No pending follow-up drafts.',
  };
}

// ── Drafting (--draft) ──────────────────────────────────────────────────────

const MAX_DRAFT_ATTEMPTS = 2;

// A drafting run stops STARTING prospects at 15:30 UTC (the 16:00 UTC send
// window needs the lock, and the 15:00 UTC scheduler and Monday LLM jobs share
// a 961 MB box) and never runs longer than this.
const DRAFT_RUN_MAX_MS = 60 * 60_000;
const DRAFT_CUTOFF_UTC = '15:30';

/**
 * The finder runDrafting calls, as wired in production. `opts.hunter === false`
 * runs the FREE pass only: the prospect already cost a Hunter credit on an
 * earlier run (spec §2: no credit is spent on it twice).
 */
export function makeFindAddress({ fetchPage, tavilySearch, hunter, budget = {}, today }) {
  return (p, opts = {}) => findAddressLib(p, { fetchPage, tavilySearch, hunter: opts.hunter === false ? null : hunter, budget, today });
}

/** Pure: the default deadline for a run starting at `startMs`. */
export function defaultDraftDeadline(startMs) {
  const cutoff = Date.parse(`${isoOf(startMs).slice(0, 10)}T${DRAFT_CUTOFF_UTC}:00Z`);
  const cap = startMs + DRAFT_RUN_MAX_MS;
  // A run started after the cutoff (by hand) is bounded by the 60-minute cap alone.
  return startMs < cutoff ? Math.min(cap, cutoff) : cap;
}
const NO_ADDRESS_NOTE = 'no published or verified address';

/** Article HTML to plain text: script/style removed first, then tags, then the common entities. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(Number(d)); } catch { return m; } })
    .replace(/\s+/g, ' ')
    .trim();
}

const kebab = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const domainStem = (d) => kebab(String(d || '').replace(/^www\./, '').split('.')[0]) || 'site';

const foldName = (s) => String(s || '').trim().toLowerCase();
const prospectName = (p) => (p.source === 'link-gap' ? (p.publication || p.domain) : p.person.name);
const onDomainOf = (c, domain) => (c.domains || []).some((d) => normalizeDomain(d) === domain);

/** Pure: the existing contact a prospect IS (same name on the same domain), or null. */
export function resolveExistingContact(book, prospect) {
  const domain = normalizeDomain(prospect.domain) || prospect.domain;
  const name = foldName(prospectName(prospect));
  return (book.contacts || []).find((c) => foldName(c.name) === name && onDomainOf(c, domain)) || null;
}

/** Pure: the contact whose email channels hold `address`, or null. */
export function contactOwning(book, address) {
  const a = foldName(address);
  return (book.contacts || []).find((c) => (c.channels || []).some((ch) => ch.type === 'email' && foldName(ch.address) === a)) || null;
}

/**
 * The sender's first-pitch test, applied before any spend: a contact we are
 * talking to, or pitched inside the cooldown, or that is not pitchable, gets no
 * new draft. Returns { reason, permanent } or null. Only a non-pitchable status
 * is PERMANENT; escalated, open conversation and cooldown end on their own, so
 * they must never count toward the attempts that retire a prospect.
 */
export function contactBlocker(contact, state, nowMs) {
  if (!PITCHABLE_STATUSES.includes(contact.status)) return { reason: `contact ${contact.id} has status ${contact.status}`, permanent: true };
  if (state?.escalated?.[contact.id]) return { reason: `contact ${contact.id} is escalated to Sean`, permanent: false };
  const lp = lastPitch(contact);
  if (lp && OPEN_OUTCOMES.includes(lp.outcome)) return { reason: `contact ${contact.id} has an open conversation (${lp.outcome})`, permanent: false };
  if (lp && nowMs - Date.parse(`${lp.date}T00:00:00Z`) < DEFAULT_COOLDOWN_DAYS * DAY) return { reason: `contact ${contact.id} pitched within ${DEFAULT_COOLDOWN_DAYS} days (last ${lp.date})`, permanent: false };
  return null;
}

/**
 * Pure: find or add the contact a prospect drafts to. `existing` (a resolved
 * contact) wins; otherwise the contact is matched by name on the domain.
 * `address` null means the finder found nothing: a NEW editorial contact is
 * `unverified`, with no email channel and a note naming the page to try by
 * hand. An existing contact keeps its status, and NEVER gains a second email
 * channel: emailOf (the first one) is what follow-ups and reply matching use,
 * so the draft must go there too. With an address, the prospect's domain is
 * added to an existing contact's domains. Returns { book, contactId, created, contact }.
 */
export function upsertProspectContact(book, prospect, { address = null, source = null, reason = null, today, existing = null }) {
  const outlet = prospect.source === 'link-gap';
  const name = prospectName(prospect);
  const domain = normalizeDomain(prospect.domain) || prospect.domain;
  const contacts = book.contacts || [];
  const match = (existing && contacts.find((c) => c.id === existing.id)) || resolveExistingContact(book, prospect);
  const manualUrl = (outlet ? null : prospect.person?.authorUrl) || prospect.targetUrl || `https://${domain}/`;
  const note = `${today}: ${NO_ADDRESS_NOTE}${reason ? ` (${reason})` : ''}; try by hand: ${manualUrl}`;
  const channel = address ? { type: 'email', address: address.toLowerCase(), verified: true, source } : null;

  if (match) {
    let next = match;
    if (channel) {
      if (!emailOf(match)) {
        next = { ...next, channels: [...(match.channels || []), channel] };
        // A verified email is what `unverified` was waiting for.
        if (next.status === 'unverified') next = { ...next, status: 'active' };
      }
      if (!onDomainOf(next, domain)) next = { ...next, domains: [...(next.domains || []), domain] };
    } else if (!(match.notes || []).some((n) => String(n).includes(NO_ADDRESS_NOTE))) {
      next = { ...next, notes: [...(match.notes || []), note] };
    }
    return { book: { ...book, contacts: contacts.map((c) => (c === match ? next : c)) }, contactId: match.id, created: false, contact: next };
  }

  const ids = new Set(contacts.map((c) => c.id));
  const base = kebab(name) || domainStem(domain);
  let id = base;
  if (ids.has(id)) id = `${base}-${domainStem(domain)}`;
  for (let n = 2; ids.has(id); n += 1) id = `${base}-${domainStem(domain)}-${n}`;
  const contact = {
    id, name, kind: outlet ? 'outlet' : 'journalist', status: channel ? 'active' : 'unverified',
    outlets: [prospect.publication || domain], domains: [domain],
    channels: channel ? [channel] : [], pitches: [],
    ...(channel ? {} : { notes: [note] }),
    added_by: 'press-outreach', added_at: today,
  };
  return { book: { ...book, contacts: [...contacts, contact] }, contactId: id, created: true, contact };
}

/**
 * One drafting run: turn prospects into pending pitch drafts until the approval
 * queue holds config.queueTarget (or `limit` drafts, which overrides it). All
 * I/O is injected. Nothing here sends mail; a draft waits for Sean's approval.
 *
 * Per prospect: fetch the article first (a failed fetch spends no Hunter
 * credit); resolve the contact already on file and apply the sender's
 * first-pitch test BEFORE any spend; reuse the address on file, or else run the
 * finder; then draft. Every failure or contact skip is counted in
 * state.draft_attempts[key]; at MAX_DRAFT_ATTEMPTS the key is excluded from the
 * pool before it is truncated, so dead rows never crowd out live ones.
 */
export async function runDrafting({
  apply = false,
  now = Date.now(),
  config = DEFAULT_CONFIG,
  book,
  state,
  drafts = [],
  prTargets = null,
  linkGap = null,
  pressFacts,
  postalAddress,
  findAddress,
  fetchArticle,
  draftPitch,
  generate,
  saveDraft = (d) => saveDraftFile(join(ROOT, DRAFTS_DIR), d),
  saveBook = writeBook,
  saveState = writeState,
  onProgress = () => {},
  limit = null,
  log = console.log,
  clock = null,
  deadline = null,
  // Follow-ups: the Sent-folder reader for original pitches with no draft file,
  // the follow-up writer, and the author pages by outlet domain.
  readSentBodies = null,
  writeFollowUp = draftFollowUpLib,
  authorUrls = null,
} = {}) {
  if (!apply) { saveDraft = () => {}; saveBook = () => {}; saveState = () => {}; }
  state.draft_attempts ||= {};
  state.followup_attempts ||= {};
  state.found_addresses ||= {};
  state.hunter_tried ||= {};
  const today = isoOf(now).slice(0, 10);
  const concept = `pitch-${today.slice(0, 7)}`;
  // Facts the claim gate refused are reported on every run, so a bad fact
  // Sean added is visible the next morning rather than silently ignored.
  const { skippedFacts } = buildFactSheet(pressFacts);
  const result = { skippedFacts, drafted: [], noAddress: [], failed: [], skipped: [], hunterSpent: 0, queueSkipped: 0, dead: 0, pending: 0, want: 0, stoppedAtDeadline: false, leftAtDeadline: 0, deadline: null, followUps: [], followUpFailed: [], followUpSkipped: [] };
  // Elapsed real time on top of `now`, so an injected `now` still moves.
  if (!clock) { const startedReal = Date.now(); clock = () => now + (Date.now() - startedReal); }
  const stopAt = deadline ?? defaultDraftDeadline(now);
  result.deadline = isoOf(stopAt);

  const pending = drafts.filter((d) => ['pending', 'approved'].includes(d.status)).length;
  result.pending = pending;
  // The queue fills over a few days: one run drafts at most draftRunMax. An
  // explicit --limit is a human's choice and is bounded by the deadline only.
  const runMax = config.draftRunMax ?? DEFAULT_CONFIG.draftRunMax ?? 10;
  // Pitches fill the queue up to queueTarget. Follow-ups have their OWN budget,
  // bounded by draftRunMax and not by queue room: a warm thread must not wait
  // behind a queue full of cold pitches.
  let want = limit != null ? limit : Math.min(runMax, (config.queueTarget ?? DEFAULT_CONFIG.queueTarget) - pending);
  const followBudget = limit != null ? limit : runMax;
  result.want = Math.max(0, want);

  const persistFollowState = () => { try { saveState(state); } catch (err) { log(`  could not save state: ${err.message}`); } };

  // A follow-up that SENT but whose book write failed leaves follow_ups_sent
  // behind; repair it from the sent draft so that follow-up is never redrafted.
  for (const c of book.contacts) {
    const p = lastPitch(c);
    if (!p) continue;
    const sentFus = drafts.filter((d) => d.kind === 'followup' && d.status === 'sent' && d.contact_id === c.id && onPitch(d, p));
    if (!sentFus.length) continue;
    const n = Math.max(...sentFus.map((d) => (d.n === 2 ? 2 : 1)));
    const at = sentFus.map((d) => d.sent_at).filter(Boolean).sort().at(-1);
    if ((p.follow_ups_sent || 0) >= n) continue;
    const later = at && (!p.last_sent_at || Date.parse(at) > Date.parse(p.last_sent_at));
    try {
      const next = updatePitch(book, c.id, { follow_ups_sent: n, ...(later ? { last_sent_at: at } : {}) });
      saveBook(next);
      book = next;
      log(`  repaired ${c.id}: follow-up ${n} was sent (draft) but not recorded`);
    } catch (err) { log(`  could not repair ${c.id}'s follow-up count: ${err.message}`); }
  }

  // ── Follow-ups first: a warm thread beats a cold prospect. ──
  // Every thread due by the 5/7-day gaps (lib/press-contacts.js) gets one
  // model-written follow-up queued for approval, unless the contact already
  // has one waiting, Sean rejected this one, or it failed on two earlier runs.
  {
    const openFor = (id) => drafts.some((d) => d.contact_id === id && ['followup', 'bump'].includes(d.kind) && ['pending', 'approved'].includes(d.status));
    const due = autoFollowUpsDue(book.contacts, now)
      .sort((a, b) => String(a.pitch.last_sent_at || a.pitch.date).localeCompare(String(b.pitch.last_sent_at || b.pitch.date)));
    const todo = [];
    for (const row of due) {
      const { contact, pitch, n } = row;
      const key = `${contact.id}:${pitch.date}:${n}`;
      const skipF = (reason) => result.followUpSkipped.push({ contactId: contact.id, n, reason });
      if (openFor(contact.id)) { skipF('a follow-up draft is already waiting'); continue; }
      if (state.escalated?.[contact.id]) { skipF('escalated to Sean'); continue; }
      const done = drafts.find((d) => d.kind === 'followup' && d.contact_id === contact.id && d.n === n && ['sent', 'rejected', 'expired'].includes(d.status) && onPitch(d, pitch));
      if (done) { skipF(`follow-up ${n} was already ${done.status} (${done.id})`); continue; }
      if ((state.followup_attempts[key] || 0) >= FOLLOWUP_MAX_ATTEMPTS) { skipF(`given up after ${FOLLOWUP_MAX_ATTEMPTS} failed runs`); continue; }
      todo.push({ ...row, key });
    }
    const authors = authorUrls || authorUrlsFromTargets(prTargets);
    const needSent = todo.filter((x) => !findOriginalPitch({ contact: x.contact, pitch: x.pitch, drafts }));
    const sent = await loadSentCopies(readSentBodies, needSent, now, log);
    const run = createFollowUpRun({ drafts });
    for (const { contact, pitch, n, key } of todo) {
      if (result.followUps.length >= followBudget) break;
      if (clock() >= stopAt) { result.stoppedAtDeadline = true; log('  stopped at the deadline while drafting follow-ups'); break; }
      const thread = { subject: reSubject(pitch.subject), inReplyTo: pitch.message_id, references: refsOf(pitch.references, pitch.message_id) };
      let out;
      try {
        out = await draftFollowUpForContact({ contact, pitch, n, thread, drafts, sentCopies: sent.rows, authorUrls: authors, fetchPage: fetchArticle, pressFacts, generate, run, now, writer: writeFollowUp });
      } catch (err) { out = { ok: false, reason: `follow-up error: ${err.message}` }; }
      onProgress();
      if (out.ok) {
        try { saveDraft(out.draft); } catch (err) { out = { ok: false, reason: `draft save failed: ${err.message}` }; }
      }
      if (!out.ok) {
        const reason = out.reason === findOriginalMissing && sent.error ? `${out.reason}; the Sent folder could not be read (${sent.error})` : out.reason;
        state.followup_attempts[key] = (state.followup_attempts[key] || 0) + 1;
        persistFollowState();
        result.followUpFailed.push({ contactId: contact.id, n, reason });
        continue;
      }
      delete state.followup_attempts[key];
      persistFollowState();
      result.followUps.push({ contactId: contact.id, n, draftId: out.draft.id, to: out.draft.to, articleUrl: out.draft.article_url, subject: out.draft.subject });
      log(`  drafted ${out.draft.id} (follow-up ${n}) for ${contact.id}`);
    }
  }
  if (result.stoppedAtDeadline) return { ...result, book, state };
  // The pitches get what the follow-ups left. Without --limit `want` is already
  // bounded by draftRunMax and the queue room; an explicit --limit is a human's
  // choice and is not capped by draftRunMax.
  want -= result.followUps.length;
  result.want = Math.max(0, want);
  if (want <= 0) { log(`  queue holds ${pending + result.followUps.length} drafts (target ${config.queueTarget}); no new pitches`); return { ...result, book, state }; }

  // Dead keys are excluded BEFORE truncation; they are counted, never reported
  // as skips, so a run that only met dead keys does not notify.
  const deadKeys = new Set(Object.entries(state.draft_attempts).filter(([, n]) => n >= MAX_DRAFT_ATTEMPTS).map(([k]) => k));
  // A deeper pool than `want`, so a failed prospect is replaced by the next one.
  const pool = buildProspects({
    prTargets, linkGap, contacts: book.contacts, existingDrafts: drafts, today, excludeKeys: deadKeys,
    want: Math.max(want * 3, want + 5), editorialShare: config.editorialShare ?? DEFAULT_CONFIG.editorialShare,
  });
  result.dead = pool.skipped.filter((s) => s.reason === 'excluded: repeated failed attempts').length;
  result.queueSkipped = pool.skipped.length - result.dead;

  // Honour editorialShare among the drafts actually made: a source past its share
  // waits, and is only used if the other source runs out.
  const share = config.editorialShare ?? DEFAULT_CONFIG.editorialShare;
  const caps = { editorial: Math.ceil(want * share) };
  caps.gap = want - caps.editorial;
  const made = { editorial: 0, gap: 0 };
  const sideOf = (p) => (p.source === 'link-gap' ? 'gap' : 'editorial');
  const deferred = [];
  const draftedContacts = new Set();
  // Drafts already on disk block their contact the same way they block their
  // domain in buildProspects: pending and approved while open, rejected for the
  // cooldown. Without this, a writer reached through a second domain gets a
  // duplicate pitch, and a second run the same day overwrites an approved one.
  const contactDraftBlock = new Map();
  for (const d of drafts) {
    const reason = draftBlockReason(d, today);
    if (reason && d.contact_id && !contactDraftBlock.has(d.contact_id)) contactDraftBlock.set(d.contact_id, reason);
  }
  const blockerOf = (contact) => {
    const r = contactDraftBlock.get(contact.id);
    if (r) return { reason: `contact ${contact.id}: ${r}`, permanent: false };
    return contactBlocker(contact, state, now);
  };

  const persistState = () => { try { saveState(state); } catch (err) { log(`  could not save state: ${err.message}`); } };
  const countAttempt = (p) => {
    state.draft_attempts[p.key] = (state.draft_attempts[p.key] || 0) + 1;
    persistState();
  };
  const fail = (p, reason) => { countAttempt(p); return reason; };

  async function attempt(p) {
    const row = { key: p.key, domain: p.domain, name: p.person?.name || p.domain };
    const skip = (reason) => { countAttempt(p); result.skipped.push({ ...row, reason }); return false; };
    // A temporary block (escalated, open conversation, cooldown) is skipped with
    // its reason and NO attempt, so the prospect is drafted once it clears.
    const blocked = (b) => (b.permanent ? skip(b.reason) : (result.skipped.push({ ...row, reason: `${b.reason}; retried later` }), false));

    // The contact already on file, checked before ANY spend (fetch included).
    let existing = resolveExistingContact(book, p);
    if (existing) {
      if (draftedContacts.has(existing.id)) { result.skipped.push({ ...row, reason: `already drafted to ${existing.id} this run` }); return false; }
      const b = blockerOf(existing);
      if (b) return blocked(b);
    }

    let page;
    try { page = await fetchArticle(p.targetUrl); } catch (err) { page = { outcome: 'network-error', error: err.message }; }
    // One prospect can take minutes (fetch, finder, model): keep the lock fresh
    // inside it too, or a long attempt lets the next run read the lock as stale.
    onProgress();
    const articleText = page?.outcome === 'ok' ? htmlToText(page.html) : '';
    if (!articleText) {
      result.failed.push({ ...row, reason: fail(p, `article fetch: ${page?.outcome === 'ok' ? 'empty page' : page?.outcome || 'failed'}`) });
      return false;
    }

    let found;
    if (existing && emailOf(existing)) {
      // Follow-ups and reply matching use the first email on file, so the
      // pitch goes there too, and no credit is spent looking for another.
      const ch = existing.channels.find((c) => c.type === 'email' && c.address);
      found = { address: emailOf(existing), source: ch.source || 'contact book', spentHunter: 0 };
    } else {
      const cached = state.found_addresses[p.key];
      if (cached?.address) {
        // Found on an earlier run that a temporary block stopped: no second spend.
        found = { address: cached.address, source: cached.source, spentHunter: 0 };
      } else {
        // A prospect that already cost a Hunter credit (recorded in state, or
        // the contact carries the no-address note) gets the free pass only.
        const hunterDone = Boolean(state.hunter_tried[p.key])
          || Boolean(existing && (existing.notes || []).some((n) => String(n).includes(NO_ADDRESS_NOTE)));
        try {
          found = hunterDone ? await findAddress(p, { hunter: false }) : await findAddress(p);
        } catch (err) { found = { address: null, reason: `finder error: ${err.message}`, spentHunter: err?.spentHunter || 0 }; }
        onProgress();
        const spent = found?.spentHunter || 0;
        result.hunterSpent += spent;
        if (spent > 0) {
          state.hunter_tried[p.key] = today;
          // A paid address is kept, so no later outcome spends for it again.
          if (found?.address) state.found_addresses[p.key] = { address: found.address, source: found.source, at: isoOf(now) };
          persistState();
        }
      }
      if (found?.address) {
        const owner = contactOwning(book, found.address);
        if (owner && !(existing && owner.id === existing.id)) {
          // The address is someone already on file. The same name means the same
          // person writing elsewhere; anyone else is a different person.
          if (existing || foldName(owner.name) !== foldName(prospectName(p))) return skip(`found address belongs to ${owner.id}, a different contact`);
          if (draftedContacts.has(owner.id)) { result.skipped.push({ ...row, reason: `already drafted to ${owner.id} this run` }); return false; }
          const b = blockerOf(owner);
          if (b) {
            if (!b.permanent) {
              state.found_addresses[p.key] = { address: found.address, source: found.source, at: isoOf(now) };
              persistState();
            }
            return blocked(b);
          }
          existing = owner;
        }
      }
    }

    if (!found?.address) {
      const reason = found?.reason || 'no address found';
      if (p.source === 'link-gap') return skip(`no address: ${reason}`);
      countAttempt(p);
      const up = upsertProspectContact(book, p, { address: null, reason, today, existing });
      const v = validateContacts(up.book);
      if (!v.ok) { result.failed.push({ ...row, reason: `contact book invalid: ${v.errors[0]}` }); return false; }
      try { saveBook(up.book); } catch (err) { result.failed.push({ ...row, reason: `contact book write failed: ${err.message}` }); return false; }
      book = up.book;
      result.noAddress.push({ ...row, contactId: up.contactId, reason });
      return false;
    }

    const up = upsertProspectContact(book, p, { address: found.address, source: found.source, today, existing });
    if (draftedContacts.has(up.contactId)) { result.skipped.push({ ...row, reason: `already drafted to ${up.contactId} this run` }); return false; }
    const to = emailOf(up.contact) || found.address;
    let out;
    try {
      out = await draftPitch({ prospect: p, articleText, pressFacts, generate, postalAddress, contact: up.contact });
    } catch (err) {
      out = { ok: false, reason: `draft error: ${err.message}` };
    }
    onProgress();
    if (!out?.ok) { result.failed.push({ ...row, reason: fail(p, out?.reason || 'draft rejected') }); return false; }

    const v = validateContacts(up.book);
    if (!v.ok) { result.failed.push({ ...row, reason: fail(p, `contact book invalid: ${v.errors[0]}`) }); return false; }
    try { saveBook(up.book); } catch (err) { result.failed.push({ ...row, reason: fail(p, `contact book write failed: ${err.message}`) }); return false; }
    book = up.book;
    let draft;
    try {
      draft = {
        ...newDraft({
          kind: 'pitch', contactId: up.contactId, to, subject: out.draft.subject, text: out.draft.text,
          source: p.source, targetUrl: p.targetUrl, openerQuote: out.draft.openerQuote, products: out.draft.products || [], concept, now,
        }),
        address_source: found.source,
      };
      saveDraft(draft);
    } catch (err) {
      result.failed.push({ ...row, reason: fail(p, `draft save failed: ${err.message}`) });
      return false;
    }
    draftedContacts.add(up.contactId);
    delete state.draft_attempts[p.key];
    delete state.found_addresses[p.key];
    delete state.hunter_tried[p.key];
    persistState();
    result.drafted.push({ ...row, contactId: up.contactId, draftId: draft.id, to, addressSource: found.source, subject: draft.subject });
    log(`  drafted ${draft.id} to ${up.contactId} (${found.source})`);
    return true;
  }

  const attempted = new Set();
  const pastDeadline = () => {
    if (clock() < stopAt) return false;
    result.stoppedAtDeadline = true;
    result.leftAtDeadline = pool.prospects.filter((x) => !attempted.has(x.key)).length;
    log(`  stopped at the deadline (${isoOf(stopAt).slice(11, 16)} UTC), ${result.leftAtDeadline} prospects left`);
    return true;
  };
  let stopped = false;
  for (const p of pool.prospects) {
    if (result.drafted.length >= want) break;
    const side = sideOf(p);
    if (made[side] >= caps[side]) { deferred.push(p); continue; }
    if (pastDeadline()) { stopped = true; break; }
    attempted.add(p.key);
    if (await attempt(p)) made[side] += 1;
    onProgress();
  }
  for (const p of stopped ? [] : deferred) {
    if (result.drafted.length >= want) break;
    if (pastDeadline()) break;
    attempted.add(p.key);
    if (await attempt(p)) made[sideOf(p)] += 1;
    onProgress();
  }
  return { ...result, book, state };
}

export function renderDraftSummary(r, { apply, dashboardUrl = null } = {}) {
  const waiting = r.pending + (apply ? r.drafted.length + (r.followUps?.length || 0) : 0);
  const where = dashboardUrl ? `${dashboardUrl.replace(/\/$/, '')}/#outreach` : 'the dashboard, #outreach';
  const lines = [apply ? '' : 'DRY RUN: nothing was saved.'];
  if (r.followUps?.length) { lines.push(`${apply ? 'Follow-ups drafted' : 'Would draft follow-ups'}:`); for (const f of r.followUps) lines.push(`  - ${f.contactId}: follow-up ${f.n}${f.articleUrl ? ` (cites ${f.articleUrl})` : ''}`); }
  if (r.followUpFailed?.length) { lines.push('Follow-ups not drafted (retried next run, at most twice):'); for (const f of r.followUpFailed) lines.push(`  - ${f.contactId} (follow-up ${f.n}): ${f.reason}`); }
  if (r.drafted.length) { lines.push(`${apply ? 'Drafted' : 'Would draft'}:`); for (const d of r.drafted) lines.push(`  - ${d.contactId} <${d.to}> (address: ${d.addressSource}): ${d.subject}`); }
  if (r.noAddress.length) { lines.push('No address found (contact saved as unverified, try by hand):'); for (const x of r.noAddress) lines.push(`  - ${x.contactId}: ${x.reason}`); }
  if (r.failed.length) { lines.push('Failed (retried next run, at most twice):'); for (const x of r.failed) lines.push(`  - ${x.domain}: ${x.reason}`); }
  if (r.skipped.length) { lines.push('Skipped:'); for (const x of r.skipped) lines.push(`  - ${x.domain}: ${x.reason}`); }
  if (r.skippedFacts?.length) { lines.push('Facts skipped by the claim gate (never sent):'); for (const f of r.skippedFacts) lines.push(`  - ${f.where}: "${f.fact}" (${f.reason})`); }
  if (r.stoppedAtDeadline) lines.push(`Stopped at the deadline (${String(r.deadline || '').slice(11, 16)} UTC), ${r.leftAtDeadline} ${r.leftAtDeadline === 1 ? 'prospect' : 'prospects'} left for the next run.`);
  lines.push(`Hunter credits used: ${r.hunterSpent}. Prospects filtered out of the queue: ${r.queueSkipped}. Given up after repeated failures: ${r.dead}.`);
  lines.push(`${waiting} ${waiting === 1 ? 'draft' : 'drafts'} waiting for approval: ${where}`);
  const subject = `Press drafting: ${r.followUps?.length || 0} follow-ups · ${r.drafted.length} drafted · ${r.noAddress.length} no address · ${r.failed.length} failed · ${r.skipped.length} skipped · ${r.hunterSpent} Hunter${r.stoppedAtDeadline ? ' · stopped at deadline' : ''}`;
  return { subject, body: lines.filter((l, i) => i > 0 || l).join('\n') };
}

/** Default model call for draftPitch: the prompt goes UNCHANGED as the one user message. */
async function generateWithModel(prompt, env) {
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: CONFIRM_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('pitch draft truncated at max_tokens');
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

function readJson(rel) {
  try { return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); } catch { return null; }
}

async function waitForLock(maxMs = 5 * 60_000, stepMs = 30_000) {
  const until = Date.now() + maxMs;
  for (;;) {
    if (acquireLock()) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function runDraftMode(args, apply, env, config) {
  const creds = hushmailCredentials(env);
  const li = args.indexOf('--limit');
  let limit = null;
  if (li !== -1) {
    limit = Number(args[li + 1]);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit wants a positive integer, got "${args[li + 1]}"`);
  }
  console.log(`Press outreach drafting${apply ? '' : ' (dry run)'}${limit ? ` (limit ${limit})` : ''}`);
  if (!config.enabled) { console.log('disabled in config/press-outreach.json'); return; }
  // The same lock as the 30-minute run: the book, the drafts and the state are
  // read only once nothing else can be writing them. A run already holding it
  // (it is short outside the send window) gets a few minutes to finish.
  if (apply && !(await waitForLock())) {
    console.log('another press-outreach run holds the lock (data/press/.lock); drafting skipped today');
    await notify({ subject: 'Press drafting skipped: lock held', body: 'Another press-outreach run held data/press/.lock for over 5 minutes, so no drafts were made today.', status: 'info', category: 'press' });
    return;
  }
  try {
    const loaded = readBook();
    if (!loaded.available) throw new Error(`Refusing to draft: ${loaded.reason}`);
    let state = readState();
    if (!state) {
      // Creating the state file here would disarm the 30-minute run's
      // "no state, refuse" guard, so drafting never creates it.
      if (apply) throw new Error(`Refusing to draft: no state file at ${STATE_PATH}. Run the 30-minute agent once with --init first.`);
      state = emptyState();
    }
    const postalAddress = readPostalAddress();
    if (!postalAddress) throw new Error('Refusing to draft: no postal_address in data/brand/brand-kit.json');
    const pressFacts = loadPressFacts();
    const prTargets = readJson('data/reports/pr-targets/latest.json');
    const linkGap = readJson('data/backlinks/opportunities.json');
    if (!prTargets) console.log('  no data/reports/pr-targets/latest.json; editorial prospects unavailable');
    if (!linkGap) console.log('  no data/backlinks/opportunities.json; link-gap prospects unavailable');

    // Hunter costs real credits, so a dry run uses the free pass only.
    const hunter = apply && env.HUNTER_API_KEY ? hunterClient(env.HUNTER_API_KEY) : null;
    if (!hunter) console.log(`  Hunter ${apply ? 'unavailable (no HUNTER_API_KEY)' : 'not used in a dry run'}; published addresses only`);
    const tavilySearch = env.TAVILY_API_KEY ? tavilyClient(env.TAVILY_API_KEY) : null;
    const fetchPage = (url) => fetchWithOutcome(url);
    const today = new Date().toISOString().slice(0, 10);

    const draftsDir = join(ROOT, DRAFTS_DIR);
    const drafts = loadDrafts(draftsDir, undefined, { onError: (name, err) => console.log(`  skipped unreadable draft ${name}: ${err.message}`) });
    const run = await runDrafting({
      apply, config, book: loaded.doc, state, drafts, prTargets, linkGap, pressFacts, postalAddress, limit,
      fetchArticle: fetchPage,
      findAddress: makeFindAddress({ fetchPage, tavilySearch, hunter, budget: { hunterUsageStop: config.hunterUsageStop }, today }),
      draftPitch: draftPitchLib,
      generate: (prompt) => generateWithModel(prompt, env),
      onProgress: touchLock,
      // Original pitches with no draft file (the September ones) are read from Sent.
      readSentBodies: creds ? (q) => fetchSentBodiesTo(creds, q) : null,
    });
    const { subject, body } = renderDraftSummary(run, { apply, dashboardUrl: process.env.DASHBOARD_URL || env.DASHBOARD_URL || null });
    console.log(`\n${subject}\n\n${body}`);
    const acted = run.skippedFacts?.length || run.drafted.length || run.noAddress.length || run.failed.length || run.skipped.length || run.stoppedAtDeadline || run.followUps.length || run.followUpFailed.length;
    if (apply && acted) await notify({ subject, body, status: 'info', category: 'press' });
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
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
  if (r.samples?.length) { lines.push('Samples:'); for (const x of r.samples) lines.push(`  - ${x.name}: ${x.action}`); }
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

async function runBackfill(args, apply, creds, env) {
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
    const senders = [...openPitchByAddress(book.contacts, now).keys()];
    const since = new Date(now - 90 * DAY);
    const replies = senders.length ? await fetchFromAllFolders(creds, { senders, since }) : [];
    const sentCopies = senders.length ? await fetchSentTo(creds, { recipients: senders, since }) : [];
    const draftsDir = join(ROOT, DRAFTS_DIR);
    const existing = loadDrafts(draftsDir, undefined, { onError: (name, err) => console.log(`  skipped unreadable draft ${name}: ${err.message}`) });
    const plan = planBackfill({ book, sentCopies, replies, now, drafts: existing });
    for (const n of plan.notes) console.log(`  ${n}`);
    console.log(`${plan.patches.length} patches, ${plan.followUps.length} follow-ups to draft${apply ? '' : ' (dry run: nothing written; add --apply)'}`);
    for (const f of plan.followUps) console.log(`  follow-up for ${f.contactId}: ${f.subject}`);
    console.log(`${plan.processed.length} replies marked as already handled`);
    if (apply) {
      const priorState = readState();
      if (!priorState) console.log(`WARNING: no state file existed, so a FRESH one was created at ${STATE_PATH}. Its sends and escalations history is empty; if a state file should exist, restore it from backup.`);
      const applied = applyBackfill({ book, plan, state: priorState, now });
      book = applied.book;
      writeBook(book);
      writeState(applied.state);
      // Each candidate is written per writer and queued for approval, like any follow-up.
      if (plan.followUps.length) {
        const pressFacts = loadPressFacts();
        const authorUrls = authorUrlsFromTargets(readJson('data/reports/pr-targets/latest.json'));
        const rows = plan.followUps.map((f) => ({ ...f, contact: book.contacts.find((c) => c.id === f.contactId) })).filter((f) => f.contact);
        const withPitch = rows.map((f) => ({ ...f, pitch: lastPitch(f.contact) }));
        const sent = await loadSentCopies((q) => fetchSentBodiesTo(creds, q), withPitch, now, console.log);
        const run = createFollowUpRun({ drafts: existing });
        for (const f of withPitch) {
          const out = await draftFollowUpForContact({
            contact: f.contact, pitch: f.pitch, n: 1, thread: { subject: f.subject, inReplyTo: f.inReplyTo, references: f.references },
            drafts: existing, sentCopies: sent.rows, authorUrls, fetchPage: (u) => fetchWithOutcome(u), pressFacts,
            generate: (prompt) => generateWithModel(prompt, env), run, now,
          });
          if (!out.ok) { console.log(`  follow-up for ${f.contactId} not drafted: ${out.reason}`); continue; }
          try { saveDraftFile(draftsDir, out.draft); console.log(`  drafted ${out.draft.id}`); } catch (err) { console.log(`  could not save ${out.draft.id}: ${err.message}`); }
        }
      }
      console.log('backfill applied');
    }
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

/** Move a draft file to data/press/backups/<prefix>-<file>; never overwrites an earlier backup. */
function moveDraftAside(d, prefix = 'oldbump') {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const from = join(ROOT, DRAFTS_DIR, `${d.id}.json`);
  let to = join(BACKUP_DIR, `${prefix}-${d.id}.json`);
  if (existsSync(to)) to = join(BACKUP_DIR, `${prefix}-${d.id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  renameSync(from, to);
  return to;
}

async function runRedraftBumpsMode(apply, env, config) {
  console.log(`Press outreach: redraft bumps${apply ? '' : ' (dry run)'}`);
  if (!config.enabled) { console.log('disabled in config/press-outreach.json'); return; }
  if (apply && !(await waitForLock())) throw new Error('another press-outreach run holds the lock (data/press/.lock); try again in a few minutes');
  try {
    const loaded = readBook();
    if (!loaded.available) throw new Error(`contact book unavailable: ${loaded.reason}`);
    const creds = hushmailCredentials(env);
    const draftsDir = join(ROOT, DRAFTS_DIR);
    const drafts = loadDrafts(draftsDir, undefined, { onError: (name, err) => console.log(`  skipped unreadable draft ${name}: ${err.message}`) });
    const r = await runRedraftBumps({
      apply, book: loaded.doc, drafts,
      pressFacts: apply ? loadPressFacts() : null,
      authorUrls: authorUrlsFromTargets(readJson('data/reports/pr-targets/latest.json')),
      fetchPage: (u) => { touchLock(); return fetchWithOutcome(u); },
      readSentBodies: creds ? (q) => fetchSentBodiesTo(creds, q) : null,
      generate: (prompt) => { touchLock(); return generateWithModel(prompt, env); },
      moveAside: (d) => moveDraftAside(d, 'oldbump'),
      restore: (d, moved) => renameSync(moved, join(draftsDir, `${d.id}.json`)),
      saveDraft: (d) => saveDraftFile(draftsDir, d),
    });
    const { subject, body } = renderRedraftSummary(r, { apply });
    console.log(`\n${subject}\n\n${body}`);
    if (apply) await notify({ subject, body, status: 'info', category: 'press' });
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

async function runRedraftFollowupsMode(apply, env, config) {
  console.log(`Press outreach: redraft pending follow-ups${apply ? '' : ' (dry run)'}`);
  if (!config.enabled) { console.log('disabled in config/press-outreach.json'); return; }
  if (apply && !(await waitForLock())) throw new Error('another press-outreach run holds the lock (data/press/.lock); try again in a few minutes');
  try {
    const loaded = readBook();
    if (!loaded.available) throw new Error(`contact book unavailable: ${loaded.reason}`);
    const creds = hushmailCredentials(env);
    const draftsDir = join(ROOT, DRAFTS_DIR);
    const drafts = loadDrafts(draftsDir, undefined, { onError: (name, err) => console.log(`  skipped unreadable draft ${name}: ${err.message}`) });
    const r = await runRedraftFollowups({
      apply, book: loaded.doc, drafts,
      pressFacts: apply ? loadPressFacts() : null,
      authorUrls: authorUrlsFromTargets(readJson('data/reports/pr-targets/latest.json')),
      fetchPage: (u) => { touchLock(); return fetchWithOutcome(u); },
      readSentBodies: creds ? (q) => fetchSentBodiesTo(creds, q) : null,
      generate: (prompt) => { touchLock(); return generateWithModel(prompt, env); },
      moveAside: (d) => moveDraftAside(d, 'oldfollowup'),
      restore: (d, moved) => renameSync(moved, join(draftsDir, `${d.id}.json`)),
      saveDraft: (d) => saveDraftFile(draftsDir, d),
    });
    const { subject, body } = renderRedraftFollowupsSummary(r, { apply });
    console.log(`\n${subject}\n\n${body}`);
    if (apply) await notify({ subject, body, status: 'info', category: 'press' });
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

/**
 * The authors' pages the pr-targets report knows, keyed by outlet domain, so a
 * pitch to that outlet can also be checked on the author's archive.
 */
export function authorUrlsFromTargets(prTargets) {
  const map = new Map();
  for (const r of (prTargets && prTargets.pitch_targets) || []) {
    const d = normalizeDomain(r.domain || '');
    if (d && r.author_url && !map.has(d)) map.set(d, r.author_url);
  }
  return map;
}

export function renderLinkDigest({ found, candidates, tally, f, change, apply }) {
  const lines = [apply ? '' : 'DRY RUN: nothing was written.'];
  lines.push(renderFunnel(f));
  if (found.length) {
    lines.push('New earned coverage:');
    for (const x of found) lines.push(`  - ${x.name}: ${x.kind === 'link' ? `LINK (${x.dofollow ? 'dofollow' : 'nofollow'})` : 'mention, no link'} ${x.url}`);
  } else lines.push('No new links or mentions found.');
  lines.push(`Pitches checked: ${candidates.length}. Fetch outcomes: ${renderOutcomeTally(tally)}. Unreachable pages were not judged either way.`);
  if (change) lines.push(`Context, not attributed to outreach: site-wide referring domains ${change.from} to ${change.to} (${change.delta >= 0 ? '+' : ''}${change.delta}) between ${change.prevDate} and ${change.date}.`);
  const links = found.filter((x) => x.kind === 'link').length;
  return { subject: `Press links: ${links} new ${links === 1 ? 'link' : 'links'} · ${found.length - links} mentions · ${f.last28.sent} sent in 28d`, body: lines.filter((l, i) => i > 0 || l).join('\n') };
}

function readBacklinkSnapshots() {
  const dir = join(ROOT, 'data', 'backlinks', 'snapshots');
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json')).sort().slice(-2).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
  } catch { return []; }
}

// --draft (14:20 UTC) may hold the lock until its 15:30 cutoff; the Monday
// 14:25 link check waits that out rather than skipping the week.
export const LINK_CHECK_LOCK_WAIT_MS = 80 * 60_000;

/**
 * The weekly link check with every side effect injected. The network work runs
 * WITHOUT the lock against a snapshot of the book; only the write takes it.
 * Under the lock the book is re-read and the findings are applied to the FRESH
 * copy by contact id (applyLinkFindings re-checks each pitch), so a draft or
 * send run that wrote the book meanwhile loses nothing. If the lock never comes
 * free, the digest still goes out and says the findings were not written.
 */
export async function runLinkCheckFlow({
  apply = false,
  nowMs = Date.now(),
  readBook: read,
  writeBook: write,
  fetchPage,
  authorUrlOf = null,
  waitForLock: wait = async () => true,
  releaseLock = () => {},
  drafts = [],
  snapshots = [],
  notify: tell = async () => {},
  log = console.log,
} = {}) {
  const loaded = read();
  if (!loaded.available) { log(`contact book unavailable: ${loaded.reason}`); return { written: false, reason: loaded.reason }; }
  const res = await checkLinks({ book: loaded.doc, nowMs, fetchPage, authorUrlOf });
  let book = res.book;
  let found = res.found;
  let notWritten = null;
  if (apply && res.found.length) {
    if (await wait()) {
      try {
        const fresh = read();
        if (!fresh.available) notWritten = `the contact book could not be re-read (${fresh.reason})`;
        else {
          const ap = applyLinkFindings(fresh.doc, res.found);
          for (const d of ap.dropped) log(`  not applied for ${d.finding.id}: ${d.reason}`);
          if (ap.applied.length) write(ap.book);
          book = ap.book;
          found = ap.applied;
        }
      } catch (err) {
        notWritten = `the contact book write failed (${err.message})`;
      } finally {
        releaseLock();
      }
    } else {
      notWritten = 'another press-outreach run held data/press/.lock the whole time';
    }
  }
  const { subject, body } = renderLinkDigest({ ...res, found: notWritten ? res.found : found, f: funnel(book.contacts, drafts, nowMs), change: referringDomainsChange(snapshots), apply });
  const note = notWritten ? `\nNOT WRITTEN to the contact book this week: ${notWritten}. The findings above will be found again next week.` : '';
  log(`\n${subject}\n\n${body}${note}`);
  if (apply) await tell({ subject: notWritten ? `${subject} · not written` : subject, body: body + note, status: 'info', category: 'press' });
  return { written: apply && !notWritten && found.length > 0, notWritten, found, book };
}

/** Weekly: look for our links and mentions on engaged pitches. Fails open. */
async function runLinkCheck(apply, config) {
  console.log(`Press link check${apply ? '' : ' (dry run)'}`);
  if (!config.enabled) { console.log('disabled in config/press-outreach.json'); return; }
  const authors = authorUrlsFromTargets(readJson('data/reports/pr-targets/latest.json'));
  const authorUrlOf = (c, p) => {
    let host = null;
    try { host = normalizeDomain(new URL(p.target_url).hostname); } catch { /* no target url */ }
    return (host && authors.get(host)) || null;
  };
  await runLinkCheckFlow({
    apply,
    readBook,
    writeBook,
    fetchPage: (u) => fetchWithOutcome(u),
    authorUrlOf,
    waitForLock: () => waitForLock(LINK_CHECK_LOCK_WAIT_MS),
    releaseLock: () => { try { unlinkSync(LOCK_PATH); } catch { /* already gone */ } },
    drafts: loadDrafts(join(ROOT, DRAFTS_DIR), undefined, { onError: () => {} }),
    snapshots: readBacklinkSnapshots(),
    notify,
  });
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
  if (args.includes('--redraft-followups')) {
    await runRedraftFollowupsMode(apply, env, config);
    return { imapDown: false };
  }
  if (args.includes('--redraft-bumps')) {
    await runRedraftBumpsMode(apply, env, config);
    return { imapDown: false };
  }
  if (args.includes('--backfill')) {
    await runBackfill(args, apply, creds, env);
    return { imapDown: false };
  }
  if (args.includes('--check-links')) {
    await runLinkCheck(apply, config);
    return { imapDown: false };
  }
  if (args.includes('--draft')) {
    await runDraftMode(args, apply, env, config);
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
    const draftErrors = [];
    const onDraftError = (name, err) => { console.log(`  skipped unreadable draft ${name}: ${err.message}`); if (!draftErrors.some((e) => e.name === name)) draftErrors.push({ name, err }); };
    const drafts = loadDrafts(join(ROOT, DRAFTS_DIR), undefined, { onError: onDraftError });
    const run = await runPressOutreach({
      env, apply, config, book: loaded.doc, state, drafts, postalAddress,
      sleep: async (ms) => { await new Promise((r) => setTimeout(r, ms)); touchLock(); },
      escalate: async (c, msg, reason) => { await notify({ ...escalationEmail(c, msg, reason), status: 'info', category: 'press', immediate: true }); },
      tellSean: async ({ subject, body }) => { await notify({ subject, body, status: 'info', category: 'press', immediate: true }); },
    });

    for (const e of draftErrors) run.failed.push({ id: e.name, kind: 'draft', error: `unreadable draft file data/press/drafts/${e.name} skipped: ${e.err.message}` });
    if (apply) {
      await refreshEvents(state, env, Date.now());
      const verdict = shouldPause(state.sends);
      if (verdict.pause && !state.paused) {
        state.paused = { at: new Date().toISOString(), reason: verdict.reason };
        // Kept after --resume: the cap does not ramp within rampAfterDays of any pause.
        state.pause_history = [...(state.pause_history || []), state.paused.at].slice(-50);
        run.paused = true;
        await notify({ immediate: true, status: 'info', category: 'press', subject: 'Press outreach PAUSED', body: `${verdict.reason}. Run node agents/press-outreach/index.js --resume after checking Resend.` });
      }
      writeState(state);
    }

    const { subject, body } = renderSummary(run, { apply, drafts: loadDrafts(join(ROOT, DRAFTS_DIR), undefined, { onError: onDraftError }), dashboardUrl: process.env.DASHBOARD_URL || env.DASHBOARD_URL || null });
    const noAddress = postalAddress ? '' : '\nNo postal_address in data/brand/brand-kit.json: first pitches are refused until it is set.';
    console.log(`\n${subject}\n\n${body}${noAddress}`);
    const acted = run.sent.length || run.followUps.length || run.replies.length || run.samples.length || run.escalations.length || run.expired.length || run.failed.length;
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
