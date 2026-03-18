/**
 * Email notifications via Resend.
 * Usage:
 *   import { notify } from '../lib/notify.js';
 *   await notify({ subject: 'Agent ran', body: 'markdown or plain text' });
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
