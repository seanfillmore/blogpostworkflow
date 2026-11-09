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

/**
 * Collaborators (up to 3 usernames) turn the Reel into a collab post: each one is
 * INVITED, and once they accept, the Reel also shows on their profile to their
 * followers. Supported for REELS and CAROUSEL only, never IMAGE (Meta docs,
 * checked 2026-11-03). Sent as a JSON array of bare usernames.
 */
export const MAX_COLLABORATORS = 3;

export function collaboratorsParam(collaborators = []) {
  const names = [...new Set((collaborators || []).map((c) => String(c || '').trim().replace(/^@/, '').toLowerCase()).filter((c) => /^[a-z0-9._]{1,30}$/.test(c)))];
  return names.slice(0, MAX_COLLABORATORS);
}

export async function createReelContainer({ igUserId = RSC_IG_USER_ID, videoUrl, caption, shareToFeed = true, collaborators = [] }, opts) {
  const names = collaboratorsParam(collaborators);
  const r = await graph('POST', `${igUserId}/media`, {
    media_type: 'REELS',
    video_url: videoUrl,
    caption,
    share_to_feed: String(shareToFeed),
    ...(names.length ? { collaborators: JSON.stringify(names) } : {}),
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

/**
 * "The media could not be fetched from this URI" is Meta's fetcher failing, not the
 * image: on 2026-11-06 it refused slide 3 of a 7-slide carousel while the same
 * Shopify URL served a JPEG to curl and to the Facebook Page post a moment later.
 * Shopify's CDN builds a file variant on the first request (~1.6 s measured), which
 * can outlast Meta's fetch timeout. So every image is fetched once first (warm), and
 * a fetch refusal is retried after a wait. Any other refusal throws at once.
 *
 * Warming and waiting were not enough: on 2026-11-09, with both in place, slide 2
 * was refused on the first try and on both retries, while Shopify served it to the
 * facebookexternalhit user agent in 0.1 s. Meta appears to remember a failed fetch
 * per URL, so a retry of the IDENTICAL URL fails again. Each retry therefore asks
 * for the same file under a fresh query string (`rsc_fetch=N`), which Shopify's CDN
 * ignores and Meta treats as a new URL.
 */
const FETCH_REFUSED = /could not be fetched/i;
export const FETCH_RETRY_DELAYS_MS = Object.freeze([15_000, 45_000, 90_000]);

export function freshFetchUrl(url, attempt) {
  if (!attempt) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('rsc_fetch', String(attempt));
    return u.toString();
  } catch {
    return url;
  }
}

async function warmImage(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'image/jpeg' }, signal: AbortSignal.timeout(20_000) });
    await res.arrayBuffer?.();
  } catch { /* best effort: Meta's own fetch decides */ }
}

async function createImageMedia(igUserId, params, { prewarmed = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts }) {
  if (!prewarmed) await warmImage(params.image_url, opts.fetchImpl);
  for (let attempt = 0; ; attempt++) {
    const imageUrl = freshFetchUrl(params.image_url, attempt);
    try {
      return (await graph('POST', `${igUserId}/media`, { ...params, image_url: imageUrl }, opts)).id;
    } catch (err) {
      if (!FETCH_REFUSED.test(err.message) || attempt >= FETCH_RETRY_DELAYS_MS.length) throw err;
      await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
      await warmImage(freshFetchUrl(params.image_url, attempt + 1), opts.fetchImpl);
    }
  }
}

