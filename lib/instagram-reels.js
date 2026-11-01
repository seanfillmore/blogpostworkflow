/**
 * Instagram Reels publishing + insights through the Instagram Graph API
 * (Facebook Login flavour: graph.facebook.com, a Page-linked IG business account).
 *
 * Publishing is two calls with a wait between them, and the wait is not optional:
 *   1. POST /{ig-user}/media  media_type=REELS, video_url=<public URL>  → container id
 *   2. poll GET /{container}?fields=status_code until FINISHED (Instagram downloads
 *      and transcodes the file itself; ~30-90 s for a 30 s clip)
 *   3. POST /{ig-user}/media_publish  creation_id=<container>            → media id
 * Publishing a container that is still IN_PROGRESS fails, and a container that is
 * never published simply EXPIRES after 24 h, so a run that dies between 1 and 3
 * leaves nothing live and nothing to clean up.
 *
 * The token must carry `instagram_content_publish`. Measured 2026-10-15: only
 * META_USER_ACCESS_TOKEN (the system-user token) does; FACEBOOK_ACCESS_TOKEN has 6
 * scopes and none of the Instagram ones. So this module takes the token from its
 * caller rather than through lib/meta-token.js, whose key ORDER would hand back
 * the user token first.
 *
 * `plays` was retired; `views` is the Reel view metric (verified on this account
 * 2026-10-15 against v21.0, along with every metric in REEL_METRICS).
 *
 * Every function takes `fetchImpl` so tests never touch the network.
 */

export const GRAPH = 'https://graph.facebook.com/v21.0';

/** The Instagram business account linked to the Real Skin Care Page (@realskincare_com). */
export const RSC_IG_USER_ID = '17841428233225633';

export const REEL_METRICS = Object.freeze([
  'views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time',
]);

async function graph(method, path, params, { token, fetchImpl = fetch }) {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  let res;
  if (method === 'GET') {
    for (const [k, v] of body) url.searchParams.set(k, v);
    res = await fetchImpl(url, { method });
  } else {
    res = await fetchImpl(url, { method, body });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    throw new Error(`instagram: ${method} ${path} -> HTTP ${res.status}: ${e.message || 'unknown error'}${e.error_user_msg ? ` (${e.error_user_msg})` : ''}`);
  }
  return json;
}

export async function createReelContainer({ igUserId = RSC_IG_USER_ID, videoUrl, caption, shareToFeed = true }, opts) {
  const r = await graph('POST', `${igUserId}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: String(shareToFeed),
  }, opts);
  return r.id;
}

/**
 * Poll a container until Instagram has processed the video.
 * Resolves on FINISHED; throws on ERROR/EXPIRED or when `timeoutMs` runs out.
 */
export async function waitForContainer(containerId, { intervalMs = 10_000, timeoutMs = 10 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
  const started = Date.now();
  for (;;) {
    const r = await graph('GET', containerId, { fields: 'status_code,status' }, opts);
    if (r.status_code === 'FINISHED') return r;
    if (r.status_code === 'ERROR' || r.status_code === 'EXPIRED') {
      throw new Error(`instagram: container ${containerId} ${r.status_code}${r.status ? `: ${r.status}` : ''}`);
    }
    if (Date.now() - started >= timeoutMs) throw new Error(`instagram: container ${containerId} still ${r.status_code || 'unknown'} after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(intervalMs);
  }
}

export async function publishContainer({ igUserId = RSC_IG_USER_ID, containerId }, opts) {
  const r = await graph('POST', `${igUserId}/media_publish`, { creation_id: containerId }, opts);
  return r.id;
}

export async function getMedia(mediaId, opts) {
  return graph('GET', mediaId, { fields: 'id,permalink,timestamp,like_count,comments_count' }, opts);
}

/** { views, reach, likes, ... } for one Reel. A metric Instagram refuses is left out, never zeroed. */
export async function getReelInsights(mediaId, opts) {
  const r = await graph('GET', `${mediaId}/insights`, { metric: REEL_METRICS.join(',') }, opts);
  const out = {};
  for (const m of r.data || []) {
    const v = m.values?.[0]?.value ?? m.total_value?.value;
    if (typeof v === 'number') out[m.name] = v;
  }
  return out;
}

/**
 * Feed IMAGE posts (agents/ig-statics). Instagram accepts JPEG only, from a public
 * URL, at an aspect ratio between 4:5 and 1.91:1. `ig_reels_avg_watch_time` is a
 * Reel-only metric and asking for it on an image fails the whole insights call,
 * so images have their own list.
 */
export const IMAGE_METRICS = Object.freeze(['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions']);

export async function createImageContainer({ igUserId = RSC_IG_USER_ID, imageUrl, caption }, opts) {
  const r = await graph('POST', `${igUserId}/media`, { image_url: imageUrl, caption }, opts);
  return r.id;
}

/** Create → wait → publish → read back the permalink, for one feed image. */
export async function publishImage({ igUserId = RSC_IG_USER_ID, imageUrl, caption }, opts) {
  const containerId = await createImageContainer({ igUserId, imageUrl, caption }, opts);
  await waitForContainer(containerId, { intervalMs: 3_000, timeoutMs: 2 * 60_000, ...opts });
  const mediaId = await publishContainer({ igUserId, containerId }, opts);
  let permalink = null;
  try { permalink = (await getMedia(mediaId, opts)).permalink || null; } catch { /* the post is live either way */ }
  return { containerId, mediaId, permalink };
}

export async function getImageInsights(mediaId, opts) {
  const r = await graph('GET', `${mediaId}/insights`, { metric: IMAGE_METRICS.join(',') }, opts);
  const out = {};
  for (const m of r.data || []) {
    const v = m.values?.[0]?.value ?? m.total_value?.value;
    if (typeof v === 'number') out[m.name] = v;
  }
  return out;
}

/** Captions of the account's most recent posts (newest first), for duplicate checks. */
export async function recentCaptions({ igUserId = RSC_IG_USER_ID, limit = 50 }, opts) {
  const r = await graph('GET', `${igUserId}/media`, { fields: 'caption,timestamp', limit: String(limit) }, opts);
  return (r.data || []).map((m) => String(m.caption || ''));
}

/** Create → wait → publish → read back the permalink. */
export async function publishReel({ igUserId = RSC_IG_USER_ID, videoUrl, caption }, opts) {
  const containerId = await createReelContainer({ igUserId, videoUrl, caption }, opts);
  await waitForContainer(containerId, opts);
  const mediaId = await publishContainer({ igUserId, containerId }, opts);
  let permalink = null;
  try { permalink = (await getMedia(mediaId, opts)).permalink || null; } catch { /* the post is live either way */ }
  return { containerId, mediaId, permalink };
}
