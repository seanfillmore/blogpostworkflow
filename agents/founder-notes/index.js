#!/usr/bin/env node
/**
 * Founder notes agent.
 *
 *   --send     Monday: email Sean 2-4 numbered questions anchored to recent
 *              reviews, a news item and an upcoming blog post.
 *   --ingest   Daily: read his reply, split it by number, redact private names
 *              and file each answer as a note in data/founder-notes/notes.jsonl.
 *
 * Dry by default: a dry --send prints the email it would send and writes
 * nothing; a dry --ingest reports what it would file. --apply sends / writes.
 * --now <iso> overrides the clock.
 *
 * Mail goes through lib/hushmail.js only, from and to HUSHMAIL_USER. The store
 * is server-only and gitignored (this repo is public). Every notify() is
 * deferred; status 'error' only from the main() catch.
 *
 * Cron (UTC): send `35 15 * * 1`, ingest `12 16 * * *`.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { hushmailCredentials, sendMail, fetchFromAllFolders, stripQuoted } from '../../lib/hushmail.js';
import { fetchRecentReviews } from '../../lib/judgeme.js';
import { searchWeb } from '../../lib/tavily.js';
import { clusterForText } from '../../lib/cluster-revenue.js';
import { checkSeoCopyFields, EDITORIAL_SURFACE, COMMERCIAL_SURFACE } from '../../lib/seo-copy-health-gate.js';
import { stripDashes } from '../../lib/press-outreach.js';
import { LLM_MODELS } from '../../config/llm-models.js';
import {
  weekId, pickReviews, pickNews, pickUpcoming, buildSources, templateQuestion, renderEmail, MIN_QUESTIONS,
} from '../../lib/founder-notes-questions.js';
import { isReplyTo, parseAnswers } from '../../lib/founder-notes-replies.js';
import { loadNotes, appendNotes, saveQuestionSet, loadQuestionSets, askedRefs } from '../../lib/founder-notes-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'founder-notes.json');
const DAY = 86_400_000;

export const REVIEW_DAYS = 7;
export const QUESTION_EXPIRY_DAYS = 14;
const NEWS_TRIES = 2;
const REDACTION_MIN_RATIO = 0.6;

const DEFAULT_CONFIG = Object.freeze({ enabled: true, sendVia: 'resend', newsQueries: [] });

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

/** The news query for `week`, rotated by ISO week number; `attempt` steps to the next one. */
export function newsQueryFor(queries, week, attempt = 0) {
  if (!queries?.length) return null;
  const n = Number(String(week).split('-W')[1]) || 0;
  return queries[(n + attempt) % queries.length];
}

const SOURCE_LABEL = { review: 'a customer review', world: 'a news item', upcoming: 'an upcoming blog post' };

function phrasingPrompt(sources) {
  const blocks = sources.map((s, i) => `[${i + 1}] Source: ${SOURCE_LABEL[s.type] || s.type}\n${s.context}`);
  return [
    'You write the weekly question email Real Skin Care sends to Sean, its co-founder, to collect his own stories and opinions.',
    `Below are ${sources.length} sources. Write exactly one question for each source, in the same order.`,
    'Each question is one short conversational sentence asking Sean for his reaction, a story or his opinion about that source.',
    'Do not quote the source in the question (it is shown under the question). No dashes. No names of customers.',
    `Return ONLY a JSON array of ${sources.length} strings.`,
    '',
    ...blocks,
  ].join('\n');
}

function parseQuestionArray(text, count) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error('no JSON array in reply');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || arr.length !== count) throw new Error(`expected ${count} questions, got ${Array.isArray(arr) ? arr.length : typeof arr}`);
  return arr.map((q) => {
    const s = stripDashes(String(q ?? '').replace(/\s+/g, ' ').trim());
    if (!s) throw new Error('empty question');
    return s;
  });
}

async function gatherNews(deps, week, askedUrls) {
  for (let attempt = 0; attempt < NEWS_TRIES; attempt++) {
    const q = newsQueryFor(deps.config.newsQueries, week, attempt);
    if (!q) return null;
    let results = [];
    try { results = await deps.searchNews(q); } catch (err) { deps.log?.(`  news search failed for "${q}": ${err.message}`); }
    const pick = pickNews(results, { askedUrls });
    if (pick) return pick;
  }
  return null;
}

