#!/usr/bin/env node
/**
 * One-shot Amazon Ads API authorization: mint a refresh token, then verify it.
 *
 * The browser step is irreducibly human — a person has to log in as the Amazon account
 * that owns the advertising account and click Allow. Everything either side of that click
 * is automated here.
 *
 *   node scripts/amazon-ads-authorize.mjs --url
 *       Print the authorize URL to open. Reads AMAZON_ADS_LWA_CLIENT_ID from .env.
 *
 *   node scripts/amazon-ads-authorize.mjs --redirect-url '<the URL you landed on>'
 *       Exchange the authorization code for a refresh token. Paste the WHOLE address-bar
 *       URL; the code is pulled out of it. --code '<code>' also works if you would rather
 *       copy just the parameter.
 *       Add --write-env to store the refresh token and the resolved profile id in .env.
 *
 *   node scripts/amazon-ads-authorize.mjs --verify
 *       Call the live API with whatever is in .env and print the profiles it can see.
 *
 * WHY THE REDIRECT URL IS A PAGE THAT DOES NOTHING. An LWA "Allowed Return URL" must be
 * HTTPS — http://localhost is rejected — so the usual local callback listener is not
 * available without a public endpoint and a certificate. Amazon's own documented answer is
 * to redirect to any HTTPS page you control and read the code out of the address bar, which
 * is what this script expects. https://www.realskincare.com/ is used because it answers 200
 * with no redirect hop, so the query string survives intact (amazon.com 301s first).
 *
 * THE AUTHORIZATION CODE IS SINGLE-USE AND SHORT-LIVED (~5 minutes). If the exchange fails
 * with invalid_grant, the code was already spent or has expired — go back to --url and get
 * a fresh one. That is the expected failure, not a sign the setup is wrong.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import {
  ADS_SCOPE,
  ADS_AUTHORIZE_URL,
  getClient,
  listProfiles,
} from '../lib/amazon/ads-api-client.js';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const DEFAULT_REDIRECT_URI = 'https://www.realskincare.com/';
const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env');

function parseArgs(argv) {
  const args = { mode: null, code: null, redirectUri: DEFAULT_REDIRECT_URI, writeEnv: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.mode = 'url';
    else if (a === '--verify') args.mode = 'verify';
    else if (a === '--write-env') args.writeEnv = true;
    else if (a === '--code') { args.mode = 'exchange'; args.code = argv[++i]; }
    else if (a === '--redirect-url') { args.mode = 'exchange'; args.code = codeFromUrl(argv[++i]); }
    else if (a === '--redirect-uri') args.redirectUri = argv[++i];
  }
  return args;
}

/**
 * Pull `code` out of a pasted address-bar URL.
 *
 * Deliberately strict about the failure case: a URL carrying `error=` is Amazon telling us
 * why the grant was refused, and surfacing that beats "no code found". `invalid_scope` in
 * particular means the LWA client is not approved for the scope — an onboarding problem,
 * not a typo — so it is named rather than left for the operator to look up.
 */
export function codeFromUrl(raw) {
  if (!raw) throw new Error('--redirect-url needs the URL you were sent to.');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }

  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') || '';
    const hint = error === 'invalid_scope'
      ? ' — the LWA client is not approved for this scope, or the scope was spelled with a ' +
        'single colon. Check that API access is assigned to this security profile.'
      : '';
    throw new Error(`Amazon refused the grant: ${error}${description ? ` (${description})` : ''}${hint}`);
  }

  const code = url.searchParams.get('code');
  if (!code) {
    throw new Error(
      `No "code" parameter in that URL. Paste the address bar exactly as it was after ` +
      `clicking Allow — it looks like ${DEFAULT_REDIRECT_URI}?code=ANxxxx...&scope=...`
    );
  }
  return code;
}

export function buildAuthorizeUrl({ clientId, redirectUri, scope = ADS_SCOPE, state = null }) {
  const url = new URL(ADS_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', scope);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    let hint = '';
    if (text.includes('invalid_grant')) {
      hint = '\n  → The code was already used or has expired (they last ~5 minutes). ' +
             'Re-run with --url and authorize again.';
    } else if (text.includes('redirect_uri')) {
      hint = `\n  → redirect_uri must match an Allowed Return URL on the security profile ` +
             `EXACTLY, including the trailing slash. This run used: ${redirectUri}`;
    }
    throw new Error(`Authorization-code exchange failed (${res.status}): ${text}${hint}`);
  }

  const data = JSON.parse(text);
  if (!data.refresh_token) {
    throw new Error(
      `Exchange succeeded but returned no refresh_token. A refresh token is only issued ` +
      `when client_secret is supplied — check AMAZON_ADS_LWA_CLIENT_SECRET is set.`
    );
  }
  return data;
}

