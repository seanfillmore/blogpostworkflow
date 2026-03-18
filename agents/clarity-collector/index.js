/**
 * Clarity Collector Agent
 *
 * Fetches today's Microsoft Clarity live-insights snapshot and saves it to:
 *   data/snapshots/clarity/YYYY-MM-DD.json
 *
 * Exits early without writing a file if sessions.total === 0.
 *
 * Usage:
 *   node agents/clarity-collector/index.js
 *   node agents/clarity-collector/index.js --date 2026-03-17   # backfill
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fetchClarityInsights } from '../../lib/clarity.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'clarity');

const dateArgIdx = process.argv.indexOf('--date');
const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
  ?? (dateArgIdx !== -1 ? process.argv[dateArgIdx + 1] : undefined);
const date = dateArg || new Date().toISOString().slice(0, 10);

async function main() {
  console.log('Clarity Collector\n');
  console.log(`  Date: ${date}`);
  process.stdout.write('  Fetching Clarity insights... ');

  const data = await fetchClarityInsights();

  if (!data) {
    console.log('no session data — skipping snapshot');
    return false;
  }

  console.log(`done (${data.sessions.real} real sessions, ${data.sessions.bots} bots)`);

  const snapshot = { date, ...data };
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`  Snapshot saved: ${outPath}`);
  return true;
}

main()
  .then(saved => {
    if (saved) notify({ subject: 'Clarity Collector completed', body: `Snapshot saved for ${date}`, status: 'success' });
  })
  .catch(err => {
    notify({ subject: 'Clarity Collector failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
