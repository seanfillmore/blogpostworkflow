// agents/dashboard/routes/meta-ads.js
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvAuth } from '../lib/env.js';

const FB_API_VERSION = 'v21.0';

function writeToken(rootDir, token) {
  const envPath = join(rootDir, '.env');
  let content = readFileSync(envPath, 'utf8');
  const regex = /^FACEBOOK_ACCESS_TOKEN=.*/m;
  if (regex.test(content)) {
    content = content.replace(regex, `FACEBOOK_ACCESS_TOKEN=${token}`);
  } else {
    content = content.trimEnd() + `\nFACEBOOK_ACCESS_TOKEN=${token}\n`;
  }
  writeFileSync(envPath, content);
  process.env.FACEBOOK_ACCESS_TOKEN = token;
}

async function fbGet(path, token, params = {}) {
  const url = new URL(`https://graph.facebook.com/${FB_API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token);
  const r = await fetch(url.toString());
  const body = await r.json();
  if (!r.ok) {
    const msg = body?.error?.message || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

function jsonRes(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export default [
  // Existing: competitor ads from local snapshot (Meta Ads Library)
  {
    method: 'GET',
    match: '/api/meta-ads-insights',
    handler(req, res, ctx) {
      if (!existsSync(ctx.META_ADS_INSIGHTS_DIR)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
      const files = readdirSync(ctx.META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
      if (!files.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
      try {
        const data = readFileSync(join(ctx.META_ADS_INSIGHTS_DIR, files[0]), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch { res.writeHead(500); res.end('{}'); }
    },
  },

  // Kick off OAuth — redirect to Facebook consent screen
  {
    method: 'GET',
    match: '/api/meta-ads/auth',
    handler(req, res, _ctx) {
      const env = loadEnvAuth();
      const clientId = env.FACEBOOK_APP_ID;
      if (!clientId) { res.writeHead(500); res.end('FACEBOOK_APP_ID not set in .env'); return; }
      const host = req.headers.host || 'localhost:4242';
      const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
      const redirectUri = `${proto}://${host}/api/meta-ads/callback`;
      const scope = 'ads_read';
      const authUrl = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?`
        + `client_id=${encodeURIComponent(clientId)}`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}`
        + `&scope=${encodeURIComponent(scope)}`
        + `&response_type=code`;
      res.writeHead(302, { Location: authUrl });
      res.end();
    },
  },

  // OAuth callback — exchange code → short-lived → long-lived token, save to .env
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/meta-ads/callback'),
    async handler(req, res, ctx) {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const code = urlObj.searchParams.get('code');
      const error = urlObj.searchParams.get('error');
      if (error) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(`<h2>OAuth Error</h2><p>${error}</p><p><a href="/">Back to dashboard</a></p>`); return; }
      if (!code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end('<h2>No authorization code</h2><p><a href="/">Back to dashboard</a></p>'); return; }

      const env = loadEnvAuth();
      const host = req.headers.host || 'localhost:4242';
      const proto = req.headers['x-forwarded-proto'] || (host.startsWith('localhost') ? 'http' : 'https');
      const redirectUri = `${proto}://${host}/api/meta-ads/callback`;
      try {
        // Step 1: authorization code → short-lived user access token
        const shortUrl = new URL(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`);
        shortUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID);
        shortUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET);
        shortUrl.searchParams.set('redirect_uri', redirectUri);
        shortUrl.searchParams.set('code', code);
        const shortRes = await fetch(shortUrl.toString());
        const shortBody = await shortRes.json();
        if (!shortRes.ok || !shortBody.access_token) {
          throw new Error(shortBody?.error?.message || 'Short-lived token exchange failed');
        }

        // Step 2: short-lived → long-lived token (~60 days)
        const longUrl = new URL(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`);
        longUrl.searchParams.set('grant_type', 'fb_exchange_token');
        longUrl.searchParams.set('client_id', env.FACEBOOK_APP_ID);
        longUrl.searchParams.set('client_secret', env.FACEBOOK_APP_SECRET);
        longUrl.searchParams.set('fb_exchange_token', shortBody.access_token);
        const longRes = await fetch(longUrl.toString());
        const longBody = await longRes.json();
        const finalToken = longBody.access_token || shortBody.access_token;

        writeToken(ctx.ROOT, finalToken);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Meta Ads connected</h2>
          <p>Access token saved. The dashboard can now read your ad account data.</p>
          <p><a href="/#tab=my-meta-ads">Back to dashboard</a></p>`);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre><p><a href="/">Back to dashboard</a></p>`);
      }
    },
  },

  // Connection status
  {
    method: 'GET',
    match: '/api/meta-ads/status',
    async handler(req, res, _ctx) {
      const env = loadEnvAuth();
      if (!env.FACEBOOK_ACCESS_TOKEN) { jsonRes(res, 200, { connected: false }); return; }
      try {
        const me = await fbGet('me', env.FACEBOOK_ACCESS_TOKEN, { fields: 'id,name' });
        jsonRes(res, 200, { connected: true, user: me });
      } catch (err) {
        jsonRes(res, 200, { connected: false, error: err.message });
      }
    },
  },

  // List ad accounts the connected user can read
  {
    method: 'GET',
    match: '/api/meta-ads/accounts',
    async handler(req, res, _ctx) {
      const env = loadEnvAuth();
      if (!env.FACEBOOK_ACCESS_TOKEN) { jsonRes(res, 401, { error: 'Not connected' }); return; }
      try {
        const body = await fbGet('me/adaccounts', env.FACEBOOK_ACCESS_TOKEN, {
          fields: 'name,account_id,account_status,currency,amount_spent',
          limit: '50',
        });
        jsonRes(res, 200, body);
      } catch (err) {
        jsonRes(res, 500, { error: err.message });
      }
    },
  },

  // Insights for one ad account (spend, impressions, clicks, ctr, cpm)
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/meta-ads/account-insights'),
    async handler(req, res, _ctx) {
      const env = loadEnvAuth();
      if (!env.FACEBOOK_ACCESS_TOKEN) { jsonRes(res, 401, { error: 'Not connected' }); return; }
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const accountId = urlObj.searchParams.get('account_id');
      const datePreset = urlObj.searchParams.get('date_preset') || 'last_30d';
      if (!accountId) { jsonRes(res, 400, { error: 'account_id required' }); return; }
      const cleanId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
      try {
        const body = await fbGet(`${cleanId}/insights`, env.FACEBOOK_ACCESS_TOKEN, {
          fields: 'spend,impressions,clicks,ctr,cpm,reach',
          date_preset: datePreset,
          level: 'account',
        });
        jsonRes(res, 200, body);
      } catch (err) {
        jsonRes(res, 500, { error: err.message });
      }
    },
  },

  // Disconnect — clear the stored token
  {
    method: 'POST',
    match: '/api/meta-ads/disconnect',
    handler(req, res, ctx) {
      try {
        writeToken(ctx.ROOT, '');
        jsonRes(res, 200, { ok: true });
      } catch (err) {
        jsonRes(res, 500, { error: err.message });
      }
    },
  },
];
