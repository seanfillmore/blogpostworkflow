/**
 * Email notifications via Resend.
 * Usage:
 *   import { notify } from '../lib/notify.js';
 *   await notify({ subject: 'Agent ran', body: 'markdown or plain text' });
 *
 * Scheduled mode (--scheduled flag):
 *   Non-error notifications are deferred to a daily digest file instead of
 *   sending immediately. Errors always send immediately. The daily-summary
 *   agent reads the digest file and sends one consolidated email per day.
 */

import { readFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DAILY_SUMMARY_DIR = join(ROOT, 'data', 'reports', 'daily-summary');
const IS_SCHEDULED = process.argv.includes('--scheduled') || process.env.NOTIFY_DEFERRED === '1';

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const _env = loadEnv();
const RESEND_API_KEY = process.env.RESEND_API_KEY || _env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || _env.NOTIFY_EMAIL;
const FROM_EMAIL = process.env.NOTIFY_FROM || _env.NOTIFY_FROM || 'SEO Claude <notifications@resend.dev>';

/**
 * Send an email notification.
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.body  - plain text or simple HTML
 * @param {'success'|'error'|'info'} [opts.status]
 */
export async function notify({ subject, body, status = 'info' }) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
    console.log('[notify] RESEND_API_KEY or NOTIFY_EMAIL not set, skipping.');
    return;
  }

  // Scheduled mode: defer non-errors to the daily summary digest
  if (IS_SCHEDULED && status !== 'error') {
    const date = new Date().toISOString().slice(0, 10);
    const entry = JSON.stringify({ ts: new Date().toISOString(), subject, body, status });
    try {
      mkdirSync(DAILY_SUMMARY_DIR, { recursive: true });
      appendFileSync(join(DAILY_SUMMARY_DIR, `${date}.jsonl`), entry + '\n');
      console.log(`[notify] Deferred to daily summary: ${subject}`);
    } catch (err) {
      console.error('[notify] Failed to write daily summary entry:', err.message);
    }
    return;
  }

  const icon = status === 'success' ? '✅' : status === 'error' ? '❌' : 'ℹ️';
  const fullSubject = `${icon} ${subject}`;

  const html = `<div style="font-family:monospace;font-size:14px;white-space:pre-wrap;">${escapeHtml(body)}</div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [NOTIFY_EMAIL],
      subject: fullSubject,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[notify] Resend error:', err);
  }
}

/**
 * Send a notification with the contents of a report file as the body.
 * Falls back to a generic message if the file doesn't exist.
 */
export async function notifyWithReport(subject, reportPath, status = 'success') {
  let body;
  try {
    body = readFileSync(reportPath, 'utf8');
  } catch {
    body = `${subject} — report file not found: ${reportPath}`;
  }
  return notify({ subject, body, status });
}

/**
 * Send a notification with the most recently modified .md file in a directory.
 */
export async function notifyLatestReport(subject, reportsDir, status = 'success') {
  try {
    const { readdirSync, statSync } = await import('fs');
    const files = readdirSync(reportsDir).filter(f => f.endsWith('.md'));
    if (!files.length) return notify({ subject, body: `${subject} — no report file found.`, status });
    const latest = files
      .map(f => ({ f, mtime: statSync(join(reportsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f;
    return notifyWithReport(subject, join(reportsDir, latest), status);
  } catch {
    return notify({ subject, body: `${subject} — could not read reports directory.`, status });
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
