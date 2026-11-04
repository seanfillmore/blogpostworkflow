/**
 * Meta webhook for Instagram messages: GET /api/meta/webhook (verification) and
 * POST /api/meta/webhook (deliveries).
 *
 * Why it exists (2026-11-04): agents/instagram-dm could READ the inbox but every
 * reply was refused with "(#10) This message is sent outside of allowed window"
 * (subcode 2534022) seconds after the customer wrote. Meta only lets an app answer
 * Instagram messages when the app is subscribed to the Instagram `messages`
 * webhook with a verified callback, and it had none. This endpoint is that
 * callback. It does nothing with a delivery beyond checking its signature and
 * answering 200: replies are still sent by the agent's 10-minute poll, which
 * already handles the keyword, the code pool and the 24 h window.
 *
 * PUBLIC (Meta cannot send dashboard basic-auth), so it is bounded: GET answers
 * only the exact verify token (META_WEBHOOK_VERIFY_TOKEN in .env); POST bodies are
 * capped at 64 KB and must carry a valid X-Hub-Signature-256 (HMAC-SHA256 of the
 * raw body with FACEBOOK_APP_SECRET), else 403. Nothing is written to disk.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readRawBody } from '../lib/responses.js';

export const WEBHOOK_PATH = '/api/meta/webhook';
const MAX_BODY_BYTES = 64 * 1024;

export function validSignature(raw, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function verifyChallenge(query, token) {
  if (!token) return null;
  if (query.get('hub.mode') !== 'subscribe' || query.get('hub.verify_token') !== token) return null;
  const c = query.get('hub.challenge');
  return c && /^[A-Za-z0-9_-]{1,128}$/.test(c) ? c : null;
}

const isPath = (url) => url.split('?')[0] === WEBHOOK_PATH;

export default [
  {
    method: 'GET',
    match: isPath,
    handler(req, res) {
      const q = new URL(req.url, 'http://x').searchParams;
      const c = verifyChallenge(q, process.env.META_WEBHOOK_VERIFY_TOKEN);
      res.writeHead(c ? 200 : 403, { 'Content-Type': 'text/plain' });
      res.end(c || 'forbidden');
    },
  },
  {
    method: 'POST',
    match: isPath,
    async handler(req, res) {
      let raw;
      try { raw = await readRawBody(req, { maxBytes: MAX_BODY_BYTES }); } catch {
        res.writeHead(413, { 'Content-Type': 'text/plain' }); res.end('too large'); return;
      }
      if (!validSignature(raw, req.headers['x-hub-signature-256'], process.env.FACEBOOK_APP_SECRET)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('bad signature'); return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    },
  },
];