export async function createImageContainer({ igUserId = RSC_IG_USER_ID, imageUrl, caption }, opts) {
  return createImageMedia(igUserId, { image_url: imageUrl, caption }, opts);
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

/**
 * Create → wait → publish → read back the permalink.
 *
 * With collaborators, a container Instagram refuses (a private account, a handle
 * that no longer exists) is retried ONCE without them: a collab invite is a bonus,
 * and losing the day's Reel over it would be backwards. `collab` in the result says
 * which happened: { invited: [...] } or { refused: '<error>', invited: [] }.
 */
export async function publishReel({ igUserId = RSC_IG_USER_ID, videoUrl, caption, collaborators = [] }, opts) {
  const names = collaboratorsParam(collaborators);
  let containerId;
  let collab = names.length ? { invited: names } : null;
  try {
    containerId = await createReelContainer({ igUserId, videoUrl, caption, collaborators: names }, opts);
  } catch (err) {
    if (!names.length) throw err;
    collab = { invited: [], refused: err.message };
    containerId = await createReelContainer({ igUserId, videoUrl, caption }, opts);
  }
  await waitForContainer(containerId, opts);
  const mediaId = await publishContainer({ igUserId, containerId }, opts);
  let permalink = null;
  try { permalink = (await getMedia(mediaId, opts)).permalink || null; } catch { /* the post is live either way */ }
  return { containerId, mediaId, permalink, collab };
}

/**
 * A feed CAROUSEL (2-10 JPEG slides) for agents/social-poster's organic posts:
 * one container per slide (`is_carousel_item`), each waited on, then a CAROUSEL
 * container naming them as children, waited on, then published. Insights use
 * IMAGE_METRICS (the Reel-only watch time is never asked of a carousel).
 */
export async function publishCarousel({ igUserId = RSC_IG_USER_ID, imageUrls = [], caption }, opts) {
  if (imageUrls.length < 2 || imageUrls.length > 10) throw new Error(`instagram: a carousel takes 2 to 10 images, got ${imageUrls.length}`);
  for (const url of imageUrls) await warmImage(url, opts?.fetchImpl);
  const children = [];
  for (const url of imageUrls) {
    const id = await createImageMedia(igUserId, { image_url: url, is_carousel_item: 'true' }, { ...opts, prewarmed: true });
    await waitForContainer(id, { intervalMs: 3_000, timeoutMs: 2 * 60_000, ...opts });
    children.push(id);
  }
  const parent = await graph('POST', `${igUserId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption }, opts);
  await waitForContainer(parent.id, { intervalMs: 3_000, timeoutMs: 3 * 60_000, ...opts });
  const mediaId = await publishContainer({ igUserId, containerId: parent.id }, opts);
  let permalink = null;
  try { permalink = (await getMedia(mediaId, opts)).permalink || null; } catch { /* the post is live either way */ }
  return { containerId: parent.id, mediaId, permalink, children };
}

/**
 * Account growth over one window (unix seconds, at most 30 days): new follows,
 * unfollows, profile views, website clicks, and reach split by whether the
 * account reached already follows us. `follows_and_unfollows` broken down by
 * follow_type reports FOLLOWER = accounts that followed and NON_FOLLOWER =
 * accounts that unfollowed. A metric Instagram refuses is left null, never 0.
 */
export async function getAccountGrowth({ igUserId = RSC_IG_USER_ID, since, until }, opts) {
  const total = async (metric, extra = {}) => {
    try {
      const r = await graph('GET', `${igUserId}/insights`, { metric, period: 'day', metric_type: 'total_value', since: String(since), until: String(until), ...extra }, opts);
      return r.data?.[0]?.total_value || null;
    } catch { return null; }
  };
  const byType = (tv, key) => tv?.breakdowns?.[0]?.results?.find((x) => x.dimension_values?.[0] === key)?.value ?? (tv ? 0 : null);
  const fu = await total('follows_and_unfollows', { breakdown: 'follow_type' });
  const reach = await total('reach', { breakdown: 'follow_type' });
  const views = await total('profile_views');
  const clicks = await total('website_clicks');
  let followers = null;
  try { followers = (await graph('GET', igUserId, { fields: 'followers_count' }, opts)).followers_count ?? null; } catch { /* left null */ }
  return {
    follows: byType(fu, 'FOLLOWER'),
    unfollows: byType(fu, 'NON_FOLLOWER'),
    profile_views: views?.value ?? null,
    website_clicks: clicks?.value ?? null,
    reach: reach?.value ?? null,
    reach_non_followers: byType(reach, 'NON_FOLLOWER'),
    reach_followers: byType(reach, 'FOLLOWER'),
    followers,
  };
}
