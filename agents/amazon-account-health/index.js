/**
 * Amazon Account Health
 *
 * Daily read of Amazon's seller performance report (Account Health) for every
 * North America marketplace the account sells in. Read-only: it never edits a
 * listing and cannot submit an appeal (the SP-API has no endpoint for either).
 *
 * Why: the Geranium deodorant (B0B687ZWZ6) was removed for a Restricted
 * Products violation on 2026-08-04 and nothing noticed for ten weeks, during
 * which the open violation blocked Remote Fulfillment for Amazon.ca and
 * Amazon.com.br. See lib/amazon-account-health.js.
 *
 * Reports:
 *   - account status not NORMAL, or rating WARNED  -> `immediate: true` email
 *     when that set CHANGES from the previous run, else the daily digest only.
 *     A new at-risk state must not wait for 5 AM; a known one (a reactivation
 *     already pending) must not email every morning.
 *   - open policy violations -> `needs_decision[]` in latest.json, rendered in
 *     the digest's "Needs your decision" section, plus a deferred info row.
 *   - the app lacking the Selling Partner Insights role (HTTP 403) -> the check
 *     is OFF and the digest row says so. Never read a quiet day as clean.
 *
 * `status: 'error'` only when the agent itself broke.
 *
 * Writes: data/reports/amazon-account-health/{YYYY-MM-DD,latest}.json
 * Usage:  node agents/amazon-account-health/index.js [--no-notify]
 * Cron:   daily 12:05 UTC, ahead of the 13:00 UTC daily-summary.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { getClient, request } from '../../lib/amazon/sp-api-client.js';
import { notify } from '../../lib/notify.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import {
  MARKETPLACES, summarize, findings, needsDecisionRows, renderBody, urgentChanged,
} from '../../lib/amazon-account-health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-account-health');
const REPORT_TYPE = 'GET_V2_SELLER_PERFORMANCE_REPORT';
const POLL_MS = 15000;
const MAX_POLLS = 60; // 15 minutes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchReport(client, marketplaceIds) {
  const created = await request(client, 'POST', '/reports/2021-06-30/reports', { reportType: REPORT_TYPE, marketplaceIds });
  let r;
  for (let i = 0; i < MAX_POLLS; i++) {
    r = await request(client, 'GET', `/reports/2021-06-30/reports/${created.reportId}`);
    if (['DONE', 'FATAL', 'CANCELLED'].includes(r.processingStatus)) break;
    await sleep(POLL_MS);
  }
  if (r?.processingStatus !== 'DONE') throw new Error(`report ${created.reportId} ended ${r?.processingStatus || 'still pending after 15 min'}`);
  const doc = await request(client, 'GET', `/reports/2021-06-30/documents/${r.reportDocumentId}`);
  let buf = Buffer.from(await (await fetch(doc.url)).arrayBuffer());
  if (doc.compressionAlgorithm === 'GZIP') buf = gunzipSync(buf);
  return JSON.parse(buf.toString('utf8'));
}

function readPrevious() {
  const p = join(OUT_DIR, 'latest.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function write(result) {
  mkdirSync(OUT_DIR, { recursive: true });
  const json = JSON.stringify(result, null, 2);
  writeFileSync(join(OUT_DIR, `${result.generated_at.slice(0, 10)}.json`), json);
  writeFileSync(join(OUT_DIR, 'latest.json'), json);
}

export async function main({ doNotify = true } = {}) {
  const generated_at = new Date().toISOString();
  const client = getClient();
  const previous = readPrevious();

  let report;
  try {
    report = await fetchReport(client, Object.keys(MARKETPLACES));
  } catch (e) {
    if (/\(403\)/.test(e.message)) {
      const disarmed = 'the SP-API app lacks the "Selling Partner Insights" role (HTTP 403). Add it in Seller Central > Develop Apps and re-authorize.';
      write({ generated_at, disarmed, needs_decision: [] });
      console.log(`Account health check is OFF: ${disarmed}`);
      if (doNotify) await notify({ subject: 'Amazon account health: check is OFF (missing API role)', body: `Account Health was not checked: ${disarmed}`, status: 'info', category: 'amazon' });
      return { disarmed };
    }
    // One marketplace the account cannot request for should not cost the rest.
    if (/\(400\)/.test(e.message)) {
      console.log(`Multi-marketplace request refused (${e.message.slice(0, 120)}); retrying Amazon.com only.`);
      report = await fetchReport(client, ['ATVPDKIKX0DER']);
    } else {
      throw e;
    }
  }

  const summary = summarize(report);
  const found = findings(summary, previous, generated_at);
  const result = { generated_at, summary, urgent: found.urgent, open: found.open, needs_decision: needsDecisionRows(found.open) };
  write(result);

  const body = renderBody(summary, found);
  console.log(body);
  if (!doNotify) return result;

  const n = found.open.length;
  const fresh = found.open.filter((o) => o.isNew).length;
  // Email at once only when the at-risk set CHANGES; an unchanged at-risk state
  // (e.g. a reactivation already pending) stays in the daily digest instead.
  const emailNow = found.urgent.length > 0 && urgentChanged(found.urgent, previous);
  const subject = found.urgent.length
    ? `Amazon account health AT RISK: ${found.urgent.join('; ')}`
    : n
      ? `Amazon account health: ${n} open policy violation${n > 1 ? 's' : ''}${fresh ? ` (${fresh} new)` : ''}`
      : 'Amazon account health: all clear';
  await notify({ subject, body, status: found.urgent.length || n ? 'info' : 'success', category: 'amazon', immediate: emailNow });
  return result;
}

if (isDirectRun(import.meta.url)) {
  main({ doNotify: !process.argv.includes('--no-notify') }).catch(async (e) => {
    console.error(e);
    await notify({ subject: 'Amazon account health check failed', body: String(e?.stack || e), status: 'error', category: 'amazon' }).catch(() => {});
    process.exit(1);
  });
}
