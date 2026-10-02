#!/usr/bin/env node
/**
 * Inbox Sorter — files new mail in sean@realskincare.com's Hushmail Inbox into
 * the folders Sean already uses (Newsletters, Cold Pitches, Amazon,
 * Notifications, one folder per partner), so the Inbox holds only mail from
 * people. Rules are learned from the folders themselves; see lib/inbox-sorter.js.
 *
 * MOVES, NEVER DELETES. Every move is recorded by Message-ID, so when Sean
 * drags a filed message back to the Inbox, that sender is never moved again.
 *
 * Usage:
 *   node agents/inbox-sorter/index.js           # dry run: print the plan, move nothing
 *   node agents/inbox-sorter/index.js --apply   # move (cron does this)
 *
 * Cron: DAILY_INBOX_SORTER, 13:40 UTC (scripts/setup-cron.sh).
 * Requires HUSHMAIL_USER / HUSHMAIL_PASSWORD in .env (lib/hushmail.js).
 * State: data/inbox-sorter/state.json (gitignored).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { hushmailCredentials, IMAP_HOST, IMAP_PORT } from '../../lib/hushmail.js';
import { learnRules, planMoves, pulledBack, isSystemFolder } from '../../lib/inbox-sorter.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_PATH = join(ROOT, 'data', 'inbox-sorter', 'state.json');
const OUTREACH_STATE = join(ROOT, 'data', 'creator-outreach', 'state.json');
/** Remembered moves; older ones are dropped so the file cannot grow forever. */
const MAX_REMEMBERED_MOVES = 20_000;
/** On the first run, Inbox mail older than this was left there on purpose. */
const SEED_KEEP_AGE_MS = 24 * 3_600_000;

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

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, STATE_PATH);
}

const BULK_HEADERS = /^(list-unsubscribe|list-id):|^precedence:\s*(bulk|list|junk)/im;

async function readBox(client, path, { headers = false } = {}) {
  const out = [];
  const lock = await client.getMailboxLock(path, { readOnly: true });
  try {
    if (!client.mailbox.exists) return out;
    for await (const m of client.fetch('1:*', {
      uid: true, envelope: true, flags: true, ...(headers ? { headers: ['list-unsubscribe', 'list-id', 'precedence'] } : {}),
    })) {
      out.push({
        uid: m.uid,
        messageId: m.envelope.messageId || null,
        from: m.envelope.from?.[0]?.address?.toLowerCase() || '',
        subject: m.envelope.subject || '',
        date: m.envelope.date ? m.envelope.date.toISOString() : '',
        flagged: m.flags.has('\\Flagged'),
        bulk: headers ? BULK_HEADERS.test(m.headers?.toString() || '') : false,
      });
    }
  } finally {
    lock.release();
  }
  return out;
}

export async function runSorter({ creds, apply = false, state, protect = new Set(), clientImpl, log = console.log }) {
  const client = clientImpl || new (await import('imapflow')).ImapFlow({
    host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user: creds.user, pass: creds.pass }, logger: false,
  });
  const ownDomain = creds.user.split('@')[1];
  await client.connect();
  try {
    const boxes = (await client.list()).filter((b) => !b.flags?.has?.('\\Noselect'));
    const filed = {};
    for (const b of boxes) if (!isSystemFolder(b)) filed[b.path] = await readBox(client, b.path);
    const rules = learnRules(filed);
    const inbox = await readBox(client, 'INBOX', { headers: true });

    // First run: everything already in Sean's folders counts as "filed", so
    // dragging any of it back to the Inbox is honoured from day one (the
    // initial sort on 2026-10-02 was done by hand and recorded nothing).
    // Likewise, a sender with mail that already sat in the Inbox after that sort
    // was deliberately left there: someone who sends both a newsletter and real
    // email must not have the real email filed away by the newsletter's rule.
    const seeding = !(state.moved || []).length;
    if (seeding) state.moved = Object.values(filed).flat().map((m) => m.messageId).filter(Boolean);
    const moved = new Set(state.moved);
    const keep = new Set([...(state.keep || []), ...pulledBack(inbox, moved)]);
    if (seeding) for (const m of inbox) if (Date.parse(m.date) < Date.now() - SEED_KEEP_AGE_MS) keep.add(m.from);
    const plan = planMoves(inbox, rules, { ownDomain, keep, protect });

    const result = { moves: [], keepAdded: seeding ? [] : [...keep].filter((a) => !(state.keep || []).includes(a)), seededKeep: seeding ? keep.size : 0, inbox: inbox.length, folders: Object.keys(filed).length };
    for (const [folder, msgs] of plan) {
      result.moves.push({ folder, count: msgs.length, senders: [...new Set(msgs.map((m) => m.from))] });
      if (!apply) continue;
      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.messageMove(msgs.map((m) => m.uid), folder, { uid: true });
      } finally {
        lock.release();
      }
      for (const m of msgs) if (m.messageId) moved.add(m.messageId);
      log(`  moved ${msgs.length} -> ${folder}`);
    }
    state.keep = [...keep];
    state.moved = [...moved].slice(-MAX_REMEMBERED_MOVES);
    state.lastRunAt = new Date().toISOString();
    return result;
  } finally {
    await client.logout().catch(() => {});
  }
}

export function renderSummary(r, { apply }) {
  const total = r.moves.reduce((s, m) => s + m.count, 0);
  const lines = [apply ? '' : 'DRY RUN: nothing was moved.'];
  for (const m of r.moves.sort((a, b) => b.count - a.count)) {
    lines.push(`  ${m.count} -> ${m.folder} (${m.senders.slice(0, 4).join(', ')}${m.senders.length > 4 ? ', ...' : ''})`);
  }
  if (r.seededKeep) lines.push(`First run: ${r.seededKeep} sender(s) already in the Inbox will always be left there.`);
  if (r.keepAdded.length) lines.push(`Now leaving in the Inbox (you moved their mail back): ${r.keepAdded.join(', ')}`);
  if (!total) lines.push('Nothing to file.');
  return { subject: `Inbox sorter: ${total} filed${r.keepAdded.length ? ` · ${r.keepAdded.length} sender(s) kept` : ''}`, body: lines.filter((l, i) => i > 0 || l).join('\n') };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const creds = hushmailCredentials(loadEnv());
  if (!creds) { console.log('HUSHMAIL_USER / HUSHMAIL_PASSWORD not in .env; nothing to do'); return; }
  const state = readJson(STATE_PATH, { keep: [], moved: [] });
  // Creator mail stays in the Inbox, where agents/creator-outreach reads it.
  const protect = new Set(Object.keys(readJson(OUTREACH_STATE, {}).creators || {}));
  console.log(`Inbox sorter${apply ? '' : ' (dry run)'}`);
  const r = await runSorter({ creds, apply, state, protect });
  if (apply) writeState(state);
  const { subject, body } = renderSummary(r, { apply });
  console.log(`\n${subject}\n${body}`);
  if (apply && (r.moves.length || r.keepAdded.length)) await notify({ subject, body, status: 'info', category: 'inbox' });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try { await notify({ subject: 'Inbox sorter failed', body: String(err?.stack || err), status: 'error', category: 'inbox' }); } catch { /* logged */ }
    process.exit(1);
  });
}
