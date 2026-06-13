/**
 * GA4 Collector Agent
 *
 * Fetches Google Analytics 4 data for a specific date and saves a snapshot to:
 *   data/snapshots/ga4/YYYY-MM-DD.json
 *
 * Usage:
 *   node agents/ga4-collector/index.js
 *   node agents/ga4-collector/index.js --date 2026-03-18
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchGA4Snapshot } from '../../lib/ga4.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'ga4');

const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
// Default to 2 days ago (PT), NOT today. GA4 purchase/ecommerce revenue takes
// ~24-48h to finalize, so snapshotting "today" captured ~$0 revenue every day
// (the daily snapshots all showed $0 even though GA4 had the sales). Two days
// back guarantees finalized monetization data in the snapshot.
function defaultDate() {
  const ptNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  ptNow.setDate(ptNow.getDate() - 2);
  return ptNow.toLocaleDateString('en-CA');
}
const date = dateArg || defaultDate();

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Invalid date format. Expected YYYY-MM-DD.');
  process.exit(1);
}

async function main() {
  console.log('GA4 Collector\n');
  console.log(`  Date: ${date}`);

  process.stdout.write('  Fetching GA4 snapshot... ');
  const snapshot = await fetchGA4Snapshot(date);
  console.log(`done (${snapshot.sessions} sessions, ${snapshot.conversions} conversions, $${snapshot.revenue} revenue)`);

  if (snapshot.devices?.length) {
    console.log('  Device breakdown:');
    for (const d of snapshot.devices) {
      const revShare = snapshot.revenue > 0 ? ` — $${d.revenue.toFixed(2)} (${(100 * d.revenue / snapshot.revenue).toFixed(0)}% of revenue)` : '';
      console.log(`    ${d.device.padEnd(8)} ${d.sessions} sessions, ${d.conversions} conv${revShare}`);
    }
  }

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
}

main()
  .then(async () => {
    await notify({ subject: 'GA4 Collector completed', body: `Snapshot saved for ${date}`, status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'GA4 Collector failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