/**
 * Upsert keys in .env, preserving everything else byte for byte.
 *
 * Read-modify-write rather than append, because a second run appending a duplicate
 * AMAZON_ADS_REFRESH_TOKEN would leave two values for one key and dotenv takes the FIRST —
 * so the stale one would silently win. Writes through the symlink a worktree uses for .env.
 */
export function upsertEnv(contents, updates) {
  let out = contents;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(out)) {
      out = out.replace(pattern, line);
    } else {
      if (out.length && !out.endsWith('\n')) out += '\n';
      out += `${line}\n`;
    }
  }
  return out;
}

function writeEnvUpdates(updates) {
  const before = readFileSync(ENV_PATH, 'utf8');
  const after = upsertEnv(before, updates);
  writeFileSync(ENV_PATH, after);
  return Object.keys(updates);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set in .env. Copy it from the Amazon Ads console app page.`);
  }
  return v;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.mode) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(64);
  }

  if (args.mode === 'url') {
    const clientId = requireEnv('AMAZON_ADS_LWA_CLIENT_ID');
    console.log('\nOpen this URL while logged in ONLY as the Amazon account that owns the');
    console.log('advertising account (log out of personal shopping accounts first):\n');
    console.log(buildAuthorizeUrl({ clientId, redirectUri: args.redirectUri }));
    console.log(`\nAllowed Return URL on the security profile must be exactly: ${args.redirectUri}`);
    console.log('\nAfter clicking Allow you land on a normal page. Copy the WHOLE address bar and run:');
    console.log("  node scripts/amazon-ads-authorize.mjs --redirect-url '<paste>' --write-env\n");
    return;
  }

  if (args.mode === 'exchange') {
    const clientId = requireEnv('AMAZON_ADS_LWA_CLIENT_ID');
    const clientSecret = requireEnv('AMAZON_ADS_LWA_CLIENT_SECRET');

    const token = await exchangeCode({
      code: args.code,
      clientId,
      clientSecret,
      redirectUri: args.redirectUri,
    });
    console.log(`✓ Refresh token obtained (access token valid ${token.expires_in}s).`);

    // Resolve the profile id in the same run: the token is useless without one, and
    // discovering it here means .env is complete after a single command.
    process.env.AMAZON_ADS_REFRESH_TOKEN = token.refresh_token;
    const client = getClient();
    const profiles = await listProfiles(client);
    printProfiles(profiles);

    const usSeller = profiles.find((p) => p.countryCode === 'US' && p.accountInfo?.type === 'seller');

    if (args.writeEnv) {
      const updates = { AMAZON_ADS_REFRESH_TOKEN: token.refresh_token };
      if (usSeller) updates.AMAZON_ADS_PROFILE_ID = String(usSeller.profileId);
      const keys = writeEnvUpdates(updates);
      console.log(`\n✓ Wrote to .env: ${keys.join(', ')}`);
      if (!usSeller) {
        console.log('⚠ No US seller profile found — AMAZON_ADS_PROFILE_ID not set. See the list above.');
      }
    } else {
      console.log('\nRe-run with --write-env to store these in .env (the token is not printed here).');
    }
    return;
  }

  if (args.mode === 'verify') {
    const client = getClient();
    const profiles = await listProfiles(client);
    printProfiles(profiles);
    console.log(
      client.profileId
        ? `\n✓ AMAZON_ADS_PROFILE_ID is set to ${client.profileId}`
        : '\n⚠ AMAZON_ADS_PROFILE_ID is not set — scoped calls will refuse to run.'
    );
    if (client.rotatedRefreshToken) {
      console.log('⚠ Amazon returned a NEW refresh token. Re-run with --write-env to persist it.');
    }
  }
}

function printProfiles(profiles) {
  console.log(`\nProfiles visible to these credentials (${profiles.length}):`);
  for (const p of profiles) {
    const info = p.accountInfo ?? {};
    console.log(
      `  ${p.profileId}  ${p.countryCode}  ${info.type ?? '?'}  ` +
      `${info.name ?? ''}${info.id ? ` (${info.id})` : ''}  ${p.currencyCode ?? ''}`
    );
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message}\n`);
    process.exit(1);
  });
}
