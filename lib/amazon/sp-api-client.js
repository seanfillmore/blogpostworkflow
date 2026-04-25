/**
 * Amazon SP-API client (hand-rolled, minimal).
 *
 * Usage:
 *   import { getClient, request } from '../../lib/amazon/sp-api-client.js';
 *   const client = getClient();
 *   const data = await request(client, 'GET', '/sellers/v1/marketplaceParticipations');
 *
 * Env switch: AMAZON_SPAPI_ENV=sandbox|production (default production).
 */

import 'dotenv/config';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const MARKETPLACE_ID_US = 'ATVPDKIKX0DER';

const ENV_CONFIG = {
  production: {
    baseUrl: 'https://sellingpartnerapi-na.amazon.com',
    appIdVar: 'AMAZON_SPAPI_PRODUCTION_APP_ID',
    clientIdVar: 'AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_ID',
    clientSecretVar: 'AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_SECRET',
    refreshTokenVar: 'AMAZON_SPAPI_PRODUCTION_REFRESH_TOKEN',
  },
  sandbox: {
    baseUrl: 'https://sandbox.sellingpartnerapi-na.amazon.com',
    appIdVar: 'AMAZON_SPAPI_SANDBOX_APP_ID',
    clientIdVar: 'AMAZON_SPAPI_SANDBOX_LWA_CLIENT_ID',
    clientSecretVar: 'AMAZON_SPAPI_SANDBOX_LWA_CLIENT_SECRET',
    refreshTokenVar: 'AMAZON_SPAPI_SANDBOX_REFRESH_TOKEN',
  },
};

export function getMarketplaceId() {
  return MARKETPLACE_ID_US;
}

export function getClient() {
  const env = process.env.AMAZON_SPAPI_ENV || 'production';
  const config = ENV_CONFIG[env];
  if (!config) {
    throw new Error(`Invalid AMAZON_SPAPI_ENV: "${env}". Must be "production" or "sandbox".`);
  }

  const clientId = process.env[config.clientIdVar];
  const clientSecret = process.env[config.clientSecretVar];
  const refreshToken = process.env[config.refreshTokenVar];

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `Missing SP-API credentials for env "${env}". ` +
      `Required: ${config.clientIdVar}, ${config.clientSecretVar}, ${config.refreshTokenVar}`
    );
  }

  return {
    env,
    baseUrl: config.baseUrl,
    clientId,
    clientSecret,
    refreshToken,
    accessToken: null,
    expiresAt: 0,
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
  return client.accessToken;
}

export async function request(client, method, path, params = null, attempt = 1) {
  const accessToken = await getAccessToken(client);

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

  const res = await fetch(url, {
    method,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (res.status === 429 && attempt <= 3) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '1');
    const sleepMs = Math.max(retryAfter * 1000, 1000);
    console.warn(`Rate limited (attempt ${attempt}/3); sleeping ${sleepMs}ms`);
    await new Promise((r) => setTimeout(r, sleepMs));
    return request(client, method, path, params, attempt + 1);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g., report document). Callers using request() expect JSON; downloadReport handles non-JSON.
  }

  if (!res.ok) {
    throw new Error(`SP-API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return data;
}
