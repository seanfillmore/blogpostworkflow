/**
 * Creators' Instagram handles: where they come from, how a reply is read for
 * one, and the one lookup every consumer uses.
 *
 * Sean, 2026-10-16: "We need to continue that process and reach out to get
 * their social media so we can tag them." The Trybe API carries NO social
 * fields (checked 2026-10-07: /creators/{id}, submissions and openapi.json), so
 * a handle can only come from the creator. Two sources, merged:
 *
 *   1. data/creator-outreach/socials.json: written by agents/creator-outreach
 *      when a creator replies to the "socials" email with their handle.
 *      Server-owned, gitignored, in the offsite backup with the outreach state.
 *   2. config/homepage.json `ugc.videos[].social_url`: the handles collected for
 *      the homepage on 2026-10-07, keyed there by Trybe SUBMISSION id and joined
 *      to the creator through the submissions list.
 *
 * Keyed by normName(creator name), the same join creator-outreach already uses
 * between Shopify sample orders and Trybe submissions.
 *
 * READING A REPLY. A full instagram.com/<handle> URL is accepted anywhere. A
 * bare "@handle" is accepted only when the message says Instagram (IG, insta)
 * or answers our own email that asked for the Instagram handle; otherwise it
 * could be TikTok, and a wrong tag is worse than no tag (memory
 * feedback_publish_creator_social_links: never guess an account).
 */

import { normName } from './trybe-samples.js';

export const OUR_HANDLE = 'realskincare_com';

/** A creator saying no to being tagged. Recorded; they are never asked again. */
export const DECLINE_TAG_PATTERN = /\b(rather|prefer) (you )?(not|didn'?t) (be )?tag\w*|\b(don'?t|do not) tag me\b|\bno tagging\b|\bkeep me anonymous\b|\bnot comfortable (being )?tagged\b/i;

const HANDLE = '[A-Za-z0-9._]{1,30}';
const NOT_PROFILES = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'tv', 'direct']);

function cleanHandle(h) {
  const v = String(h || '').replace(/^@/, '').replace(/[.]+$/, '').toLowerCase();
  if (!new RegExp(`^${HANDLE}$`).test(v)) return null;
  if (NOT_PROFILES.has(v) || v === OUR_HANDLE) return null;
  return v;
}

/** The Instagram handle in a creator's message, or null. */
export function extractInstagramHandle(text, { askedForInstagram = false } = {}) {
  const t = String(text || '');
  for (const m of t.matchAll(new RegExp(`instagram\\.com/(${HANDLE})`, 'gi'))) {
    const h = cleanHandle(m[1]);
    if (h) return h;
  }
  const saysInstagram = /\b(instagram|insta|ig)\b/i.test(t);
  if (!saysInstagram && !askedForInstagram) return null;
  for (const m of t.matchAll(new RegExp(`(?:^|[\\s(:,])@(${HANDLE})`, 'g'))) {
    const h = cleanHandle(m[1]);
    if (h) return h;
  }
  return null;
}

function handleFromUrl(url) {
  const m = String(url || '').match(new RegExp(`instagram\\.com/(${HANDLE})`, 'i'));
  return m ? cleanHandle(m[1]) : null;
}

/**
 * name key → { handle, source } from the registry plus the homepage.
 * The registry wins: it is the creator's own latest answer.
 */
export function mergeSocials({ registry = {}, homepage = {}, submissions = [] } = {}) {
  const out = {};
  const byId = new Map((submissions || []).map((s) => [s.id, s]));
  for (const v of homepage?.ugc?.videos || []) {
    const handle = handleFromUrl(v.social_url);
    const s = byId.get(v.trybe_id);
    if (!handle || !s?.creator?.name) continue;
    out[normName(s.creator.name)] = { handle, source: 'homepage' };
  }
  for (const [key, r] of Object.entries(registry?.creators || {})) {
    if (r?.declined) out[key] = { handle: null, declined: true, source: r.source || 'reply' };
    else if (r?.instagram) out[key] = { handle: r.instagram, source: r.source || 'reply' };
  }
  return out;
}

export function handleFor(socials, creatorName) {
  return socials?.[normName(creatorName)]?.handle || null;
}

/** True when the creator asked not to be tagged. */
export function declinedTag(socials, creatorName) {
  return Boolean(socials?.[normName(creatorName)]?.declined);
}

export function recordDecline(registry, { name, email, at }) {
  registry.creators ||= {};
  registry.creators[normName(name)] = { name, email: email || null, instagram: null, declined: true, source: 'reply', at };
  return registry;
}

/** Record a handle in the registry object (mutates and returns it). */
export function recordHandle(registry, { name, email, handle, at, source = 'reply' }) {
  registry.creators ||= {};
  registry.creators[normName(name)] = { name, email: email || null, instagram: handle, source, at };
  return registry;
}

export { normName };
