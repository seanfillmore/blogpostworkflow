#!/usr/bin/env node
/**
 * Send a one-off, hand-approved email to a list of Trybe creators through the
 * creator-outreach mail path (Resend from sean@realskincare.com, copy filed in
 * Hushmail Sent, replies handled by agents/creator-outreach as usual).
 *
 *   node scripts/creator-outreach-broadcast.mjs --id <id> --messages <file.json> [--attach <file>]... [--apply]
 *
 * <file.json> is an array of { email, subject, body }. Dry by default: prints
 * who would get what and who is skipped. Run it ON THE SERVER: the outreach
 * state is server-owned, and the skip rules (open escalation, unknown creator,
 * already sent) read it. Takes the agent's own lock so a scheduled run cannot
 * interleave. Skip rules live in lib/creator-broadcast.js.
 *
 * Delivery-gated (for a review ask, which must not land before the product does):
 *   --only-delivered        send only once the creator's Trybe sample order is delivered
 *   --delivered-days <n>    ...and at least n days ago (default 0)
 *   --expires <YYYY-MM-DD>  after this date, send nothing and say so. Required with
 *                           --only-delivered, because that mode is meant to run daily
 *                           from cron until everyone is ready, and a daily job with
 *                           no end date is a hold nobody remembers.
 */
import { readFileSync, existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';
import { hushmailCredentials, sendMail, validateAttachments } from '../lib/hushmail.js';
import { planBroadcast, recordBroadcast, holdUntilDelivered, isExpired } from '../lib/creator-broadcast.js';
import { fetchSampleOrders } from '../lib/trybe-sample-orders.js';
import { readState, writeState, loadConfig, STATE_PATH } from '../agents/creator-outreach/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(ROOT, 'data', 'creator-outreach', '.lock');
const PACE_MS = 1500;

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* none */ }
  return env;
}

function argValues(args, flag) {
  const out = [];
  args.forEach((a, i) => { if (a === flag && args[i + 1]) out.push(args[i + 1]); });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [id] = argValues(args, '--id');
  const [messagesPath] = argValues(args, '--messages');
  if (!id || !messagesPath) throw new Error('usage: --id <id> --messages <file.json> [--attach <file>]... [--apply]');

  const onlyDelivered = args.includes('--only-delivered');
  const [deliveredDaysArg] = argValues(args, '--delivered-days');
  const [expires] = argValues(args, '--expires');
  if (onlyDelivered && !expires) throw new Error('--only-delivered needs --expires YYYY-MM-DD');
  if (isExpired(expires)) {
    console.log(`broadcast "${id}" expired ${expires}; sending nothing. Remove its cron line.`);
    return;
  }

  const config = loadConfig();
  if (config.enabled === false) throw new Error('creator-outreach is disabled in config/creator-outreach.json; refusing to send');
  const state = readState();
  if (!state) throw new Error(`no state at ${STATE_PATH}; run this on the server`);

  const attachments = argValues(args, '--attach').map((p) => ({ filename: basename(p), content: readFileSync(p) }));
  validateAttachments(attachments);
  let messages = JSON.parse(readFileSync(messagesPath, 'utf8'));
  const waiting = [];
  if (onlyDelivered) {
    const orders = await fetchSampleOrders();
    const held = holdUntilDelivered(messages, orders, { afterDays: Number(deliveredDaysArg || 0) });
    messages = held.ready;
    waiting.push(...held.waiting);
  }
  const { send, skipped: planSkipped } = planBroadcast(messages, state, id);
  const skipped = [...planSkipped, ...waiting];

  console.log(`broadcast "${id}": ${send.length} to send, ${skipped.length} skipped${attachments.length ? `, attaching ${attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ')}` : ''}`);
  for (const s of skipped) console.log(`  SKIP ${s.email}: ${s.reason}`);
  if (!apply) {
    for (const m of send) console.log(`  would send to ${m.message.to}: "${m.message.subject}"`);
    console.log('dry run; add --apply to send');
    return;
  }
  // A daily delivery-gated run usually has nobody ready; that is not news.
  if (!send.length) return;

  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  if (existsSync(LOCK_PATH) && Date.now() - statSync(LOCK_PATH).mtimeMs < 25 * 60_000) {
    throw new Error('creator-outreach is running (lock held); try again in a few minutes');
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  const env = loadEnv();
  const creds = hushmailCredentials(env);
  const sent = [];
  const failed = [];
  try {
    for (const m of send) {
      try {
        const r = await sendMail(creds, { ...m.message, attachments }, { via: config.sendVia, resendKey: env.RESEND_API_KEY });
        const fresh = readState();
        recordBroadcast(fresh.creators[m.email], id, {
          at: new Date().toISOString(), messageId: r.messageId, subject: m.message.subject, attachments: attachments.map((a) => a.filename),
        });
        writeState(fresh);
        sent.push(m.email);
        console.log(`  sent ${m.email} ${r.messageId}${r.sentCopy ? ` (${r.sentCopy})` : ''}`);
      } catch (err) {
        failed.push({ email: m.email, error: err.message });
        console.log(`  FAILED ${m.email}: ${err.message}`);
      }
      await new Promise((res) => setTimeout(res, PACE_MS));
    }
  } finally {
    try { unlinkSync(LOCK_PATH); } catch { /* gone */ }
  }

  const body = [
    `Sent ${sent.length}, failed ${failed.length}, skipped ${skipped.length}.`,
    ...failed.map((f) => `FAILED ${f.email}: ${f.error}`),
    ...skipped.map((s) => `SKIPPED ${s.email}: ${s.reason}`),
  ].join('\n');
  await notify({ subject: `Creator broadcast "${id}": ${sent.length} sent`, body, status: 'info', category: 'creators' }).catch(() => {});
  if (failed.length) process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
