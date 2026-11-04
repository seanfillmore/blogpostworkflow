/**
 * Facebook Page photo posts + insights through the Graph API, for the Social queue
 * (agents/social-poster). The Page is "Real Skin Care", 113847674946808, the one
 * linked to @realskincare_com. NOT 100780896269817, a duplicate being retired.
 *
 * Posting needs a PAGE token. The system-user token (META_USER_ACCESS_TOKEN) holds
 * pages_manage_posts and CREATE_CONTENT on this Page, and GET /{page}?fields=
 * access_token exchanges it for the Page token at run time, so no Page token is
 * stored anywhere.
 *
 * POST /{page}/photos with url + message publishes a photo post and returns
 * { id: <photo id>, post_id: <page_post id> }; insights and the permalink key on
 * the post id.
 *
 * Insight metrics, verified on this Page 2026-10-24 against v21.0 (Meta's docs
 * list post_impressions* as deprecated; post_impressions_organic and
 * post_impressions_unique already answer "(#100) The value must be a valid
 * insights metric"): post_media_view, post_total_media_view_unique, post_clicks.
 * Reactions, comments and shares come from the post's own summary fields.
 *
 * Every function takes `fetchImpl` so tests never touch the network.
 */

import { GRAPH } from './instagram-reels.js';

export const RSC_FB_PAGE_ID = '113847674946808';
export const FB_POST_METRICS = Object.freeze(['post_media_view', 'post_total_media_view_unique', 'post_clicks']);

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
    throw new Error(`facebook: ${method} ${path} -> HTTP ${res.status}: ${e.message || 'unknown error'}${e.error_user_msg ? ` (${e.error_user_msg})` : ''}`);
  }
  return json;
}

/** Exchange the system-user token for the Page's own token. */
export async function getPageToken({ pageId = RSC_FB_PAGE_ID, userToken, fetchImpl }) {
  const r = await graph('GET', pageId, { fields: 'access_token' }, { token: userToken, fetchImpl });
  if (!r.access_token) throw new Error(`facebook: no page access_token for ${pageId} (does the token have pages_manage_posts on it?)`);
  return r.access_token;
}

/** Publish one photo post. Returns { photoId, postId, permalink }. */
export async function publishPagePhoto({ pageId = RSC_FB_PAGE_ID, imageUrl, caption }, opts) {
  const r = await graph('POST', `${pageId}/photos`, { url: imageUrl, message: caption, published: 'true' }, opts);
  const postId = r.post_id || (r.id ? `${pageId}_${r.id}` : null);
  if (!postId) throw new Error('facebook: photo post returned no id');
  let permalink = null;
  try { permalink = (await graph('GET', postId, { fields: 'permalink_url' }, opts)).permalink_url || null; } catch { /* the post is live either way */ }
  return { photoId: r.id || null, postId, permalink };
}

/**
 * Publish one post carrying several photos (an organic carousel's slides): each
 * photo is uploaded UNPUBLISHED, then one feed post attaches them in order.
 * Returns { photoIds, postId, permalink }.
 */
export async function publishPagePhotos({ pageId = RSC_FB_PAGE_ID, imageUrls = [], caption }, opts) {
  if (!imageUrls.length) throw new Error('facebook: no images');
  const photoIds = [];
  for (const url of imageUrls) {
    const r = await graph('POST', `${pageId}/photos`, { url, published: 'false' }, opts);
    if (!r.id) throw new Error('facebook: unpublished photo returned no id');
    photoIds.push(r.id);
  }
  const r = await graph('POST', `${pageId}/feed`, { message: caption, attached_media: JSON.stringify(photoIds.map((id) => ({ media_fbid: id }))) }, opts);
  if (!r.id) throw new Error('facebook: multi-photo post returned no id');
  let permalink = null;
  try { permalink = (await graph('GET', r.id, { fields: 'permalink_url' }, opts)).permalink_url || null; } catch { /* the post is live either way */ }
  return { photoIds, postId: r.id, permalink };
}

/**
 * Instagram DMs through the Page (Messenger Platform for Instagram). Needs the
 * PAGE token (getPageToken) and instagram_manage_messages, which the system-user
 * token carries (checked 2026-11-04). Conversations come newest-updated first.
 */
export async function listIgConversations({ pageId = RSC_FB_PAGE_ID, limit = 25, messagesPerThread = 10 }, opts) {
  const r = await graph('GET', `${pageId}/conversations`, {
    platform: 'instagram',
    fields: `updated_time,messages.limit(${messagesPerThread}){id,created_time,from,message}`,
    limit: String(limit),
  }, opts);
  return (r.data || []).map((c) => ({ id: c.id, updated_time: c.updated_time, messages: c.messages?.data || [] }));
}

/** Send one Instagram DM as the Page. Only allowed within 24 h of the customer's last message. */
export async function sendIgMessage({ pageId = RSC_FB_PAGE_ID, recipientId, text }, opts) {
  const r = await graph('POST', `${pageId}/messages`, {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text }),
    messaging_type: 'RESPONSE',
  }, opts);
  if (!r.message_id) throw new Error('instagram dm: send returned no message_id');
  return r.message_id;
}

/** Messages of the Page's most recent posts (newest first), for duplicate checks. */
export async function recentPageMessages({ pageId = RSC_FB_PAGE_ID, limit = 50 }, opts) {
  const r = await graph('GET', `${pageId}/posts`, { fields: 'message,created_time', limit: String(limit) }, opts);
  return (r.data || []).map((p) => String(p.message || ''));
}

/** { media_views, unique_viewers, clicks, reactions, comments, shares } for one post. A metric that is refused is left out. */
export async function getPagePostInsights(postId, opts) {
  const out = {};
  try {
    const r = await graph('GET', `${postId}/insights`, { metric: FB_POST_METRICS.join(',') }, opts);
    const name = { post_media_view: 'media_views', post_total_media_view_unique: 'unique_viewers', post_clicks: 'clicks' };
    for (const m of r.data || []) {
      const v = m.values?.[0]?.value;
      if (typeof v === 'number' && name[m.name] && out[name[m.name]] === undefined) out[name[m.name]] = v;
    }
  } catch (err) { out.insights_error = err.message; }
  const e = await graph('GET', postId, { fields: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares' }, opts);
  if (typeof e.reactions?.summary?.total_count === 'number') out.reactions = e.reactions.summary.total_count;
  if (typeof e.comments?.summary?.total_count === 'number') out.comments = e.comments.summary.total_count;
  out.shares = typeof e.shares?.count === 'number' ? e.shares.count : 0;
  return out;
}
