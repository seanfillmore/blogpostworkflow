#!/usr/bin/env node
/**
 * Amazon Ads account audit — READ ONLY. Pulls structure + performance, writes JSON.
 *
 *   node scripts/amazon-ads-audit.mjs [--days 90] [--out data/reports/amazon-ads-audit]
 *
 * THIS SCRIPT MAKES NO WRITES TO THE AD ACCOUNT, and that is a structural guarantee
 * rather than a promise: every call it makes is a GET, or a POST to /reporting/reports
 * which creates a report and cannot mutate a campaign. Per the operator ruling of
 * 2026-09-05 (see the marketing-amazon-ppc-management skill), nothing may write to a
 * paid ads account without a human reviewing the exact list of writes first — an ad
 * write spends money on a schedule nobody approved and cannot be un-spent.
 *
 * BRAND SPLIT. RSC and Culina share one Amazon seller account, so every row is
 * classified before it is summed. Per CLAUDE.md the rule is a keyword test on the
 * product/campaign name: `culina` or `cast iron` → Culina, everything else → RSC.
 * Reporting a blended ACoS across two brands with different economics is the single
 * easiest way to draw a wrong conclusion from this account.
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDirectRun } from '../lib/is-direct-run.js';
import {
  getClient,
  listProfiles,
  request,
  runReport,
  isoDay,
} from '../lib/amazon/ads-api-client.js';

/**
 * Culina's catalogue is cast-iron / griddle care. The campaign names in this account
 * encode the product, so the same keyword rule CLAUDE.md applies to ASIN titles works
 * on campaign names. `blackstone` and `griddle` are Culina product lines that do not
 * contain the words "culina" or "cast iron"; `seasoning` is cast-iron seasoning, not a
 * food product. Anything unmatched falls to RSC, which is the safe default here because
 * this repo exists to grow RSC and an RSC row will therefore be read, not ignored.
 */
const CULINA_PATTERNS = [
  /culina/i, /cast\s*iron/i, /blackstone/i, /griddle/i,
  /seasoning/i, /\bscrub\b/i, /cleaning soap/i, /conditioner/i, /conditioning oil/i,
];

/**
 * ASIN → brand, read off the campaign names in this account (every campaign name encodes
 * the ASINs it advertises). THE ASIN IS CHECKED BEFORE THE KEYWORDS AND THAT ORDER IS THE
 * POINT: several real campaigns here carry no brand word at all — `SP - Auto (Loose) 0.40
 * - All - Prime - B08BTVXLXN` and `SP - Auto All (0.50) - All Enrolled - Prime - EB` — and
 * a keyword-only rule files the first under RSC when B08BTVXLXN is Culina's cleaning
 * scrub. Misfiling spend between two brands with different economics corrupts the only
 * number this audit exists to produce.
 */
const ASIN_BRAND = {
  // Culina — cast iron / griddle care
  B071SGF6GT: 'Culina', // cleaning soap
  B0771WC1Q1: 'Culina', // conditioning oil
  B08BTQK5Z9: 'Culina', // cast iron set / 3 pack
  B08BTVXLXN: 'Culina', // cleaning scrub
  B08KHGYYKQ: 'Culina', // soap + stick + conditioning oil
  B077LYR5SF: 'Culina', // soap & oil / 2 pack
  B08K892JQG: 'Culina', // seasoning stick & soap & oil
  B0984W3SG3: 'Culina',
  B08CQMQQ1K: 'Culina', // seasoning stick
  // RSC
  B09QJFBPJ1: 'RSC', B08GMCDMQ7: 'RSC', B0BSTLKV6N: 'RSC', // body lotions
  B0B6DQTL11: 'RSC', B0B6DHNCW3: 'RSC', B0B6DYZF5H: 'RSC', // toothpaste
  B0B687583D: 'RSC', B0B6873YQ7: 'RSC', B0B687ZWZ6: 'RSC', B0B686R9FZ: 'RSC', // deodorant
};

/**
 * Returns 'RSC' | 'Culina' | 'UNKNOWN'.
 *
 * UNKNOWN is a real third answer, not a failure: account-wide campaigns ("All Enrolled",
 * "All Products") genuinely span both brands, and silently folding them into RSC — the
 * fallback an earlier version used — would inflate exactly the figure this repo cares
 * about. They are reported as their own bucket so the split stays honest.
 */
export function classifyBrand(name) {
  const text = name || '';
  const asins = text.match(/B0[A-Z0-9]{8}/g) ?? [];
  const brands = new Set(asins.map((a) => ASIN_BRAND[a]).filter(Boolean));
  if (brands.size === 1) return [...brands][0];
  if (brands.size > 1) return 'UNKNOWN'; // genuinely mixed
  if (CULINA_PATTERNS.some((re) => re.test(text))) return 'Culina';
  if (/\b(lotion|toothpaste|deodorant|lip balm|body cream|real skin care|rsc)\b/i.test(text)) return 'RSC';
  return 'UNKNOWN';
}

const SP_CAMPAIGN_COLUMNS = [
  'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount',
  'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d',
  'clickThroughRate', 'costPerClick',
];

const SP_SEARCH_TERM_COLUMNS = [
  'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
  'keyword', 'keywordType', 'matchType', 'searchTerm',
  'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d',
];

