// agents/dashboard/routes/google.js
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvAuth } from '../lib/env.js';

export default [
  {
    method: 'GET',
    match: '/api/google/auth',
    handler(req, res, ctx) {
      const env = loadEnvAuth();
      const clientId = env.GOOGLE_CLIENT_ID;
      if (!clientId) { res.writeHead(500); res.end('GOOGLE_CLIENT_ID not set in .env'); return; }
      const host = req.headers.host || `localhost:4242`;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const redirectUri = `${proto}://${host}/api/google/callback`;
      const scopes = [
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
        'https://www.googleapis.com/auth/adwords',
      ].join(' ');
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;
      res.writeHead(302, { Location: authUrl });
      res.end();
    },
  },
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/google/callback'),
    handler(req, res, ctx) {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const code = urlObj.searchParams.get('code');
      const error = urlObj.searchParams.get('error');
      if (error) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(`<h2>OAuth Error</h2><p>${error}</p><p><a href="/">Back to dashboard</a></p>`); return; }
      if (!code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end('<h2>No authorization code</h2><p><a href="/">Back to dashboard</a></p>'); return; }

      const env = loadEnvAuth();
      const host = req.headers.host || `localhost:4242`;
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const redirectUri = `${proto}://${host}/api/google/callback`;
      fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      }).then(function(tokenRes) {
        if (!tokenRes.ok) return tokenRes.text().then(function(text) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end('<h2>Token exchange failed</h2><pre>' + text + '</pre><p><a href="/">Back to dashboard</a></p>');
        });
        return tokenRes.json().then(function(tokens) {
          if (!tokens.refresh_token) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<h2>No refresh token returned</h2><p>Try revoking access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and retry.</p><p><a href="/">Back to dashboard</a></p>');
            return;
          }
          var envPath = join(ctx.ROOT, '.env');
          var content = readFileSync(envPath, 'utf8');
          var regex = /^GOOGLE_REFRESH_TOKEN=.*/m;
          if (regex.test(content)) {
            content = content.replace(regex, 'GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
          } else {
            content = content.trimEnd() + '\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n';
          }
          writeFileSync(envPath, content);
          process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h2>Google token renewed successfully</h2><p>GSC + GA4 + Google Ads re-authorized.</p><p><a href="/">Back to dashboard</a></p>');
        });
      }).catch(function(err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h2>Error</h2><pre>' + err.message + '</pre><p><a href="/">Back to dashboard</a></p>');
      });
    },
  },
  {
    method: 'GET',
    match: '/api/google/status',
    handler(req, res, ctx) {
      var env2 = loadEnvAuth();
      if (!env2.GOOGLE_REFRESH_TOKEN) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'missing', message: 'No refresh token configured' }));
        return;
      }
      fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env2.GOOGLE_CLIENT_ID,
          client_secret: env2.GOOGLE_CLIENT_SECRET,
          refresh_token: env2.GOOGLE_REFRESH_TOKEN,
          grant_type: 'refresh_token',
        }),
      }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.access_token) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'valid' }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'expired', message: data.error_description || 'Token expired or revoked' }));
        }
      }).catch(function(err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      });
    },
  },
];
