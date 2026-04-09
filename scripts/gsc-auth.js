#!/usr/bin/env node
/**
 * Google Search Console OAuth 2.0 — one-time setup
 *
 * Opens your browser to the Google OAuth consent screen, exchanges
 * the code for tokens, and saves the refresh token to .env.
 *
 * Prerequisites:
 *   1. Create a project in Google Cloud Console
 *   2. Enable "Google Search Console API"
 *   3. Create OAuth 2.0 credentials (Desktop app type)
 *   4. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env
 *   5. Add GSC_SITE_URL to .env (e.g. sc-domain:realskincare.com)
 *
 * Usage: node scripts/gsc-auth.js
 *
 * Writes GOOGLE_REFRESH_TOKEN to .env on success.
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
  'https://www.googleapis.com/auth/webmasters',        // read+write — sitemaps resubmission, URL inspection
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/indexing',          // Indexing API — URL_UPDATED / URL_DELETED submissions
].join(' ');

// ── env helpers ───────────────────────────────────────────────────────────────

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

// ── main ──────────────────────────────────────────────────────────────────────

const env = loadEnv();
const CLIENT_ID = env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
const SITE_URL = env.GSC_SITE_URL;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  console.error('');
  console.error('Steps:');
  console.error('  1. Go to https://console.cloud.google.com/');
  console.error('  2. Create/select a project → APIs & Services → Enable APIs');
  console.error('  3. Search for "Google Search Console API" and enable it');
  console.error('  4. Go to Credentials → Create Credentials → OAuth 2.0 Client ID');
  console.error('  5. Application type: Desktop app');
  console.error('  6. Copy Client ID and Client Secret into .env');
  process.exit(1);
}

if (!SITE_URL) {
  console.error('Missing GSC_SITE_URL in .env');
  console.error('  Domain property format:     sc-domain:realskincare.com');
  console.error('  URL prefix property format: https://www.realskincare.com/');
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
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const params = Object.fromEntries(url.searchParams.entries());

  if (params.state !== state) {
    res.writeHead(400);
    res.end('State mismatch — possible CSRF. Aborting.');
    server.close();
    process.exit(1);
  }

  if (params.error) {
    res.writeHead(400);
    res.end(`OAuth error: ${params.error}`);
    console.error('OAuth error:', params.error);
    server.close();
    process.exit(1);
  }

  const { code } = params;
  if (!code) {
    res.writeHead(400);
    res.end('No authorization code returned.');
    server.close();
    process.exit(1);
  }

  console.log('\nExchanging code for tokens...');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
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
    res.end('<h2>Success!</h2><p>Google Search Console connected. You can close this tab.</p>');

    console.log('✓ Refresh token saved to .env as GOOGLE_REFRESH_TOKEN');
    console.log(`  Site: ${SITE_URL}`);
    console.log('\nRun a test: node -e "import(\'./lib/gsc.js\').then(m => m.getTopKeywords(10)).then(r => console.log(r.slice(0,5)))"');
    server.close();
    process.exit(0);
  } catch (err) {
    res.writeHead(500);
    res.end(`Error: ${err.message}`);
    console.error('Error:', err.message);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log('\nGoogle Search Console OAuth — opening browser...\n');
  console.log(`Site URL: ${SITE_URL}`);
  console.log(`Scopes:   ${SCOPES}`);
  console.log(`Callback: ${REDIRECT_URI}\n`);

  try {
    execSync(`open "${authUrl}"`);
  } catch {
    console.log('Could not open browser. Visit this URL manually:\n');
    console.log(authUrl);
  }

  console.log('Waiting for Google callback...');
});