const SP_TARGETING_COLUMNS = [
  'campaignId', 'campaignName', 'adGroupId', 'keywordId', 'keyword', 'matchType',
  'keywordType', 'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d',
];

const SP_PLACEMENT_COLUMNS = [
  'campaignId', 'campaignName', 'placementClassification',
  'impressions', 'clicks', 'cost', 'purchases30d', 'sales30d',
];

async function listAll(client, path, key, bodyExtra = {}, contentType) {
  const out = [];
  let nextToken = null;
  do {
    const body = { maxResults: 500, ...bodyExtra };
    if (nextToken) body.nextToken = nextToken;
    const data = await request(client, 'POST', path, body, { contentType, accept: contentType });
    out.push(...(data[key] ?? []));
    nextToken = data.nextToken;
  } while (nextToken);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const days = Number(argv[argv.indexOf('--days') + 1]) || 90;
  const outDir = argv.includes('--out')
    ? argv[argv.indexOf('--out') + 1]
    : 'data/reports/amazon-ads-audit';

  const client = getClient();
  const profiles = await listProfiles(client);
  const profile = profiles.find((p) => String(p.profileId) === String(client.profileId));
  console.log(`Profile ${client.profileId} — ${profile?.accountInfo?.name} (${profile?.countryCode})`);

  // Yesterday, not today: today's row is partial and makes every rate look wrong.
  const endDate = isoDay(Date.now() - 864e5);
  const startDate = isoDay(Date.now() - days * 864e5);
  console.log(`Window: ${startDate} → ${endDate} (${days}d)\n`);

  const log = (m) => console.log(`  ${m}`);

  console.log('Structure…');
  const campaigns = await listAll(client, '/sp/campaigns/list', 'campaigns', {},
    'application/vnd.spCampaign.v3+json');
  log(`campaigns: ${campaigns.length}`);

  const adGroups = await listAll(client, '/sp/adGroups/list', 'adGroups', {},
    'application/vnd.spAdGroup.v3+json');
  log(`ad groups: ${adGroups.length}`);

  const negativeKeywords = await listAll(client, '/sp/negativeKeywords/list', 'negativeKeywords', {},
    'application/vnd.spNegativeKeyword.v3+json').catch((e) => {
      log(`negative keywords: unavailable (${e.message.slice(0, 80)})`);
      return [];
    });
  log(`negative keywords: ${negativeKeywords.length}`);

  let portfolios = [];
  try {
    portfolios = (await request(client, 'GET', '/v2/portfolios')) ?? [];
    log(`portfolios: ${portfolios.length}`);
  } catch (e) {
    log(`portfolios: unavailable (${e.message.slice(0, 80)})`);
  }

  console.log('\nReports…');
  const base = { adProduct: 'SPONSORED_PRODUCTS', timeUnit: 'SUMMARY', format: 'GZIP_JSON' };

  const campaignPerf = await runReport(client, {
    name: 'audit-campaigns', startDate, endDate, onProgress: log,
    configuration: { ...base, groupBy: ['campaign'], columns: SP_CAMPAIGN_COLUMNS, reportTypeId: 'spCampaigns' },
  });
  log(`campaign rows: ${campaignPerf.length}`);

  const placementPerf = await runReport(client, {
    name: 'audit-placement', startDate, endDate, onProgress: log,
    configuration: { ...base, groupBy: ['campaignPlacement'], columns: SP_PLACEMENT_COLUMNS, reportTypeId: 'spCampaigns' },
  }).catch((e) => { log(`placement: ${e.message.slice(0, 120)}`); return []; });
  log(`placement rows: ${placementPerf.length}`);

  const targetingPerf = await runReport(client, {
    name: 'audit-targeting', startDate, endDate, onProgress: log,
    configuration: { ...base, groupBy: ['targeting'], columns: SP_TARGETING_COLUMNS, reportTypeId: 'spTargeting' },
  }).catch((e) => { log(`targeting: ${e.message.slice(0, 120)}`); return []; });
  log(`targeting rows: ${targetingPerf.length}`);

  // Search-term data ages out sooner than campaign data; ask for at most 60 days.
  const stStart = isoDay(Date.now() - Math.min(days, 60) * 864e5);
  const searchTerms = await runReport(client, {
    name: 'audit-search-terms', startDate: stStart, endDate, onProgress: log,
    configuration: { ...base, groupBy: ['searchTerm'], columns: SP_SEARCH_TERM_COLUMNS, reportTypeId: 'spSearchTerm' },
  }).catch((e) => { log(`search terms: ${e.message.slice(0, 120)}`); return []; });
  log(`search term rows: ${searchTerms.length}`);

  mkdirSync(outDir, { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    profile: { id: client.profileId, name: profile?.accountInfo?.name, country: profile?.countryCode },
    window: { startDate, endDate, days, searchTermStartDate: stStart },
    read_only: true,
    campaigns, adGroups, negativeKeywords, portfolios,
    campaignPerf, placementPerf, targetingPerf, searchTerms,
  };
  const file = join(outDir, 'latest.json');
  writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`\n✓ Wrote ${file}`);
  console.log(`  ${(JSON.stringify(payload).length / 1e6).toFixed(1)} MB`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(`\n✗ ${err.message}\n`); process.exit(1); });
}
