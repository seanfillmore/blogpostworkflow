/**
 * Amazon Ads API client (hand-rolled, minimal) — mirrors lib/amazon/sp-api-client.js.
 *
 * Usage:
 *   import { getClient, request, listProfiles, resolveProfileId } from '../../lib/amazon/ads-api-client.js';
 *   const client = getClient();
 *   const profiles = await listProfiles(client);
 *   const campaigns = await request(client, 'GET', '/v2/sp/campaigns');
 *
 * THIS IS A SEPARATE APP FROM SP-API. The Ads API and SP-API each have their own
 * LWA security profile, their own client id/secret and their own refresh token; the
 * SP-API credentials in AMAZON_SPAPI_* cannot be used here and vice versa.
 *
 * Auth shape, established against Amazon's own docs and sample code rather than recalled:
 *   - Authorization is the ordinary LWA authorization-code grant. The refresh token is
 *     minted once by a human in a browser (scripts/amazon-ads-authorize.mjs) and then
 *     traded for 60-minute access tokens forever.
 *   - Applications are NOT region-specific. Amazon states you may create, verify and
 *     refresh tokens at any regional LWA endpoint, so this file uses api.amazon.com
 *     regardless of marketplace. Only the ADS API HOST is regional, and RSC is US-only.
 *   - The scope is `advertising::campaign_management` and covers campaign management,
 *     reporting AND profile access. There is no separate reporting scope. The DOUBLE
 *     COLON is mandatory — a single colon is one of the three documented causes of
 *     `invalid_scope`, and it fails at the authorize step before any token exists.
 */

import 'dotenv/config';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const ADS_API_BASE_URL = 'https://advertising-api.amazon.com';

/** The only scope RSC needs. Double colon is load-bearing — see the header. */
export const ADS_SCOPE = 'advertising::campaign_management';

/** North America. RSC is US-only; EU/FE hosts are deliberately not carried here. */
export const ADS_AUTHORIZE_URL = 'https://www.amazon.com/ap/oa';

const US_MARKETPLACE_ID = 'ATVPDKIKX0DER';

export function getAdsApiBaseUrl() {
  return ADS_API_BASE_URL;
}

export function getClient() {
  const clientId = process.env.AMAZON_ADS_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_ADS_LWA_CLIENT_SECRET;
  const refreshToken = process.env.AMAZON_ADS_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    const missing = [
      !clientId && 'AMAZON_ADS_LWA_CLIENT_ID',
      !clientSecret && 'AMAZON_ADS_LWA_CLIENT_SECRET',
      !refreshToken && 'AMAZON_ADS_REFRESH_TOKEN',
    ].filter(Boolean);
    throw new Error(
      `Missing Amazon Ads API credentials: ${missing.join(', ')}. ` +
      `Mint a refresh token with: node scripts/amazon-ads-authorize.mjs --url`
    );
  }

  return {
    baseUrl: ADS_API_BASE_URL,
    clientId,
    clientSecret,
    refreshToken,
    // Optional: every call except the profiles endpoints needs a profile id.
    profileId: process.env.AMAZON_ADS_PROFILE_ID || null,
    accessToken: null,
    expiresAt: 0,
    /**
     * Set when a refresh response hands back a DIFFERENT refresh token than the one
     * we sent. Amazon documents both "you get a new refresh token" and "refresh tokens
     * are valid indefinitely", and says nothing about the old one being revoked, so
     * this is recorded rather than acted on: a caller that persists credentials can
     * write it down, and everything else keeps working either way.
     */
    rotatedRefreshToken: null,
  };
}