/**
 * @returns {Promise<{status:'sent'|'skipped'|'dry-run', week:string, questions:Array, reason?:string, email?:object, counts?:object}>}
 */
export async function runSend({ now = new Date(), apply = false, deps }) {
  const log = deps.log || console.log;
  const week = weekId(now);
  const sets = loadQuestionSets({ dir: deps.dir });
  if (sets.some((s) => s.week === week)) {
    return { status: 'skipped', week, questions: [], reason: `already sent for ${week}` };
  }
  const asked = askedRefs(sets);

  let reviews = [];
  try { reviews = await deps.fetchReviews(REVIEW_DAYS); } catch (err) { log(`  reviews unavailable: ${err.message}`); }
  const news = await gatherNews(deps, week, asked.urls);
  let calendar = [];
  try { calendar = deps.loadCalendar() || []; } catch (err) { log(`  calendar unreadable: ${err.message}`); }

  const sources = buildSources({
    reviews: pickReviews(reviews, { asked: asked.reviews }),
    news,
    upcoming: pickUpcoming(calendar, { now, asked: asked.slugs }),
  });
  const counts = {
    reviews: sources.filter((s) => s.type === 'review').length,
    news: sources.filter((s) => s.type === 'world').length,
    upcoming: sources.filter((s) => s.type === 'upcoming').length,
  };
  if (sources.length < MIN_QUESTIONS) {
    return { status: 'skipped', week, questions: [], counts, reason: `only ${sources.length} question(s) sourced` };
  }

  let texts;
  try {
    const reply = await deps.complete({ model: LLM_MODELS.standard, prompt: phrasingPrompt(sources), maxTokens: 600 });
    texts = parseQuestionArray(reply, sources.length);
  } catch (err) {
    log(`  question phrasing failed (${err.message}); using template questions`);
    texts = sources.map(templateQuestion);
  }
  const questions = sources.map((source, i) => ({ index: i + 1, text: texts[i], source }));
  const email = renderEmail({ week, questions, now });

  if (!apply) return { status: 'dry-run', week, questions, counts, email };

  const to = deps.creds.user;
  const res = await deps.sendMail({ to, subject: email.subject, text: email.text, agent: 'founder-notes' });
  saveQuestionSet({
    week, sent_at: now.toISOString(), message_id: res.messageId, subject: email.subject,
    questions, replies: [],
  }, { dir: deps.dir });
  if (res.sentCopy) log(`  ${res.sentCopy}`);
  return { status: 'sent', week, questions, counts, email };
}

function redactionPrompt(text) {
  return [
    'Replace names of private individuals with their role (for example "a customer", "my business partner").',
    'Keep Sean, public figures and brand names. Change nothing else. Return only the text.',
    '',
    `TEXT:\n${text}`,
  ].join('\n');
}

async function redact(deps, raw) {
  try {
    const out = String(await deps.complete({ model: LLM_MODELS.fast, prompt: redactionPrompt(raw), maxTokens: Math.max(256, raw.length) }) ?? '').trim();
    if (out.length < REDACTION_MIN_RATIO * raw.length) return { answer: raw, redaction: 'failed' };
    return { answer: out, redaction: 'ok' };
  } catch {
    return { answer: raw, redaction: 'failed' };
  }
}

function gateFor(answer) {
  const ed = checkSeoCopyFields({ answer }, { surface: EDITORIAL_SURFACE });
  const co = checkSeoCopyFields({ answer }, { surface: COMMERCIAL_SURFACE });
  const tag = (surface) => (h) => ({ surface, category: h.category, match: h.match });
  return {
    editorial: ed.ok ? 'ok' : 'blocked',
    commercial: co.ok ? 'ok' : 'blocked',
    hits: [...ed.blocking.map(tag(EDITORIAL_SURFACE)), ...co.blocking.map(tag(COMMERCIAL_SURFACE))],
  };
}

function nextNoteNumber(notes, week) {
  const prefix = `fn-${week}-`;
  let max = 0;
  for (const n of notes) {
    if (!String(n.id).startsWith(prefix)) continue;
    const k = Number(String(n.id).slice(prefix.length));
    if (Number.isFinite(k) && k > max) max = k;
  }
  return max + 1;
}

/**
 * @returns {Promise<{filed:number, weeks:string[], notes:Array}>}
 */
