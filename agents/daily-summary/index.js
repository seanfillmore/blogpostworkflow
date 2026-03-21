/**
 * Daily Summary Agent
 *
 * Reads today's deferred notification entries (written by lib/notify.js when
 * agents run with --scheduled) and sends one consolidated digest email.
 *
 * Run once per day after all scheduled cron jobs have completed.
 *
 * Usage:
 *   node agents/daily-summary/index.js
 *
 * Cron (server) — 11:55 PM PT (06:55 UTC):
 *   55 6 * * * cd ~/seo-claude && node agents/daily-summary/index.js >> data/logs/daily-summary.log 2>&1
 */

import { readFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DAILY_SUMMARY_DIR = join(ROOT, 'data', 'reports', 'daily-summary');
const LOG_DIR = join(ROOT, 'data', 'logs');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'daily-summary.log'), line + '\n');
  } catch { /* ignore */ }
}

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
        .filter(l => l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
  } catch { return {}; }
}

async function main() {
  const date = new Date().toISOString().slice(0, 10);
  const digestFile = join(DAILY_SUMMARY_DIR, `${date}.jsonl`);

  if (!existsSync(digestFile)) {
    log(`No digest file for ${date} — nothing to send.`);
    return;
  }

  const lines = readFileSync(digestFile, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) {
    log('Digest file is empty — nothing to send.');
    return;
  }

  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!entries.length) {
    log('No valid entries in digest file.');
    return;
  }

  log(`Sending daily summary with ${entries.length} entries.`);

  // Build email body
  const successEntries = entries.filter(e => e.status === 'success');
  const infoEntries = entries.filter(e => e.status === 'info' || !e.status);

  const sections = [];

  sections.push(`Daily Summary — ${date}`);
  sections.push(`${'='.repeat(40)}`);
  sections.push(`${entries.length} scheduled agent(s) ran today.\n`);

  for (const entry of entries) {
    const icon = entry.status === 'success' ? '✅' : 'ℹ️';
    sections.push(`${icon} ${entry.subject}`);
    sections.push(`   ${new Date(entry.ts).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit' })} PT`);
    if (entry.body) {
      // Indent body lines
      const bodyLines = entry.body.split('\n').map(l => `   ${l}`).join('\n');
      sections.push(bodyLines);
    }
    sections.push('');
  }

  const body = sections.join('\n');

  const env = loadEnv();
  const RESEND_API_KEY = process.env.RESEND_API_KEY || env.RESEND_API_KEY;
  const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || env.NOTIFY_EMAIL;
  const FROM_EMAIL = process.env.NOTIFY_FROM || env.NOTIFY_FROM || 'SEO Claude <notifications@resend.dev>';

  if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
    log('RESEND_API_KEY or NOTIFY_EMAIL not set — skipping.');
    return;
  }

  const escapeHtml = str => str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

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
      subject: `📋 Daily Summary — ${date} (${entries.length} agents)`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    log(`Resend error: ${err}`);
  } else {
    log('Daily summary sent.');
  }
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
