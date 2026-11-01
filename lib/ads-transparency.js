/**
 * Google Ads Transparency Center — pure helpers for competitor ad research.
 *
 * DataForSEO's `serp/google/ads_search` returns one row per creative:
 * advertiser, format (text | image | video), first_shown / last_shown, and a
 * preview. It carries NO headline or body text, so everything a human wants to
 * read has to be recovered from the preview, which comes in two shapes:
 *
 *   - `preview_image.url` on tpc.googlesyndication.com/archive/simgad/<n> — a
 *     plain PNG. Text (search) ads and some display banners arrive this way,
 *     and the PNG is a rendered screenshot of the whole ad, sitelinks included.
 *   - `preview_url`, a content.js script Google's own viewer evaluates. Not an
 *     image, but the media it would draw is inside it as escaped URLs:
 *       video    → i.ytimg.com/vi/<11-char id>/  (so a YouTube link + thumbnail)
 *       shopping → a `pla=` protobuf carrying the product photo, title, merchant
 *       other    → tpc.googlesyndication.com/simgad/<n> or gstatic tbn images
 *
 * Measured 2026-10-20 on piperwai.com, wellnesse.com, toupsandco.com and
 * nativecos.com. No I/O here so the parsing is testable without a network.
 *
 * WHAT THIS DATA CANNOT TELL YOU: spend, impressions, targeting or results.
 * Days running is the only performance proxy — the same one the Meta research
 * uses — and an ad still running after 200+ days is the signal worth modelling.
 */

const DAY_MS = 86_400_000;

/** DataForSEO stamps "2024-01-29 08:00:00 +00:00"; Date needs the T and no space. */
export function parseShownDate(value) {
  if (!value) return null;
  const iso = String(value).trim().replace(' ', 'T').replace(' ', '');
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * Whole days between first and last shown. Null when either end is unreadable,
 * never 0 — an unreadable date is not a one-day ad.
 */
export function daysRunning(firstShown, lastShown) {
  const a = parseShownDate(firstShown);
  const b = parseShownDate(lastShown);
  if (!a || !b) return null;
  return Math.max(0, Math.round((b - a) / DAY_MS));
}

/** Still live if Google saw it within `withinDays` of `now`. */
export function isRecentlyShown(lastShown, { now = new Date(), withinDays = 7 } = {}) {
  const b = parseShownDate(lastShown);
  if (!b) return false;
  return (now - b) <= withinDays * DAY_MS;
}

/**
 * Undo the escaping content.js wraps URLs in (`\x3d`, `\\u003d`, `\x26`, `\/`)
 * so ordinary URL regexes can see them.
 */
export function unescapePreviewJs(js) {
  return String(js || '')
    .replace(/\\+u003d/gi, '=')
    .replace(/\\+x3d/gi, '=')
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+x26/gi, '&')
    .replace(/\\+\//g, '/');
}

function readVarint(buf, i) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (i >= buf.length) return null;
    const c = buf[i++];
    value |= (c & 0x7f) << shift;
    if (!(c & 0x80)) return { value, next: i };
    shift += 7;
    if (shift > 28) return null;
  }
}

/**
 * Decode a Shopping ad's `pla=` payload: a flat protobuf of length-delimited
 * strings — 1 = product image, 2 = product title, 3 = merchant. Returns null
 * on anything it does not recognise rather than guessing.
 */
export function decodePla(b64) {
  if (!b64) return null;
  let buf;
  try {
    buf = Buffer.from(String(b64).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return null;
  }
  const fields = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i++];
    if ((tag & 7) !== 2) break;
    const len = readVarint(buf, i);
    if (!len || len.next + len.value > buf.length) break;
    fields[tag >> 3] = buf.slice(len.next, len.next + len.value).toString('utf8');
    i = len.next + len.value;
  }
  if (!fields[1] && !fields[2]) return null;
  return { image: fields[1] || null, title: fields[2] || null, merchant: fields[3] || null };
}

const uniq = (xs) => [...new Set(xs)];

/**
 * Pull the media out of a content.js preview script.
 * @returns {{ youtubeIds: string[], shopping: Array<{image,title,merchant}>, images: string[] }}
 */
export function extractPreviewMedia(js) {
  const text = unescapePreviewJs(js);

  const youtubeIds = uniq([...text.matchAll(/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//g)].map((m) => m[1]));

  const shopping = [];
  const seenPla = new Set();
  for (const m of text.matchAll(/pla%3D([A-Za-z0-9_-]+)/g)) {
    if (seenPla.has(m[1])) continue;
    seenPla.add(m[1]);
    const p = decodePla(m[1]);
    if (p && !shopping.some((s) => s.title === p.title && s.image === p.image)) shopping.push(p);
  }

  const images = uniq([
    ...[...text.matchAll(/(?:https?:)?\/\/tpc\.googlesyndication\.com\/(?:archive\/)?simgad\/\d+/g)]
      .map((m) => (m[0].startsWith('//') ? `https:${m[0]}` : m[0].replace(/^http:/, 'https:'))),
    ...[...text.matchAll(/https:\/\/encrypted-tbn\d\.gstatic\.com\/(?:images|shopping)\?q=tbn:[A-Za-z0-9_-]+/g)].map((m) => m[0]),
    ...[...text.matchAll(/https:\/\/s0\.2mdn\.net\/[^"'\s\\)]+\.(?:jpg|jpeg|png|gif|webp)/gi)].map((m) => m[0]),
  ]).filter((u) => !shopping.some((s) => s.image === u));

  return { youtubeIds, shopping, images };
}

/** One row per creative, normalised and ready to sort and render. */
export function normaliseAd(item, { now = new Date() } = {}) {
  return {
    advertiser: item.title || null,
    advertiserId: item.advertiser_id || null,
    creativeId: item.creative_id || null,
    verified: item.verified ?? null,
    format: item.format || 'unknown',
    firstShown: item.first_shown || null,
    lastShown: item.last_shown || null,
    days: daysRunning(item.first_shown, item.last_shown),
    live: isRecentlyShown(item.last_shown, { now }),
    transparencyUrl: item.url || null,
    previewImage: item.preview_image?.url || null,
    previewScript: item.preview_url || null,
  };
}

/** Longest-running first; unreadable dates last; ties broken by most recent. */
export function sortByLongevity(ads) {
  return [...ads].sort((a, b) => {
    if (a.days == null && b.days != null) return 1;
    if (b.days == null && a.days != null) return -1;
    if ((b.days ?? 0) !== (a.days ?? 0)) return (b.days ?? 0) - (a.days ?? 0);
    return String(b.lastShown || '').localeCompare(String(a.lastShown || ''));
  });
}
