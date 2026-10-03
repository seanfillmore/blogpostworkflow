#!/usr/bin/env node
/**
 * Creator Outreach — emails Trybe UGC creators from sean@realskincare.com:
 * a content brief when their sample ships, nudges on a fixed cadence after it
 * arrives, a thank-you when their video is approved, and quick answers to
 * their replies. Anything Sean must decide is escalated to him immediately.
 *
 * The policy (cadence, templates, what a reply may say) is the pure
 * lib/creator-outreach.js; mail is lib/hushmail.js; samples come from Shopify
 * via lib/trybe-sample-orders.js and content from Trybe via lib/trybe.js.
 *
 * Usage:
 *   node agents/creator-outreach/index.js              # dry run: plan, send nothing
 *   node agents/creator-outreach/index.js --apply      # send (cron does this)
 *   node agents/creator-outreach/index.js --apply --init   # first run: create the state file
 *   node agents/creator-outreach/index.js --test-send you@example.com   # one test email
 *
 * Cron: CREATOR_OUTREACH, every 30 minutes (scripts/setup-cron.sh). Replies go
 * out on any run; scheduled emails only inside the send window.
 *
 * Off switch: config/creator-outreach.json "enabled": false.
 * Requires HUSHMAIL_USER, HUSHMAIL_PASSWORD and TRYBE_API_KEY in .env.
 *
 * State: data/creator-outreach/state.json, gitignored and server-owned. It is
 * the only record of what each creator has already been sent, so a MISSING
 * state file refuses to send (it would re-send every welcome) unless --init.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { listSubmissions } from '../../lib/trybe.js';
import { fetchSampleOrders } from '../../lib/trybe-sample-orders.js';
import { hushmailCredentials, sendMail, fetchInboxFrom, fetchSentTo, isTransientNetworkError } from '../../lib/hushmail.js';
import {
  DEFAULT_CONFIG, buildRoster, planScheduled, classifyInbound, replyProblems,
  optOutReply, REPLY_SYSTEM, replyPrompt, parseDraft, replySubject, creatorState, SIGNATURE,
  withQuotedThread, senderLabel,
} from '../../lib/creator-outreach.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_PATH = join(ROOT, 'data', 'creator-outreach', 'state.json');
const CONFIG_PATH = join(ROOT, 'config', 'creator-outreach.json');
const LOCK_PATH = join(ROOT, 'data', 'creator-outreach', '.lock');
const INBOX_LOOKBACK_DAYS = 14;
const REPLY_MODEL = 'claude-sonnet-5-5';
/** Message-IDs kept for a References header; Gmail threads on any one of them. */
const MAX_THREAD_REFS = 20;

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

function touch(state, email) {
  state.creators ||= {};
  state.creators[email] ||= {};
  return state.creators[email];
}