async function getAccessToken(client) {
  const now = Date.now();
  if (client.accessToken && client.expiresAt - now > 60_000) {
    return client.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: client.refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  client.accessToken = data.access_token;
  client.expiresAt = now + data.expires_in * 1000;

  if (data.refresh_token && data.refresh_token !== client.refreshToken) {
    client.rotatedRefreshToken = data.refresh_token;
  }

  return client.accessToken;
}

/**
 * @param {object} opts
 * @param {string|null} [opts.profileId] Overrides the client's profile id.
 * @param {boolean} [opts.scoped=true] Set false for the profile endpoints, which take
 *   no Amazon-Advertising-API-Scope header — you cannot know a profile id before
 *   calling them, and sending a bogus one is how that call 401s.
 */
export function request(client, method, path, params = null, opts = {}) {
  return _request(client, method, path, params, opts, 1);
}

async function _request(client, method, path, params, opts, attempt) {
  const accessToken = await getAccessToken(client);
  const scoped = opts.scoped !== false;
  const profileId = opts.profileId ?? client.profileId;

  if (scoped && !profileId) {
    throw new Error(
      `Amazon Ads ${method} ${path} needs a profile id. Set AMAZON_ADS_PROFILE_ID in .env ` +
      `(discover it with: node scripts/amazon-ads-authorize.mjs --verify), or pass { profileId }.`
    );
  }

  let url = `${client.baseUrl}${path}`;
  let body = null;

  if ((method === 'GET' || method === 'DELETE') && params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.append(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const queryStr = qs.toString();
    if (queryStr) url += `?${queryStr}`;
  } else if (params) {
    body = JSON.stringify(params);
  }

  const headers = {
    'Amazon-Advertising-API-ClientId': client.clientId,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (scoped) headers['Amazon-Advertising-API-Scope'] = String(profileId);

  const res = await fetch(url, { method, headers, body });

  if (res.status === 429 && attempt <= 3) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') ?? '');
    const sleepMs = Number.isFinite(retryAfter) ? Math.max(retryAfter * 1000, 1000) : 1000;
    console.warn(`Rate limited (attempt ${attempt}/3); sleeping ${sleepMs}ms`);
    await new Promise((r) => setTimeout(r, sleepMs));
    return _request(client, method, path, params, opts, attempt + 1);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON (e.g. a report redirect payload). Callers wanting bytes handle it themselves.
  }

  if (!res.ok) {
    const detail = data?.details || data?.message || data?.errors?.[0]?.message;
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`Amazon Ads ${method} ${path} failed (${res.status})${suffix}: ${text}`);
  }

  return data;
}

/**
 * Every advertiser account this LWA grant can reach. One profile per marketplace, so a
 * US-only seller has exactly one. Takes NO scope header — this is the call that resolves
 * the id every other call needs.
 *
 * An EMPTY array is not an error shape but it is a real finding: it means the authorizing
 * Amazon account has no advertising account attached, which is a different problem from
 * bad credentials and the caller is told so rather than being handed [].
 */
export async function listProfiles(client) {
  return request(client, 'GET', '/v2/profiles', null, { scoped: false });
}

/**
 * The US seller profile id, which is what belongs in AMAZON_ADS_PROFILE_ID.
 *
 * RSC and Culina share one Amazon seller account, so this resolves the ACCOUNT, not a
 * brand — brand separation is a matter of which campaigns/ASINs are read, exactly as it
 * is for SP-API. See the brand-classification rule in CLAUDE.md.
 */
export async function resolveProfileId(client, { countryCode = 'US', type = 'seller' } = {}) {
  const profiles = await listProfiles(client);

  if (!Array.isArray(profiles) || profiles.length === 0) {
    throw new Error(
      'Amazon Ads returned no profiles. The credentials are valid but the authorizing ' +
      'Amazon account has no advertising account attached — authorize with the account ' +
      'that can open the Amazon Ads console for this seller.'
    );
  }

  const match = profiles.find(
    (p) => p.countryCode === countryCode && p.accountInfo?.type === type
  );

  if (!match) {
    const seen = profiles
      .map((p) => `${p.profileId} (${p.countryCode}/${p.accountInfo?.type})`)
      .join(', ');
    throw new Error(
      `No ${countryCode} ${type} profile among the ${profiles.length} returned: ${seen}`
    );
  }

  return match.profileId;
}

export function getUsMarketplaceId() {
  return US_MARKETPLACE_ID;
}
