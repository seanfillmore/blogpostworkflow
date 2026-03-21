/**
 * Meta Ads Library API client
 *
 * Auth: META_APP_ACCESS_TOKEN=APP_ID|APP_SECRET in .env
 * No OAuth flow required — app access token works for the Ads Library API.
 *
 * Exports:
 *   searchByKeyword(term, country)  → Ad[]
 *   searchByPageId(pageId)          → Ad[]
 *   buildAdArchiveUrl(params)       — pure, testable
 *   slugifyPageName(name)           — pure, testable
 *   extractNextCursor(body)         — pure, testable
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const ACCESS_TOKEN = env.META_APP_ACCESS_TOKEN || process.env.META_APP_ACCESS_TOKEN || '';

const AD_FIELDS = [
  'id',
  'page_id',
  'page_name',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_snapshot_url',
  'publisher_platforms',
].join(',');

const BASE_URL = 'https://graph.facebook.com/v21.0/ads_archive';

// ── Pure helpers ───────────────────────────────────────────────────────────────

export function slugifyPageName(name) {
  return (name || '')
    .normalize('NFD')
    .replace(/[a-zA-Z][\u0300-\u036f]+/g, '') // remove letter + combining diacritics (strips whole accented char)
    .replace(/[\u0300-\u036f]/g, '')           // strip any orphaned combining marks
    .replace(/[''\u2018\u2019]/g, '')          // strip apostrophes/smart quotes
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildAdArchiveUrl({ searchTerms, searchPageIds, adReachedCountries, after }) {
  const params = new URLSearchParams();
  params.set('access_token', ACCESS_TOKEN);
  params.set('fields', AD_FIELDS);
  params.set('ad_reached_countries', JSON.stringify(adReachedCountries || ['US']));
  params.set('ad_active_status', 'ALL');
  if (searchTerms) params.set('search_terms', searchTerms);
  if (searchPageIds) params.set('search_page_ids', searchPageIds.join(','));
  if (after) params.set('after', after);
  params.set('limit', '100');
  return `${BASE_URL}?${params.toString()}`;
}

export function extractNextCursor(body) {
  if (!body?.paging?.next) return null;
  return body?.paging?.cursors?.after || null;
}

// Normalize ad fields — Meta returns arrays for creative fields
export function normalizeAd(raw) {
  return {
    id: raw.id,
    page_id: raw.page_id,
    page_name: raw.page_name || '',
    page_slug: slugifyPageName(raw.page_name || ''),
    ad_delivery_start_time: raw.ad_delivery_start_time || null,
    ad_delivery_stop_time: raw.ad_delivery_stop_time || null,
    ad_creative_body: (raw.ad_creative_bodies || [])[0] || '',
    ad_creative_link_title: (raw.ad_creative_link_titles || [])[0] || '',
    ad_creative_link_description: (raw.ad_creative_link_descriptions || [])[0] || '',
    ad_snapshot_url: raw.ad_snapshot_url || '',
    publisher_platforms: raw.publisher_platforms || [],
  };
}

// ── Async API calls ────────────────────────────────────────────────────────────

async function fetchAllPages(firstUrl) {
  if (!ACCESS_TOKEN) throw new Error('META_APP_ACCESS_TOKEN not set in .env');
  const ads = [];
  let url = firstUrl;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Meta Ads Library API error ${res.status}: ${text}`);
    }
    const body = await res.json();
    if (body.error) throw new Error(`Meta Ads Library API error: ${body.error.message}`);
    for (const raw of (body.data || [])) ads.push(normalizeAd(raw));
    const cursor = extractNextCursor(body);
    url = cursor ? buildAdArchiveUrl({ after: cursor }) : null;
    // Safety: stop at 500 ads per search to avoid runaway pagination
    if (ads.length >= 500) break;
  }
  return ads;
}

export async function searchByKeyword(term, country = 'US') {
  const url = buildAdArchiveUrl({ searchTerms: term, adReachedCountries: [country], after: null });
  return fetchAllPages(url);
}

export async function searchByPageId(pageId) {
  const url = buildAdArchiveUrl({ searchPageIds: [pageId], adReachedCountries: ['US'], after: null });
  return fetchAllPages(url);
}
