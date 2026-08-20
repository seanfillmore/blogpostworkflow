// agents/dashboard/routes/meta-ads.js
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvAuth } from '../lib/env.js';

const FB_API_VERSION = 'v21.0';

// The permissions this integration needs, in ONE place. It was declared inside the /auth
// handler and referenced from the /callback handler, which is a different closure — so the
// callback threw "scope is not defined" AFTER writeToken had already saved a perfectly good
// token, and rendered "Token exchange failed" over a grant that had in fact succeeded.
//
// ads_read alone cannot create an ad: every ad creative requires object_story_spec.page_id.
// pages_show_list finds the Page, pages_read_engagement publishes a creative as it, and
// business_management covers a Page owned by a Business rather than by the user directly.
const REQUIRED_SCOPES = [
  'ads_management', 'ads_read', 'pages_show_list', 'pages_read_engagement', 'business_management',
];

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
      // ads_read alone is enough to REPORT on ads and nothing else. The stored token
      // happens to carry ads_management from an earlier grant, which hid the gap until
      // 2026-08-19: campaign and ad set edits worked, and creating an AD did not, because
      // every Meta ad creative requires `object_story_spec.page_id` and this token could
      // not see a single Page — `me/accounts` returned zero and the ad account's
      // `promote_pages` came back empty.
      //
      // pages_show_list finds the Page, pages_read_engagement lets a creative be published
      // as it, business_management covers a Page owned by a Business rather than by the
      // user directly (which is how this one is set up). ads_management is named
      // explicitly rather than relied on: a re-auth that requested only ads_read would
      // narrow the token that is currently working.
      const scope = REQUIRED_SCOPES.join(',');
      // auth_type=rerequest is NOT optional here. Facebook skips the consent dialog for an
      // app that already holds an active grant and hands back a token carrying the OLD
      // scopes — silently, with no error and no visible difference: the dashboard says
      // "Connected as Sean Fillmore", the ad account list populates, and debug_token still
      // reports the previous scope set. That is exactly what happened on 2026-08-19 after
      // the scope list was widened for Pages; the reconnect looked successful and granted
      // nothing, so ad creation stayed impossible for the same reason as before.
      //
      // rerequest forces the dialog to reappear and ask for the permissions that are in
      // `scope` but not yet granted. It is harmless when there is nothing new to ask for.
      const authUrl = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?`
        + `client_id=${encodeURIComponent(clientId)}`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}`
        + `&scope=${encodeURIComponent(scope)}`
        + `&auth_type=rerequest`
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

        // REPORT WHAT WAS ACTUALLY GRANTED, not what was asked for. A grant that silently
        // returns the previous, narrower scope set is indistinguishable from a successful
        // one at this point — same 200, same token, same working ad account list — and the
        // page said "connected" either way. That cost a full round trip on 2026-08-19:
        // the reconnect was performed, the dashboard confirmed it, and nothing had changed.
        let granted = [];
        try {
          const dbg = await fbGet('debug_token', `${env.FACEBOOK_APP_ID}|${env.FACEBOOK_APP_SECRET}`, { input_token: finalToken });
          granted = dbg?.data?.scopes || [];
        } catch { /* the token is saved and usable; this check is diagnostic only */ }
        const requested = REQUIRED_SCOPES;
        const missing = requested.filter(s => !granted.includes(s));
        const esc = (t) => String(t).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<h2>Meta Ads connected</h2>
          <p>Access token saved.</p>
          <p><strong>Granted:</strong> ${granted.length ? esc(granted.join(', ')) : '(could not read)'}</p>
          ${missing.length ? `<p style="color:#b00"><strong>NOT granted:</strong> ${esc(missing.join(', '))}<br>
            Ad creation needs the Pages permissions — every ad creative requires a Page id.
            Re-run Connect and approve the Pages step, or grant the app a role that allows it.</p>`
            : '<p style="color:#080">All requested permissions granted — ads can be created.</p>'}
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
