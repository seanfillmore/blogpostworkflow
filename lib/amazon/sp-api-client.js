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
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const MARKETPLACE_ID_US = 'ATVPDKIKX0DER';

const ENV_CONFIG = {
  production: {
    baseUrl: 'https://sellingpartnerapi-na.amazon.com',
    clientIdVar: 'AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_ID',
    clientSecretVar: 'AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_SECRET',
    refreshTokenVar: 'AMAZON_SPAPI_PRODUCTION_REFRESH_TOKEN',
  },
  sandbox: {
    baseUrl: 'https://sandbox.sellingpartnerapi-na.amazon.com',
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

export function request(client, method, path, params = null) {
  return _request(client, method, path, params, 1);
}

async function _request(client, method, path, params, attempt) {
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
    const retryAfter = parseFloat(res.headers.get('Retry-After') ?? '');
    const sleepMs = Number.isFinite(retryAfter) ? Math.max(retryAfter * 1000, 1000) : 1000;
    console.warn(`Rate limited (attempt ${attempt}/3); sleeping ${sleepMs}ms`);
    await new Promise((r) => setTimeout(r, sleepMs));
    return _request(client, method, path, params, attempt + 1);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g., report document). Callers using request() expect JSON; downloadReport handles non-JSON.
  }

  if (!res.ok) {
    const detail = data?.errors?.[0]?.message;
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`SP-API ${method} ${path} failed (${res.status})${suffix}: ${text}`);
  }

  return data;
}

/**
 * Report helpers (async SP-API Reports flow).
 *
 * Usage:
 *   const reportId = await requestReport(client, 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [getMarketplaceId()], startIso, endIso);
 *   const reportDocumentId = await pollReport(client, reportId);
 *   const rows = await downloadReport(client, reportDocumentId);
 */

export async function requestReport(client, reportType, marketplaceIds, dataStartTime, dataEndTime, reportOptions = null) {
  const body = {
    reportType,
    marketplaceIds: Array.isArray(marketplaceIds) ? marketplaceIds : [marketplaceIds],
  };
  if (dataStartTime) body.dataStartTime = dataStartTime;
  if (dataEndTime) body.dataEndTime = dataEndTime;
  if (reportOptions) body.reportOptions = reportOptions;

  const data = await request(client, 'POST', '/reports/2021-06-30/reports', body);
  return data.reportId;
}

export async function pollReport(client, reportId, { intervalMs = 30000, maxWaitMs = 600000 } = {}) {
  const startedAt = Date.now();
  while (true) {
    const data = await request(client, 'GET', `/reports/2021-06-30/reports/${reportId}`);
    const status = data.processingStatus;
    console.log(`Report ${reportId} status: ${status}`);

    if (status === 'DONE') return data.reportDocumentId;
    if (status === 'CANCELLED' || status === 'FATAL') {
      throw new Error(`Report ${reportId} ended with status ${status}: ${JSON.stringify(data)}`);
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(`Report ${reportId} did not complete within ${maxWaitMs}ms (last status: ${status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function downloadReport(client, reportDocumentId) {
  const meta = await request(client, 'GET', `/reports/2021-06-30/documents/${reportDocumentId}`);

  const res = await fetch(meta.url);
  if (!res.ok) {
    throw new Error(`Report document download failed (${res.status}) for ${reportDocumentId}`);
  }

  let bytes = Buffer.from(await res.arrayBuffer());
  if (meta.compressionAlgorithm === 'GZIP') {
    const { gunzipSync } = await import('node:zlib');
    bytes = gunzipSync(bytes);
  }

  const text = bytes.toString('utf-8');
  const trimmed = text.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(text);
  }

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const fields = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = fields[i];
    });
    return row;
  });
}

/**
 * Stream a report document to disk without buffering the full payload in memory.
 * Use this instead of downloadReport for large reports (e.g. Brand Analytics) that
 * exceed Node's ~512MB string limit (ERR_STRING_TOO_LONG).
 *
 * @param {object} client - SP-API client from getClient()
 * @param {string} reportDocumentId - document ID returned by pollReport()
 * @param {string} outPath - absolute path where the decompressed file should be written
 * @returns {{ filePath: string, contentType: string, byteCount: number }}
 */
export async function streamReportToFile(client, reportDocumentId, outPath) {
  const meta = await request(client, 'GET', `/reports/2021-06-30/documents/${reportDocumentId}`);

  const res = await fetch(meta.url);
  if (!res.ok) {
    throw new Error(`Report document download failed (${res.status}) for ${reportDocumentId}`);
  }

  // Convert WHATWG ReadableStream to Node Readable
  const nodeStream = Readable.fromWeb(res.body);

  if (meta.compressionAlgorithm === 'GZIP') {
    const { createGunzip } = await import('node:zlib');
    await pipeline(nodeStream, createGunzip(), createWriteStream(outPath));
  } else {
    await pipeline(nodeStream, createWriteStream(outPath));
  }

  const { size } = await stat(outPath);
  return {
    filePath: outPath,
    contentType: meta.contentType ?? 'unknown',
    byteCount: size,
  };
}