/** Default reply drafter: one model call through the fleet's metered client. */
async function draftWithModel(c, msg, env) {
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: REPLY_MODEL,
    max_tokens: 700,
    system: REPLY_SYSTEM,
    messages: [{ role: 'user', content: replyPrompt(c, msg) }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('reply draft truncated at max_tokens');
  return parseDraft((res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

/**
 * One run. Every dependency is injectable so the orchestration is testable
 * without a mailbox, Shopify, Trybe or a model.
 */
export async function runOutreach({
  env = {},
  apply = false,
  now = Date.now(),
  config = DEFAULT_CONFIG,
  state,
  saveState = writeState,
  loadOrders = () => fetchSampleOrders({ now }),
  loadSubmissions = () => listSubmissions({ apiKey: env.TRYBE_API_KEY }),
  readInbox,
  readSent,
  send,
  draft = (c, msg) => draftWithModel(c, msg, env),
  escalate = async () => {},
  log = console.log,
} = {}) {
  const creds = hushmailCredentials(env);
  const us = `Sean at Real Skin Care <${creds?.user || 'sean@realskincare.com'}>`;
  readInbox ||= (q) => fetchInboxFrom(creds, q);
  readSent ||= (q) => fetchSentTo(creds, q);
  send ||= (m) => sendMail(creds, m, { via: config.sendVia, resendKey: env.RESEND_API_KEY });

  const [orders, submissions] = await Promise.all([loadOrders(), loadSubmissions()]);
  const roster = buildRoster({ orders, submissions });
  const byEmail = new Map(roster.map((c) => [c.email, c]));
  state.processed ||= [];
  const done = new Set(state.processed);
  const result = { replies: [], escalations: [], resolved: [], optOuts: [], ignored: [], scheduled: [], failed: [], plan: null };

  // ── 0. Has Sean answered anyone himself? ──
  // His own mail in the Sent folder (anything without the agent's header) to a
  // creator clears a flag raised before it, and is remembered so a creator's
  // answer to HIS message comes back to him rather than to the model.
  const sentBySean = await readSent({ recipients: [...byEmail.keys()], since: new Date(now - INBOX_LOOKBACK_DAYS * 86_400_000) });
  for (const m of sentBySean) {
    for (const email of m.to) {
      if (!byEmail.has(email)) continue;
      const rec = touch(state, email);
      if (m.messageId && !(rec.seanMessageIds || []).includes(m.messageId)) {
        rec.seanMessageIds = [...(rec.seanMessageIds || []), m.messageId].slice(-MAX_THREAD_REFS);
        rec.threadRefs = [...(rec.threadRefs || []), m.messageId].slice(-MAX_THREAD_REFS);
      }
      const since = rec.escalatedAt || rec.lastInboundAt;
      if (rec.escalatedOpen && since && m.date > since) {
        rec.escalatedOpen = false;
        rec.escalationResolvedAt = m.date;
        // The quoted thread we hold predates his reply; quoting it in a later
        // nudge would show a conversation with his answer missing.
        delete rec.thread;
        result.resolved.push({ email, name: byEmail.get(email).name, at: m.date });
      }
    }
  }
  if (apply && result.resolved.length) saveState(state);

  // ── 1. Replies first: a creator waiting on an answer outranks a reminder. ──
  const inbox = await readInbox({ senders: [...byEmail.keys()], since: new Date(now - INBOX_LOOKBACK_DAYS * 86_400_000) });
  const today = new Date(now).toISOString().slice(0, 10);
  for (const msg of inbox.sort((a, b) => a.date.localeCompare(b.date))) {
    if (!msg.messageId || done.has(msg.messageId)) continue;
    const c = byEmail.get(msg.from);
    if (!c) continue;
    const rec = touch(state, c.email);
    rec.lastInboundAt = msg.date;
    rec.repliesToday = rec.repliesDay === today ? rec.repliesToday || 0 : 0;
    rec.repliesDay = today;

    const verdict = classifyInbound(msg);
    let outgoing = null;
    let escalated = null;
    let row = { email: c.email, name: c.name, subject: msg.subject, said: msg.text.slice(0, 400) };
    const toSean = (msg.inReplyTo && (rec.seanMessageIds || []).includes(msg.inReplyTo))
      || (msg.references || []).some((id) => (rec.seanMessageIds || []).includes(id));
    // A real message (not a reaction or an autoresponder) from a creator whose
    // conversation is with Sean goes to Sean, whatever it says.
    const withSean = verdict.action !== 'ignore' && (rec.escalatedOpen || toSean);

    if (withSean) {
      escalated = { ...row, reasons: [rec.escalatedOpen ? 'a new message while this creator is waiting on you' : 'a reply to your own email', ...(verdict.reasons || [])], suggestion: null };
    } else if (verdict.action === 'ignore') {
      result.ignored.push({ ...row, reason: verdict.reason });
    } else if (verdict.action === 'opt-out') {
      rec.optedOut = true;
      outgoing = optOutReply(c);
      result.optOuts.push(row);
    } else {
      let reasons = verdict.reasons || [];
      let suggestion = null;
      if (verdict.action === 'draft') {
        try {
          const d = await draft(c, msg);
          if (d.action === 'reply') {
            const problems = replyProblems(d.reply);
            if (problems.length) { reasons = [`draft refused: ${problems.join('; ')}`]; suggestion = d.reply; }
            else outgoing = d.reply;
          } else reasons = [d.reason || 'the model could not answer from the facts it has'];
        } catch (err) {
          reasons = [`could not draft a reply: ${err.message}`];
        }
      }
      if (!outgoing) {
        // Flagged: nothing goes to the creator. Sean writes the answer.
        escalated = { ...row, reasons, suggestion };
      } else {
        result.replies.push({ ...row, reply: outgoing });
      }
    }

    if (escalated) {
      rec.escalatedOpen = true;
      rec.escalatedAt = msg.date;
      result.escalations.push(escalated);
    }
    if (verdict.action !== 'ignore') rec.thread = { date: msg.date, from: senderLabel(msg.fromName || c.name, c.email), text: msg.fullText || msg.text };

    if (outgoing && rec.repliesToday >= config.maxRepliesPerCreatorPerDay) {
      // A loop with an autoresponder is the realistic way this goes wrong.
      result.ignored.push({ ...row, reason: `reply cap (${config.maxRepliesPerCreatorPerDay}/day) reached` });
      outgoing = null;
    }
    if (outgoing) {
      // Every reply carries the conversation under it, so the creator's copy
      // and the Sent copy in Hushmail both read as one complete thread.
      outgoing = withQuotedThread(outgoing, { date: msg.date, from: senderLabel(msg.fromName || c.name, c.email), text: msg.fullText || msg.text });
    }
    if (outgoing && apply) {
      try {
        const refs = [...(msg.references || []), msg.messageId].slice(-MAX_THREAD_REFS);
        const sent = await send({
          to: c.email, subject: replySubject(msg.subject), text: outgoing,
          inReplyTo: msg.messageId, references: refs.join(' '),
        });
        rec.repliesToday += 1;
        rec.threadMessageId = sent.messageId;
        // The creator's own headers name IDs that exist in their mailbox. Ours
        // may not (the relay rewrites Message-ID), so later nudges thread on these.
        rec.threadRefs = [...refs, sent.messageId].slice(-MAX_THREAD_REFS);
        rec.thread = { date: new Date(now).toISOString(), from: us, text: outgoing };
      } catch (err) {
        result.failed.push({ ...row, error: err.message });
        continue; // leave unprocessed so the next run retries it
      }
    }
    if (apply) {
      if (escalated) await escalate(c, msg, escalated);
      state.processed.push(msg.messageId);
      done.add(msg.messageId);
      saveState(state);
    }
  }

  // ── 2. Scheduled emails. ──
  const plan = planScheduled(roster, state, { now, config });
  result.plan = plan;
  for (const s of plan.sends) {
    if (!apply) { result.scheduled.push(s); continue; }
    const rec = touch(state, s.email);
    const st = creatorState(state, s.email);
    try {
      const threaded = s.kind.startsWith('nudge') || s.kind === 'final';
      const refs = rec.threadRefs?.length ? rec.threadRefs : st.threadMessageId ? [st.threadMessageId] : [];
      const text = threaded ? withQuotedThread(s.text, rec.thread) : s.text;
      const sent = await send({
        to: s.email, subject: s.subject, text,
        ...(threaded && refs.length ? { inReplyTo: refs[refs.length - 1], references: refs.join(' ') } : {}),
      });
      const at = new Date(now).toISOString();
      if (threaded || s.kind === 'welcome') {
        rec.thread = { date: at, from: us, text };
        if (threaded && refs.length) rec.threadRefs = [...refs, sent.messageId].slice(-MAX_THREAD_REFS);
      }
      rec.sent = { ...(rec.sent || {}), [s.kind]: s.kind === 'thanks' ? (rec.sent?.thanks || 0) + 1 : at };
      if (s.kind === 'thanks') rec.thanked = [...(rec.thanked || []), ...s.extra.submissionIds];
      rec.lastScheduledAt = at;
      if (s.kind === 'welcome' || !rec.threadMessageId) rec.threadMessageId = sent.messageId;
      saveState(state);
      result.scheduled.push(s);
      log(`  sent ${s.kind} to ${s.name} <${s.email}>`);
    } catch (err) {
      result.failed.push({ email: s.email, name: s.name, kind: s.kind, error: err.message });
    }
  }
  return result;
}

export function renderSummary(r, { apply }) {
  const lines = [apply ? '' : 'DRY RUN: nothing was sent.'];
  const who = (x) => `${x.name} <${x.email}>`;
  if (r.scheduled.length) {
    lines.push(`Scheduled emails ${apply ? 'sent' : 'due'}:`);
    for (const s of r.scheduled) lines.push(`  - ${s.kind}: ${who(s)}`);
  }
  if (r.plan?.deferredByWindow?.length) lines.push(`${r.plan.deferredByWindow.length} scheduled email(s) waiting for the send window.`);
  if (r.replies.length) {
    lines.push('Replied automatically:');
    for (const x of r.replies) lines.push(`  - ${who(x)} asked: "${x.said.slice(0, 160)}"\n    we said: "${x.reply.replace(/\n+/g, ' ').slice(0, 300)}"`);
  }
  if (r.escalations.length) {
    lines.push('Sent to Sean to answer (nothing was sent to the creator):');
    for (const x of r.escalations) lines.push(`  - ${who(x)}: ${x.reasons.join('; ')}`);
  }
  if (r.resolved?.length) {
    lines.push('Sean replied, so the agent picked these creators back up:');
    for (const x of r.resolved) lines.push(`  - ${who(x)}`);
  }
  if (r.optOuts.length) lines.push(`Opted out: ${r.optOuts.map(who).join(', ')}`);
  if (r.failed.length) {
    lines.push('Send FAILED (will retry next run):');
    for (const f of r.failed) lines.push(`  - ${who(f)}: ${f.error}`);
  }
  const subject = `Creator outreach: ${r.scheduled.length} scheduled · ${r.replies.length} replied · ${r.escalations.length} escalated${r.failed.length ? ` · ${r.failed.length} FAILED` : ''}`;
  return { subject, body: lines.filter((l, i) => i > 0 || l).join('\n') || 'Nothing to do.' };
}

export function escalationEmail(c, msg, row) {
  return {
    subject: `Creator needs you: ${c.name} (${row.reasons.join('; ')})`,
    body: [
      `${c.name} <${c.email}> wrote:`, `Subject: ${msg.subject}`, '', msg.fullText || msg.text, '',
      `Why it came to you: ${row.reasons.join('; ')}`,
      'Nothing was sent to them. The agent will not reply to or remind this creator until you do.',
      ...(row.suggestion ? ['', 'The model\'s draft (NOT sent, for reference only):', row.suggestion] : []),
      '', 'Reply to them from Hushmail. Your reply is detected automatically (within 30 minutes) and the agent picks them back up.',
      'If they answer YOUR email, that answer comes to you too, not to the agent.',
    ].join('\n'),
  };
}

/** Single-instance guard: runs every 30 minutes and a model call can be slow. */
function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  if (existsSync(LOCK_PATH) && Date.now() - statSync(LOCK_PATH).mtimeMs < 25 * 60_000) return false;
  writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const env = loadEnv();
  const config = loadConfig();
  const creds = hushmailCredentials(env);

  const testTo = args[args.indexOf('--test-send') + 1];
  if (args.includes('--test-send')) {
    if (!creds) throw new Error('HUSHMAIL_USER / HUSHMAIL_PASSWORD are not in .env');
    const r = await sendMail(creds, { to: testTo, subject: 'Creator outreach test', text: `This is a test from the creator-outreach agent.\n\n${SIGNATURE}` }, { via: config.sendVia, resendKey: env.RESEND_API_KEY });
    console.log(`sent test to ${testTo} via ${config.sendVia}: ${r.messageId}${r.sentCopy ? ` (${r.sentCopy})` : ''}`);
    const inbox = await fetchInboxFrom(creds, { senders: [creds.user], since: new Date(Date.now() - 86_400_000) });
    console.log(`IMAP read OK (${inbox.length} message(s) from yourself in the last day)`);
    return;
  }

  if (args.includes('--resolve')) {
    const email = args[args.indexOf('--resolve') + 1]?.toLowerCase();
    const state = readState();
    if (!state?.creators?.[email]) throw new Error(`no state for ${email}`);
    state.creators[email].escalatedOpen = false;
    writeState(state);
    console.log(`cleared escalation for ${email}`);
    return;
  }

  console.log(`Creator outreach${apply ? '' : ' (dry run)'}`);
  if (!config.enabled) { console.log('disabled in config/creator-outreach.json'); return; }
  if (!creds) { console.log('HUSHMAIL_USER / HUSHMAIL_PASSWORD not in .env; nothing to do'); return; }

  let state = readState();
  if (!state) {
    if (apply && !args.includes('--init')) {
      // Cron runs every 30 minutes: report the refusal once a day, not 48 times.
      const marker = join(dirname(STATE_PATH), `.refused-${new Date().toISOString().slice(0, 10)}`);
      if (existsSync(marker)) { console.log('no state file; refusal already reported today'); return; }
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, '');
      throw new Error(`no state file at ${STATE_PATH}. Refusing to send: without it every creator would be re-sent every email. Restore it from backup, or run once with --init if this is genuinely the first run.`);
    }
    state = { createdAt: new Date().toISOString(), creators: {}, processed: [] };
    // Written now, not on the first send: a run with nothing to send would
    // otherwise leave no file, and the next cron run would refuse.
    if (apply) writeState(state);
  }

  if (apply && !acquireLock()) { console.log('another run is in progress'); return; }
  try {
    const run = await runOutreach({
      env, apply, config, state,
      saveState: apply ? writeState : () => {},
      escalate: async (c, msg, row) => { await notify({ ...escalationEmail(c, msg, row), status: 'info', category: 'creators', immediate: true }); },
    });
    const { subject, body } = renderSummary(run, { apply });
    console.log(`\n${subject}\n\n${body}`);
    const acted = run.scheduled.length || run.replies.length || run.escalations.length || run.optOuts.length || run.failed.length;
    if (apply && acted) await notify({ subject, body, status: 'info', category: 'creators' });
  } finally {
    if (apply) try { unlinkSync(LOCK_PATH); } catch { /* already gone */ }
  }
}

// A connection that still drops after connectImap's retries is reported only
// once it has failed this many CONSECUTIVE runs (cron is every 30 minutes, so
// 4 = two hours down). A single blip recovers on the next run by itself and is
// not a broken agent; a real outage still reaches the digest's Failures block.
export const TRANSIENT_ESCALATE_AFTER = 4;
const TRANSIENT_PATH = join(dirname(STATE_PATH), '.transient-failures.json');

/** Pure: given the previous streak and this run's outcome, what to record and whether to report. */
export function transientStreak(prev, { failed, now = new Date().toISOString() }) {
  if (!failed) return { next: null, report: false };
  const count = (prev?.count || 0) + 1;
  return { next: { count, since: prev?.since || now, last: now }, report: count >= TRANSIENT_ESCALATE_AFTER };
}

function readStreak() { try { return JSON.parse(readFileSync(TRANSIENT_PATH, 'utf8')); } catch { return null; } }
function writeStreak(v) {
  try { if (v) writeFileSync(TRANSIENT_PATH, JSON.stringify(v)); else if (existsSync(TRANSIENT_PATH)) unlinkSync(TRANSIENT_PATH); } catch { /* best effort */ }
}

if (isDirectRun(import.meta.url)) {
  main().then(() => writeStreak(null)).catch(async (err) => {
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
    try {
      await notify({ subject: 'Creator outreach failed', body: String(err?.stack || err), status: 'error', category: 'creators' });
    } catch { /* the console already has it */ }
    process.exit(1);
  });
}
