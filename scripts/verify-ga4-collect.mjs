#!/usr/bin/env node
/**
 * Verify that GA4 is actually collecting — end to end.
 *
 *   node scripts/verify-ga4-collect.mjs              # full check, notifies on failure
 *   node scripts/verify-ga4-collect.mjs --no-browser # skip the storefront load
 *   node scripts/verify-ga4-collect.mjs --json       # print JSON, never notify
 *
 * Written after an 8-day silent outage (2026-07-26 → 2026-08-03) in which the
 * GA4 property was moved to the trash by a Shopify app disconnect. Nothing
 * caught it, because every cheaper signal lies:
 *
 *   - `/g/collect` returns **204 for any measurement ID**, valid, trashed or
 *     invented. A 204 means a Google edge answered, nothing more.
 *   - A trashed property still answers `properties.get`, `dataStreams.list` and
 *     Data API report calls. It returns empty rows, which is indistinguishable
 *     from "the site had no traffic".
 *
 * So this checks the only things that can't lie, in order of root-cause depth:
 *
 *   1. PROPERTY   — is `deleteTime` set? (in the trash ⇒ discarding every hit)
 *   2. TAG        — does a real browser load actually send a hit to the
 *                   property's own measurement ID? (read from its data stream,
 *                   never hardcoded, so a recreated stream can't fool it)
 *   3. RECORDED   — does the Realtime API report those events coming back out?
 *                   Sent-but-not-recorded is the exact signature of a property
 *                   that is discarding hits.
 *   4. FRESHNESS  — how many days since the last recorded session, to catch a
 *                   slow failure the live probe would walk straight past.
 *
 * Exits non-zero and emails immediately on failure — this gates paid spend.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { GA4_PROPERTY_ID, getGA4AccessToken } from '../lib/ga4.js';
import { notify } from '../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ga4-health');

/** A day of reporting latency is normal; two is the edge of normal. */
export const STALE_DAYS = 2;
/** Realtime can take a few seconds to surface a hit. Poll rather than guess. */
const REALTIME_ATTEMPTS = 4;
const REALTIME_WAIT_MS = 15_000;

// ── pure helpers (unit-tested) ───────────────────────────────────────────────

/** The web stream's measurement ID, read from the property itself. */
export function findMeasurementId(streamsResponse) {
  const streams = streamsResponse?.dataStreams || [];
  for (const s of streams) {
    const id = s?.webStreamData?.measurementId;
    if (id) return id;
  }
  return null;
}

