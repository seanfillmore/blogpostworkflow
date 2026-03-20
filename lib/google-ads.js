/**
 * Shared Google Ads API v19 client
 *
 * Required .env keys:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REFRESH_TOKEN   (must include adwords scope — run scripts/reauth-google.js)
 *   GOOGLE_ADS_TOKEN       (developer token from Google Ads API Center)
 *   GOOGLE_ADS_CUSTOMER_ID (10-digit account ID, no dashes)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();

export const CUSTOMER_ID = parseCustomerId(env.GOOGLE_ADS_CUSTOMER_ID || '');
const DEV_TOKEN     = env.GOOGLE_ADS_TOKEN     || '';
const CLIENT_ID     = env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET || '';
const REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN || '';

// Credential guard is deferred to getAccessToken() so pure utility functions
// (parseCustomerId, buildHeaders, yesterdayPT) can be imported in unit tests
// without credentials present.

export function parseCustomerId(id) {
  return String(id || '').replace(/-/g, '');
}

export function buildHeaders(accessToken, devToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
}

export function yesterdayPT() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// ── token management ──────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

export async function getAccessToken() {
  if (!CUSTOMER_ID || !DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Missing Google Ads credentials. Required: GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN');
  }
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads token refresh failed: HTTP ${res.status} — ${text}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// ── GAQL query ────────────────────────────────────────────────────────────────

export async function gaqlQuery(query) {
  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/v19/customers/${CUSTOMER_ID}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, DEV_TOKEN),
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads GAQL query failed: HTTP ${res.status} — ${text}`);
  }
  const batches = await res.json();
  // searchStream returns an array of result batches
  return (Array.isArray(batches) ? batches : [batches])
    .flatMap(b => b.results || []);
}

// ── mutate ────────────────────────────────────────────────────────────────────

export async function mutate(operations) {
  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/v19/customers/${CUSTOMER_ID}/googleAds:mutate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token, DEV_TOKEN),
    body: JSON.stringify({ mutateOperations: operations, partialFailure: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Ads mutate failed: HTTP ${res.status} — ${text}`);
  }
  const data = await res.json();
  if (data.partialFailureError) {
    console.warn('⚠ Partial failure:', JSON.stringify(data.partialFailureError));
  }
  return data;
}

// ── daily performance snapshot ────────────────────────────────────────────────

export async function fetchDailySnapshot(date) {
  const campaignQuery = `
    SELECT
      campaign.resource_name,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.cost_per_conversion
    FROM campaign
    WHERE segments.date = '${date}'
    ORDER BY metrics.cost_micros DESC
  `;

  const kwQuery = `
    SELECT
      ad_group_criterion.resource_name,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      ad_group.resource_name,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.cost_micros,
      metrics.average_cpc
    FROM keyword_view
    WHERE segments.date = '${date}'
      AND metrics.impressions > 0
    ORDER BY metrics.conversions DESC
    LIMIT 10
  `;

  // Structural query: returns current-state entities (resource names for mutation use)
  // segments.date is not applicable to entity-level structural queries
  const adGroupQuery = `
    SELECT
      ad_group.resource_name,
      ad_group.name,
      campaign.resource_name
    FROM ad_group
    WHERE campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
  `;

  // Structural query: returns current-state entities (resource names for mutation use)
  // segments.date is not applicable to entity-level structural queries
  const adGroupAdQuery = `
    SELECT
      ad_group_ad.resource_name,
      ad_group.resource_name,
      ad_group_ad.ad.id
    FROM ad_group_ad
    WHERE ad_group_ad.status = 'ENABLED'
  `;

  const [campaignRows, kwRows, adGroupRows, adGroupAdRows] = await Promise.all([
    gaqlQuery(campaignQuery),
    gaqlQuery(kwQuery),
    gaqlQuery(adGroupQuery),
    gaqlQuery(adGroupAdQuery),
  ]);

  const campaigns = campaignRows.map(r => ({
    resourceName: r.campaign?.resource_name,
    id: r.campaign?.id,
    name: r.campaign?.name,
    status: r.campaign?.status,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    ctr: Number(r.metrics?.ctr || 0),
    avgCpc: Number(r.metrics?.average_cpc || 0) / 1_000_000,
    spend: Number(r.metrics?.cost_micros || 0) / 1_000_000,
    conversions: Number(r.metrics?.conversions || 0),
    revenue: Number(r.metrics?.conversions_value || 0),
    costPerConversion: Number(r.metrics?.cost_per_conversion || 0) / 1_000_000,
  }));

  const topKeywords = kwRows.map(r => ({
    criterionResourceName: r.ad_group_criterion?.resource_name,
    adGroupResourceName: r.ad_group?.resource_name,
    keyword: r.ad_group_criterion?.keyword?.text,
    matchType: r.ad_group_criterion?.keyword?.match_type,
    qualityScore: r.ad_group_criterion?.quality_info?.quality_score,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    conversions: Number(r.metrics?.conversions || 0),
    spend: Number(r.metrics?.cost_micros || 0) / 1_000_000,
    avgCpc: Number(r.metrics?.average_cpc || 0) / 1_000_000,
  }));

  const adGroups = adGroupRows.map(r => ({
    resourceName: r.ad_group?.resource_name,
    name: r.ad_group?.name,
    campaignResourceName: r.campaign?.resource_name,
  }));

  const adGroupAds = adGroupAdRows.map(r => ({
    resourceName: r.ad_group_ad?.resource_name,
    adGroupResourceName: r.ad_group?.resource_name,
    adId: r.ad_group_ad?.ad?.id,
  }));

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0);
  const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0);

  return {
    date,
    spend: Math.round(totalSpend * 100) / 100,
    impressions: totalImpressions,
    clicks: totalClicks,
    ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 10000 : 0,
    avgCpc: totalClicks > 0 ? Math.round((totalSpend / totalClicks) * 100) / 100 : 0,
    conversions: totalConversions,
    conversionRate: totalClicks > 0 ? Math.round(totalConversions / totalClicks * 10000) / 10000 : 0,
    costPerConversion: totalConversions > 0 ? Math.round((totalSpend / totalConversions) * 100) / 100 : 0,
    roas: totalSpend > 0 ? Math.round(totalRevenue / totalSpend * 100) / 100 : 0,
    revenue: Math.round(totalRevenue * 100) / 100,
    campaigns,
    topKeywords,
    adGroups,
    adGroupAds,
  };
}
