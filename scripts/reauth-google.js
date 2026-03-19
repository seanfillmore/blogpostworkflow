#!/usr/bin/env node
/**
 * Google OAuth re-authorization — adds analytics.readonly scope
 *
 * Run this once to add GA4 access to the existing Google refresh token.
 * Updates GOOGLE_REFRESH_TOKEN in .env with a token that grants both:
 *   - webmasters.readonly  (Google Search Console)
 *   - analytics.readonly   (Google Analytics 4)
 *
 * Prerequisites: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET must be in .env
 *
 * Usage: node scripts/reauth-google.js
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

const PORT = 3458;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/adwords',
].join(' ');

function loadEnv() {
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

function saveToEnv(key, value) {
  let content = readFileSync(ENV_PATH, 'utf8');
  const regex = new RegExp(`^${key}=.*`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content);
}

const env = loadEnv();
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const authUrl =
  `https://accounts.google.com/o/oauth2/v2/auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent` +
  `&state=${state}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404); res.end('Not found'); return; }

  const params = Object.fromEntries(url.searchParams.entries());
  if (params.state !== state) {
    res.writeHead(400); res.end('State mismatch.');
    server.close(); process.exit(1);
  }
  if (params.error) {
    res.writeHead(400); res.end(`OAuth error: ${params.error}`);
    console.error('OAuth error:', params.error);
    server.close(); process.exit(1);
  }
  if (!params.code) {
    res.writeHead(400); res.end('No authorization code returned.');
    server.close(); process.exit(1);
  }

  console.log('\nExchanging code for tokens...');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: params.code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${text}`);
    }
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      throw new Error('No refresh_token returned. Try revoking access at myaccount.google.com/permissions and re-running.');
    }
    saveToEnv('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Success!</h2><p>GSC + GA4 + Google Ads authorized. You can close this tab.</p>');
    console.log('✓ Refresh token saved to .env (grants webmasters.readonly + analytics.readonly + adwords)');
    console.log('\nTest GA4: node -e "import(\'./lib/ga4.js\').then(m => m.fetchGA4Snapshot(\'2026-03-18\')).then(r => console.log(JSON.stringify(r, null, 2)))"');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500); res.end(`Error: ${err.message}`);
    console.error('Error:', err.message);
    server.close(); process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nGoogle OAuth — opening browser for GSC + GA4 authorization...\n');
  console.log('Scopes:', SCOPES);
  console.log('Callback:', REDIRECT_URI, '\n');
  try { execSync(`open "${authUrl}"`); }
  catch { console.log('Could not open browser. Visit this URL manually:\n\n' + authUrl); }
  console.log('\nWaiting for Google callback...');
});
