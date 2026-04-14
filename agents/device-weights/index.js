#!/usr/bin/env node
/**
 * Device Weights Agent
 *
 * Computes revenue-weighted device shares from GA4 snapshots and writes them
 * to `data/reports/device-weights/latest.json`. Downstream decision agents
 * (quick-win-targeter, content-strategist, legacy-triage) read this file to
 * blend desktop and mobile rank positions into a single "effective position"
 * weighted by where the site actually earns revenue.
 *
 * Output schema:
 *   {
 *     computed_at: ISO,
 *     window_days: 90,
 *     snapshot_count: N,
 *     site: { desktop: 0.43, mobile: 0.57, tablet: 0 },  // revenue share
 *     pages: {
 *       "/blogs/news/foo": { desktop: 0.25, mobile: 0.75, conversions: 8 }
 *     }
 *   }
 *
 * Per-page overrides kick in when a landing page has >= MIN_PAGE_CONVERSIONS
 * conversions in the window. Pages below that bar use the site-wide weights.
 *
 * Refresh cadence: monthly. Can be run manually or wired into a scheduler.
 *   node agents/device-weights/index.js
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GA4_DIR = join(ROOT, 'data', 'snapshots', 'ga4');
const OUT_DIR = join(ROOT, 'data', 'reports', 'device-weights');

const WINDOW_DAYS = 90;
const MIN_PAGE_CONVERSIONS = 3;

function main() {
  console.log('\nDevice Weights Agent\n');

  if (!existsSync(GA4_DIR)) {
    console.error('  No GA4 snapshots found. Run: node agents/ga4-collector/index.js');
    process.exit(1);
  }

  const files = readdirSync(GA4_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const recent = files.slice(-WINDOW_DAYS);
  if (recent.length === 0) {
    console.error('  No GA4 snapshot files matched the window.');
    process.exit(1);
  }
  console.log(`  Window: ${recent.length} snapshots (${recent[0]} → ${recent[recent.length - 1]})`);

  // Site-wide aggregates — revenue AND sessions, in case revenue is still thin.
  const site = {
    desktop: { rev: 0, sess: 0, conv: 0 },
    mobile:  { rev: 0, sess: 0, conv: 0 },
    tablet:  { rev: 0, sess: 0, conv: 0 },
  };
  // Per-page aggregates
  const pageMap = {};

  for (const f of recent) {
    let snap;
    try { snap = JSON.parse(readFileSync(join(GA4_DIR, f), 'utf8')); }
    catch { continue; }

    for (const d of (snap.devices || [])) {
      if (site[d.device]) {
        site[d.device].rev  += d.revenue     || 0;
        site[d.device].sess += d.sessions    || 0;
        site[d.device].conv += d.conversions || 0;
      }
    }
    for (const row of (snap.landingPagesByDevice || [])) {
      if (!pageMap[row.page]) {
        pageMap[row.page] = {
          desktop: { rev: 0, conv: 0 },
          mobile:  { rev: 0, conv: 0 },
          tablet:  { rev: 0, conv: 0 },
        };
      }
      if (pageMap[row.page][row.device]) {
        pageMap[row.page][row.device].rev  += row.revenue     || 0;
        pageMap[row.page][row.device].conv += row.conversions || 0;
      }
    }
  }

  // Site-wide weights — prefer revenue share; fall back to session share when
  // revenue is still too thin to be meaningful (e.g., brand-new store).
  const totalRev  = site.desktop.rev  + site.mobile.rev  + site.tablet.rev;
  const totalSess = site.desktop.sess + site.mobile.sess + site.tablet.sess;
  let siteWeights, basis;
  if (totalRev > 0) {
    siteWeights = {
      desktop: site.desktop.rev / totalRev,
      mobile:  site.mobile.rev  / totalRev,
      tablet:  site.tablet.rev  / totalRev,
    };
    basis = 'revenue';
  } else if (totalSess > 0) {
    siteWeights = {
      desktop: site.desktop.sess / totalSess,
      mobile:  site.mobile.sess  / totalSess,
      tablet:  site.tablet.sess  / totalSess,
    };
    basis = 'sessions (no revenue in window)';
  } else {
    console.error('  No sessions or revenue in any device for the window. Aborting.');
    process.exit(1);
  }

  // Per-page weights: only pages with enough conversions to be meaningful.
  // Pages with conversions but zero revenue (free-tier conversions?) still
  // get weights by conversion share so they can override the site default.
  const pages = {};
  for (const [path, dev] of Object.entries(pageMap)) {
    const conv = dev.desktop.conv + dev.mobile.conv + dev.tablet.conv;
    if (conv < MIN_PAGE_CONVERSIONS) continue;
    const pageRev = dev.desktop.rev + dev.mobile.rev + dev.tablet.rev;
    let weights;
    if (pageRev > 0) {
      weights = {
        desktop: dev.desktop.rev / pageRev,
        mobile:  dev.mobile.rev  / pageRev,
        tablet:  dev.tablet.rev  / pageRev,
      };
    } else {
      weights = {
        desktop: dev.desktop.conv / conv,
        mobile:  dev.mobile.conv  / conv,
        tablet:  dev.tablet.conv  / conv,
      };
    }
    pages[path] = { ...weights, conversions: conv, revenue: Math.round(pageRev * 100) / 100 };
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = {
    computed_at: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    snapshot_count: recent.length,
    basis,
    min_conversions_for_page_override: MIN_PAGE_CONVERSIONS,
    site: siteWeights,
    site_totals: {
      sessions:    totalSess,
      conversions: site.desktop.conv + site.mobile.conv + site.tablet.conv,
      revenue:     Math.round(totalRev * 100) / 100,
    },
    pages,
  };
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(out, null, 2));

  const pct = (x) => (x * 100).toFixed(1) + '%';
  console.log(`  Basis: ${basis}`);
  console.log(`  Site weights: desktop ${pct(siteWeights.desktop)}, mobile ${pct(siteWeights.mobile)}, tablet ${pct(siteWeights.tablet)}`);
  console.log(`  Per-page overrides: ${Object.keys(pages).length} page(s) with >= ${MIN_PAGE_CONVERSIONS} conversions`);
  console.log(`  Saved: data/reports/device-weights/latest.json`);
}

main();
