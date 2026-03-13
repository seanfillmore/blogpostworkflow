/**
 * Shopify OAuth — one-time access token setup
 *
 * Starts a local server, opens your browser to the Shopify OAuth screen,
 * exchanges the returned code for an access token, and saves it to .env.
 *
 * Usage: node scripts/shopify-auth.js
 *
 * Required scopes granted: read_content, write_content
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { createHmac, randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ENV_PATH = join(ROOT, '.env');

// ── config ────────────────────────────────────────────────────────────────────

const PORT = 3457;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = 'read_content,write_content';

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

function saveAccessToken(token) {
  let content = readFileSync(ENV_PATH, 'utf8');
  if (content.includes('SHOPIFY_SECRET=')) {
    content = content.replace(/^SHOPIFY_SECRET=.*/m, `SHOPIFY_SECRET=${token}`);
  } else {
    content += `\nSHOPIFY_SECRET=${token}`;
  }
  writeFileSync(ENV_PATH, content);
}

function verifyHmac(query, secret) {
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = createHmac('sha256', secret).update(message).digest('hex');
  return digest === hmac;
}

// ── main ──────────────────────────────────────────────────────────────────────

const env = loadEnv();
const CLIENT_ID = env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = env.SHOPIFY_SECRET;
const STORE = env.SHOPIFY_STORE;

if (!CLIENT_ID || !CLIENT_SECRET || !STORE) {
  console.error('Missing SHOPIFY_CLIENT_ID, SHOPIFY_SECRET, or SHOPIFY_STORE in .env');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');

const authUrl =
  `https://${STORE}/admin/oauth/authorize` +
  `?client_id=${CLIENT_ID}` +
  `&scope=${SCOPES}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&state=${state}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const params = Object.fromEntries(url.searchParams.entries());

  // Validate state to prevent CSRF
  if (params.state !== state) {
    res.writeHead(400);
    res.end('State mismatch — possible CSRF attack. Aborting.');
    server.close();
    process.exit(1);
  }

  // Validate HMAC signature from Shopify
  if (!verifyHmac(params, CLIENT_SECRET)) {
    res.writeHead(400);
    res.end('HMAC validation failed. Aborting.');
    server.close();
    process.exit(1);
  }

  const { code } = params;
  if (!code) {
    res.writeHead(400);
    res.end('No code returned from Shopify.');
    server.close();
    process.exit(1);
  }

  // Exchange code for access token
  console.log('\nExchanging code for access token...');
  try {
    const tokenRes = await fetch(`https://${STORE}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      throw new Error(`Token exchange failed: HTTP ${tokenRes.status} — ${text}`);
    }

    const { access_token } = await tokenRes.json();

    saveAccessToken(access_token);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Success!</h2><p>Access token saved to .env. You can close this tab.</p>');

    console.log('Access token saved to .env as SHOPIFY_SECRET.');
    console.log('\nYou can now run your agents.');
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
  console.log(`\nShopify OAuth — opening browser...\n`);
  console.log(`Store:        ${STORE}`);
  console.log(`Scopes:       ${SCOPES}`);
  console.log(`Redirect URI: ${REDIRECT_URI}\n`);

  // Open browser
  try {
    execSync(`open "${authUrl}"`);
  } catch {
    console.log('Could not open browser automatically. Visit this URL manually:\n');
    console.log(authUrl);
  }

  console.log('Waiting for Shopify callback...');
});
