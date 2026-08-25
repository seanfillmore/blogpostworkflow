#!/usr/bin/env node
/**
 * Is the sending domain healthy enough to run the consolation campaign?
 *
 *   node scripts/giveaway/deliverability-check.mjs            # last 7 days
 *   node scripts/giveaway/deliverability-check.mjs --days 3
 *   node scripts/giveaway/deliverability-check.mjs --json
 *
 * Exits non-zero on a `hold` verdict so it can gate a send rather than merely
 * describe one. Policy lives in lib/giveaway/deliverability.js; this file only
 * fetches counts.
 *
 * TWO KLAVIYO API SHAPES THIS GOT WRONG FIRST, both 400s worth stating so the
 * next caller does not rediscover them:
 *   - /metric-aggregates/ requires `page_size` >= 500. 100 is rejected outright.
 *   - It requires BOTH an upper and a lower date bound. A lone
 *     greater-or-equal(datetime,...) filter is rejected.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { assessDeliverability } from '../../lib/giveaway/deliverability.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const METRICS = {
  received: 'Received Email',
  spam: 'Marked Email as Spam',
  bounced: 'Bounced Email',
  opened: 'Opened Email',
  clicked: 'Clicked Email',
};

/** Inclusive-start, exclusive-end ISO bounds for the last `days` days. */
export function windowBounds(now, days) {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1); // through the end of today
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function countMetric(klaviyoRequest, findMetricByName, name, start, end) {
  const m = await findMetricByName(name);
  if (!m) return { total: 0, byDay: [], missing: true };
  const body = {
    data: {
      type: 'metric-aggregate',
      attributes: {
        metric_id: m.id,
        measurements: ['count'],
        interval: 'day',
        page_size: 500, // API minimum — 100 is a 400
        timezone: 'UTC',
        // BOTH bounds required, or the API 400s.
        filter: [`greater-or-equal(datetime,${start})`, `less-than(datetime,${end})`],
      },
    },
  };
  const r = await klaviyoRequest('POST', '/metric-aggregates/', body);
  const byDay = (r.data.attributes.data?.[0]?.measurements?.count || []).map((n) => n || 0);
  return { total: byDay.reduce((a, b) => a + b, 0), byDay, missing: false };
}

async function main() {
  const argv = process.argv;
  const daysArg = argv.indexOf('--days');
  const days = daysArg > -1 ? Number(argv[daysArg + 1]) : 7;
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days must be positive, got ${argv[daysArg + 1]}`);
  const asJson = argv.includes('--json');

  const { klaviyoRequest, findMetricByName } = await import('../../lib/klaviyo.js');
  const { start, end } = windowBounds(new Date(), days);

  const counts = {};
  for (const [key, name] of Object.entries(METRICS)) {
    counts[key] = await countMetric(klaviyoRequest, findMetricByName, name, start, end);
  }

  const assessment = assessDeliverability({
    received: counts.received.total,
    spam: counts.spam.total,
    bounced: counts.bounced.total,
  });

  const report = {
    window: { start, end, days },
    received: counts.received.total,
    spam: counts.spam.total,
    bounced: counts.bounced.total,
    opened: counts.opened.total,
    clicked: counts.clicked.total,
    openRate: counts.received.total ? counts.opened.total / counts.received.total : null,
    clickRate: counts.received.total ? counts.clicked.total / counts.received.total : null,
    ...assessment,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Window: ${start.slice(0, 10)} → ${end.slice(0, 10)} (${days}d)`);
    console.log(`  received ${report.received} | opened ${report.opened} | clicked ${report.clicked}`);
    console.log(`  spam ${report.spam} | bounced ${report.bounced}`);
    if (report.openRate !== null) {
      console.log(`  open ${(report.openRate * 100).toFixed(1)}% | click ${(report.clickRate * 100).toFixed(1)}%`);
    }
    console.log(`  daily received: ${counts.received.byDay.join(',')}`);
    console.log(`  daily spam:     ${counts.spam.byDay.join(',')}`);
    console.log(`\nVERDICT: ${assessment.verdict.toUpperCase()}`);
    for (const r of assessment.reasons) console.log(`  - ${r}`);
  }

  if (assessment.verdict === 'hold') process.exitCode = 1;
}

if (isDirectRun(import.meta.url)) {
  await main();
}