/** Whole days between a GA4 `YYYYMMDD` date and a `YYYY-MM-DD` reference. */
export function daysSince(yyyymmdd, todayIso) {
  if (!yyyymmdd) return Infinity;
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  const then = Date.parse(`${iso}T00:00:00Z`);
  const now = Date.parse(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return Infinity;
  return Math.round((now - then) / 86_400_000);
}

/**
 * Turn gathered evidence into a verdict. Failures are ordered root-cause first:
 * a trashed property *causes* the zero-realtime and staleness failures beneath
 * it, and burying the cause under its own symptoms is how this took 8 days.
 */
export function buildVerdict({ property, measurementId, browser, realtime, lastSessionDate, today }) {
  const failures = [];
  const warnings = [];

  // 1. Root cause that outranks everything else.
  if (property?.deleteTime) {
    const expiry = property.expireTime
      ? ` Permanent deletion: ${property.expireTime.slice(0, 10)} — restore before then or the history is gone for good.`
      : '';
    failures.push(
      `Property is in the TRASH (deleted ${property.deleteTime.slice(0, 10)}) and is discarding every hit.${expiry}` +
        ' Restore: GA4 → Admin → Trash can → Restore. There is no API method for this.',
    );
  }

  if (!measurementId) {
    failures.push('Property has no web data stream — nothing can send to it.');
  }

  // 2. Tag layer.
  if (browser) {
    if (browser.hitsSent === 0) {
      failures.push(
        `A real page load sent no hits to ${measurementId || 'the property'}.` +
          ' The tag is missing or the pixel no longer lists GA4 as a destination.',
      );
    }
    // 3. Sent but not recorded — the discarding-property signature.
    if (browser.hitsSent > 0 && realtime?.eventCount === 0) {
      failures.push(
        `Sent ${browser.hitsSent} hit(s) but the property recorded 0 events in realtime.` +
          ' Hits are being accepted at the edge and thrown away.',
      );
    }
  } else {
    warnings.push('Browser check skipped — the tag layer was not verified this run.');
  }

  // 4. Freshness.
  const stale = daysSince(lastSessionDate, today);
  if (stale === Infinity) {
    failures.push('No sessions recorded anywhere in the lookback window.');
  } else if (stale > STALE_DAYS) {
    failures.push(`No sessions recorded for ${stale} days (last: ${lastSessionDate}).`);
  }

  return { ok: failures.length === 0, failures, warnings };
}

// ── API calls ────────────────────────────────────────────────────────────────

async function googleGet(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function googlePost(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Realtime event count over the last 30 minutes. */
async function realtimeEventCount(token) {
  const j = await googlePost(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runRealtimeReport`,
    token,
    {
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
    },
  );
  const rows = j.rows || [];
  return {
    eventCount: rows.reduce((n, r) => n + Number(r.metricValues?.[0]?.value || 0), 0),
    events: rows.map((r) => `${r.dimensionValues[0].value}=${r.metricValues[0].value}`),
  };
}

/** Most recent date with at least one session, within the last 10 days. */
async function lastSessionDate(token) {
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 86_400_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const j = await googlePost(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    token,
    {
      dateRanges: [{ startDate: iso(start), endDate: iso(end) }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }],
    },
  );
  for (const r of j.rows || []) {
    if (Number(r.metricValues?.[0]?.value || 0) > 0) return r.dimensionValues[0].value;
  }
  return null;
}

/**
 * Load the storefront in a real browser and count hits addressed to this
 * property. Requests are counted, not responses — a 204 proves nothing.
 */
async function browserProbe(siteUrl, measurementId) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // A default headless UA risks being dropped by GA4 bot filtering, which
    // would look exactly like a broken tag.
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    );
    await page.setViewport({ width: 1440, height: 900 });

    const events = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.includes(`tid=${measurementId}`)) return;
      const en = (u.match(/[?&]en=([^&]*)/) || [, null])[1];
      if (en) events.push(decodeURIComponent(en));
    });

    await page.goto(siteUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 8000));
    return { hitsSent: events.length, events };
  } finally {
    await browser.close();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const useBrowser = !args.includes('--no-browser');
  const siteUrl = JSON.parse(readFileSync(join(ROOT, 'config/site.json'), 'utf8')).url;

  const token = await getGA4AccessToken();
  const base = `https://analyticsadmin.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}`;
  const property = await googleGet(base, token);
  const measurementId = findMeasurementId(await googleGet(`${base}/dataStreams`, token));

  let browser = null;
  if (useBrowser && measurementId) {
    try {
      browser = await browserProbe(siteUrl, measurementId);
    } catch (err) {
      // A broken probe must not masquerade as a broken tag.
      browser = null;
      console.error(`[verify-ga4] browser probe failed, skipping tag check: ${err.message}`);
    }
  }

  // Poll: realtime lags a few seconds, and the probe above just generated the
  // traffic we expect to see come back.
  let realtime = { eventCount: 0, events: [] };
  for (let i = 0; i < REALTIME_ATTEMPTS; i++) {
    realtime = await realtimeEventCount(token);
    if (realtime.eventCount > 0) break;
    if (i < REALTIME_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, REALTIME_WAIT_MS));
  }

  const verdict = buildVerdict({
    property,
    measurementId,
    browser,
    realtime,
    lastSessionDate: await lastSessionDate(token),
    today: new Date().toISOString().slice(0, 10),
  });

  const report = {
    checkedAt: new Date().toISOString(),
    propertyId: GA4_PROPERTY_ID,
    propertyName: property.displayName,
    measurementId,
    inTrash: Boolean(property.deleteTime),
    expireTime: property.expireTime || null,
    browser,
    realtime,
    ...verdict,
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(verdict.ok ? 0 : 1);
  }

  console.log(`GA4 ${property.displayName} (${GA4_PROPERTY_ID}) → ${measurementId}`);
  console.log(`  tag sent   : ${browser ? `${browser.hitsSent} hit(s) [${browser.events.join(', ')}]` : 'skipped'}`);
  console.log(`  recorded   : ${realtime.eventCount} event(s) [${realtime.events.join(', ')}]`);
  console.log(`  verdict    : ${verdict.ok ? 'OK — collecting' : 'FAILING'}`);
  verdict.warnings.forEach((w) => console.log(`  warning    : ${w}`));
  verdict.failures.forEach((f) => console.log(`  FAILURE    : ${f}`));

  if (!verdict.ok) {
    await notify({
      subject: `GA4 is not collecting — ${property.displayName}`,
      status: 'error',
      category: 'collector',
      immediate: true,
      body:
        `GA4 property ${property.displayName} (${GA4_PROPERTY_ID}) failed its collection check.\n\n` +
        verdict.failures.map((f) => `- ${f}`).join('\n') +
        `\n\nTag sent: ${browser ? browser.hitsSent : 'not checked'} hit(s). Recorded: ${realtime.eventCount} event(s).` +
        '\n\nPaid campaigns should stay paused until this passes.',
    });
    process.exit(1);
  }
}

// Only run when invoked directly, so the tests can import the pure helpers.
if (process.argv[1] && process.argv[1].endsWith('verify-ga4-collect.mjs')) {
  main().catch(async (err) => {
    console.error(`[verify-ga4] ${err.message}`);
    await notify({
      subject: 'GA4 collection check could not run',
      status: 'error',
      category: 'collector',
      immediate: true,
      body: `verify-ga4-collect.mjs threw before reaching a verdict:\n\n${err.stack || err.message}`,
    });
    process.exit(2);
  });
}
