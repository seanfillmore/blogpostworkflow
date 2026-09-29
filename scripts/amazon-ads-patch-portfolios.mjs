#!/usr/bin/env node
/**
 * Backfill portfolios into an audit pull captured before the endpoint was fixed. READ ONLY
 * against the ad account (one list call); rewrites only the local audit JSON.
 *
 *   node scripts/amazon-ads-patch-portfolios.mjs [--in data/reports/amazon-ads-audit/latest.json]
 *
 * Exists because the 25-minute pull was already in flight when `/v2/portfolios` turned out
 * to be the wrong endpoint. Re-running the whole audit to fill one field would have cost
 * another 25 minutes of report generation for data that is one call away.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { isDirectRun } from '../lib/is-direct-run.js';
import { getClient, listProfiles, request } from '../lib/amazon/ads-api-client.js';

const CT = 'application/vnd.spPortfolio.v3+json';

async function main() {
  const argv = process.argv.slice(2);
  const inPath = argv.includes('--in')
    ? argv[argv.indexOf('--in') + 1]
    : 'data/reports/amazon-ads-audit/latest.json';

  const d = JSON.parse(readFileSync(inPath, 'utf8'));
  if (d.portfolios?.length) {
    console.log(`Already has ${d.portfolios.length} portfolios — nothing to do.`);
    return;
  }

  const client = getClient();
  await listProfiles(client);
  const res = await request(client, 'POST', '/portfolios/list', { maxResults: 200 },
    { contentType: CT, accept: CT });
  d.portfolios = res.portfolios ?? [];

  // The campaign objects already carry portfolioId, so no second pass is needed — report
  // how many actually resolve, because a portfolio list that joins to nothing is worse
  // than no portfolio list at all: it renders as a clean "(no portfolio)" rollup.
  const ids = new Set(d.portfolios.map((p) => String(p.portfolioId)));
  const mapped = d.campaigns.filter((c) => ids.has(String(c.portfolioId))).length;
  console.log(`Portfolios: ${d.portfolios.length}`);
  console.log(`Campaigns joined to one: ${mapped} of ${d.campaigns.length}`);

  writeFileSync(inPath, JSON.stringify(d, null, 2));
  console.log(`✓ Patched ${inPath}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
