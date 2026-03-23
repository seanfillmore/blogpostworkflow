// agents/meta-ads-collector/index.js
/**
 * Meta Ads Collector
 *
 * Fetches active ads from Meta Ads Library for configured keywords and page IDs.
 * Saves a raw snapshot to data/snapshots/meta-ads-library/YYYY-MM-DD.json.
 *
 * Usage:
 *   node agents/meta-ads-collector/index.js
 *   node agents/meta-ads-collector/index.js --date 2026-03-18
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchByKeyword, searchByPageId } from '../../lib/meta-ads-library.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'meta-ads-library');

function loadConfig() {
  return JSON.parse(readFileSync(join(ROOT, 'config/meta-ads.json'), 'utf8'));
}

function todayPT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

async function main() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
  const date = dateArg || todayPT();

  console.log('Meta Ads Collector\n');
  console.log(`  Date: ${date}`);

  const cfg = loadConfig();
  const { searchCountry = 'US', searchKeywords = [], trackedPageIds = [] } = cfg;

  const allAds = [];
  const seen = new Set();

  function addAds(ads) {
    for (const ad of ads) {
      if (!seen.has(ad.id)) { seen.add(ad.id); allAds.push(ad); }
    }
  }

  for (const term of searchKeywords) {
    process.stdout.write(`  Searching: "${term}"... `);
    const ads = await searchByKeyword(term, searchCountry);
    addAds(ads);
    console.log(`${ads.length} ads`);
  }

  for (const pageId of trackedPageIds) {
    process.stdout.write(`  Page ID: ${pageId}... `);
    const ads = await searchByPageId(pageId);
    addAds(ads);
    console.log(`${ads.length} ads`);
  }

  console.log(`  Total unique ads: ${allAds.length}`);

  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const outPath = join(SNAPSHOTS_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify({ date, ads: allAds }, null, 2));
  console.log(`  Saved: ${outPath}`);
}

main()
  .then(async () => {
    await notify({ subject: 'Meta Ads Collector completed', body: 'Snapshot saved', status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'Meta Ads Collector failed', body: err.message, status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