export async function runIngest({ now = new Date(), apply = false, deps }) {
  const log = deps.log || console.log;
  const sets = loadQuestionSets({ dir: deps.dir });
  const existing = loadNotes({ dir: deps.dir });
  const filedNotes = [];
  const weeks = [];

  for (const set of sets) {
    if (set.expired) continue;
    const sentAt = Date.parse(set.sent_at);
    if (Number.isFinite(sentAt) && now.getTime() - sentAt > QUESTION_EXPIRY_DAYS * DAY) {
      if (apply) saveQuestionSet({ ...set, expired: true }, { dir: deps.dir });
      log(`  ${set.week}: expired`);
      continue;
    }
    const seen = new Set(set.replies || []);
    let messages = await deps.fetchReplies({ since: new Date(set.sent_at) });
    messages = (messages || [])
      .filter((m) => m?.messageId && m.messageId !== set.message_id && !seen.has(m.messageId))
      .filter((m) => isReplyTo(m, { messageId: set.message_id, week: set.week }))
      .sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0));
    if (!messages.length) continue;

    let n = nextNoteNumber([...existing, ...filedNotes], set.week);
    const replies = [...(set.replies || [])];
    let filedForSet = 0;
    for (const msg of messages) {
      const answers = parseAnswers(stripQuoted(msg.fullText ?? msg.text ?? ''), (set.questions || []).length);
      const notes = [];
      for (const a of answers) {
        const q = a.index == null ? null : set.questions.find((x) => x.index === a.index) || set.questions[a.index - 1];
        const question = q ? q.text : '';
        const source = q ? { type: q.source?.type ?? null, ref: q.source?.ref ?? null } : { type: 'general', ref: null };
        const { answer, redaction } = await redact(deps, a.answer);
        const cluster = clusterForText(`${question} ${answer}`);
        notes.push({
          id: `fn-${set.week}-${n++}`,
          week: set.week,
          asked_at: set.sent_at,
          answered_at: msg.date || now.toISOString(),
          message_id: msg.messageId,
          question,
          source,
          answer,
          answer_raw: a.answer,
          redaction,
          clusters: cluster ? [cluster] : [],
          gate: gateFor(answer),
          uses: [],
        });
      }
      if (apply) {
        appendNotes(notes, { dir: deps.dir });
        replies.push(msg.messageId);
        saveQuestionSet({ ...set, replies }, { dir: deps.dir });
      }
      filedNotes.push(...notes);
      filedForSet += notes.length;
    }
    if (filedForSet && !weeks.includes(set.week)) weeks.push(set.week);
  }
  return { filed: filedNotes.length, weeks, notes: filedNotes };
}

// ── main ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const nowIdx = argv.indexOf('--now');
  const now = nowIdx !== -1 && argv[nowIdx + 1] ? new Date(argv[nowIdx + 1]) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now: not a date: ${argv[nowIdx + 1]}`);
  return { send: argv.includes('--send'), ingest: argv.includes('--ingest'), apply: argv.includes('--apply'), now };
}

function readCalendar() {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data', 'calendar', 'calendar.json'), 'utf8'));
  return Array.isArray(doc?.items) ? doc.items : [];
}

function buildDeps(env, config) {
  const creds = hushmailCredentials(env);
  const judgemeToken = process.env.JUDGEME_API_TOKEN || env.JUDGEME_API_TOKEN;
  const shopifyStore = process.env.SHOPIFY_STORE || env.SHOPIFY_STORE;
  const tavilyKey = env.TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  const resendKey = env.RESEND_API_KEY || process.env.RESEND_API_KEY;
  const missing = [];
  if (!creds) missing.push('HUSHMAIL_USER/HUSHMAIL_PASSWORD');
  if (!judgemeToken || !shopifyStore) missing.push('JUDGEME_API_TOKEN/SHOPIFY_STORE');
  if (!tavilyKey) missing.push('TAVILY_API_KEY');
  if ((config.sendVia || 'resend') === 'resend' && !resendKey) missing.push('RESEND_API_KEY');
  return {
    missing,
    deps: {
      dir: 'data/founder-notes',
      creds,
      config,
      log: console.log,
      fetchReviews: async (days) => (judgemeToken && shopifyStore ? fetchRecentReviews(days, shopifyStore, judgemeToken) : []),
      searchNews: async (q) => (tavilyKey ? searchWeb(tavilyKey, q, { maxResults: 5, topic: 'news', timeRange: 'week' }) : []),
      loadCalendar: readCalendar,
      complete: async ({ model, prompt, maxTokens }) => {
        const { default: Anthropic } = await import('../../lib/anthropic.js');
        const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
        const res = await client.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] });
        if (res.stop_reason === 'max_tokens') throw new Error('reply truncated at max_tokens');
        return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      },
      sendMail: (msg) => sendMail(creds, msg, { via: config.sendVia || 'resend', resendKey, agent: 'founder-notes' }),
      fetchReplies: ({ since }) => fetchFromAllFolders(creds, { senders: [creds.user], since }),
    },
  };
}

function usesLastWeek(notes, now) {
  const cutoff = now.getTime() - 7 * DAY;
  const out = [];
  for (const n of notes) for (const u of n.uses || []) {
    if ((Date.parse(u.at) || 0) >= cutoff) out.push(`${n.id} in ${u.surface} ${u.ref}`);
  }
  return out;
}

async function main() {
  const { send, ingest, apply, now } = parseArgs(process.argv.slice(2));
  if (send === ingest) {
    console.error('Usage: node agents/founder-notes/index.js --send|--ingest [--apply] [--now <iso>]');
    process.exitCode = 64;
    return;
  }
  const config = loadConfig();
  if (config.enabled === false) {
    console.log('founder-notes: disabled in config/founder-notes.json, nothing to do.');
    return;
  }
  const env = loadEnv();
  const { missing, deps } = buildDeps(env, config);
  if (missing.length) console.log(`founder-notes: not configured on this machine: ${missing.join(', ')}`);

  if (send) {
    if (apply && !deps.creds) throw new Error('cannot send: HUSHMAIL_USER/HUSHMAIL_PASSWORD not set');
    const r = await runSend({ now, apply, deps });
    const c = r.counts || { reviews: 0, news: 0, upcoming: 0 };
    if (r.status === 'dry-run') {
      console.log(`\n[dry run] would send to ${deps.creds?.user || '(HUSHMAIL_USER not set)'}\nSubject: ${r.email.subject}\n\n${r.email.text}`);
      return;
    }
    const subject = r.status === 'sent'
      ? `Founder notes sent: ${r.questions.length} questions (${c.reviews} reviews, ${c.news} news, ${c.upcoming} upcoming)`
      : `Founder notes skipped: ${r.reason}`;
    console.log(subject);
    if (!apply) return;
    const notes = loadNotes({ dir: deps.dir });
    const uses = usesLastWeek(notes, now);
    await notify({
      subject, status: 'info', category: 'founder-notes',
      body: [`Notes on file: ${notes.length}`, `Uses in the last 7 days: ${uses.length ? uses.join('; ') : 'none'}`].join('\n'),
    });
    return;
  }

  if (!deps.creds) {
    console.log('founder-notes: cannot read replies without HUSHMAIL_USER/HUSHMAIL_PASSWORD; exiting.');
    return;
  }
  const r = await runIngest({ now, apply, deps });
  console.log(`${apply ? 'Filed' : '[dry run] would file'} ${r.filed} answer(s)${r.weeks.length ? ` for ${r.weeks.join(', ')}` : ''}`);
  for (const n of r.notes) console.log(`  ${n.id} [${n.source.type}] redaction=${n.redaction} gate=${n.gate.editorial}/${n.gate.commercial}`);
  if (!apply || r.filed === 0) return;
  const notes = loadNotes({ dir: deps.dir });
  const uses = usesLastWeek(notes, now);
  await notify({
    subject: `Founder notes: ${r.filed} answers filed for ${r.weeks.join(', ')}`,
    status: 'info', category: 'founder-notes',
    body: [`Notes on file: ${notes.length}`, `Uses in the last 7 days: ${uses.length ? uses.join('; ') : 'none'}`].join('\n'),
  });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(`founder-notes failed: ${err.stack || err.message}`);
    try {
      await notify({ subject: `Founder notes failed: ${err.message}`, body: String(err.stack || err.message), status: 'error', category: 'founder-notes' });
    } catch { /* the error is already on stderr */ }
    process.exitCode = 1;
  });
}
