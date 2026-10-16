/**
 * Policy for posting approved Trybe creator videos as Instagram Reels
 * (agents/ugc-reels). Pure: no I/O, so every rule here is tested directly.
 *
 * Sean, 2026-10-15: "Post three a day and when we start to recycle content, come
 * up with different copy. We can monitor engagement and find out what works."
 *
 * RIGHTS. Trybe's brand terms §5.2.2 license creator content "for the Campaign and
 * related marketing (regardless of marketing channel)", non-exclusive, no credit
 * required. On a COMMISSION program the license is conditional on paying
 * commissions (§5.3.3); on a flat-fee one it is perpetual (§5.3.4). We credit the
 * creator by first name anyway; it costs nothing and it is the honest framing.
 *
 * WHAT MAY POST. Approved videos only, latest version only, and only when the
 * spoken transcript passes the same COMMERCIAL claim gate the product copy uses
 * (lib/seo-copy-health-gate.js). A brand account posting a creator's words is the
 * brand saying them. A video with NO transcript (silent) is eligible: Sean,
 * 2026-10-16, "I have viewed and approved every video", so his review in Trybe
 * is the screen for what is shown and written on screen, which no code reads.
 * Its caption cannot quote the creator, so the creator_quote style is skipped.
 *
 * CREDIT. "🎥 @handle" when the creator gave us their Instagram handle
 * (lib/creator-socials.js), first name otherwise, first name only when they
 * asked not to be tagged. Trybe is a commission program and Sean pays
 * commissions continually, which keeps the §5.3.3 license live.
 *
 * ORDER. Every eligible video posts once (oldest first) before any repeats. A
 * repeat ("recycle") always gets NEW copy and a DIFFERENT caption style from the
 * last time that video ran, and never inside MIN_RECYCLE_DAYS of its last post.
 *
 * THE EXPERIMENT. The caption STYLE is chosen in code, not by the model, so the
 * engagement data can say which style works: a style is a controlled variable
 * only when the code assigned it. Until every style has MIN_MEASURED_PER_STYLE
 * measured posts the least-tried style goes next (exploration); after that, two
 * picks in three go to the best style by median views and one in three to the
 * least-tried (so a weak early read can still be overturned). Views are the score
 * because on an account this size (1,069 followers on 2026-10-15) reach and views
 * are what a caption moves; interactions are reported beside them.
 */

import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';
import { tokenOverlap } from './ctr-copy-distinctness.js';
import { handleFor, declinedTag } from './creator-socials.js';

export const POSTS_PER_DAY = 3;
export const MIN_RECYCLE_DAYS = 7;
export const MAX_PUBLISH_FAILURES = 2;
/** A post's insights are read from 24 h old until FINAL_INSIGHTS_DAYS, then frozen. */
export const INSIGHTS_MIN_AGE_HOURS = 24;
export const FINAL_INSIGHTS_DAYS = 30;
export const INSIGHTS_REFRESH_HOURS = 20;
/** A post is "measured" for the style comparison once it is this old. */
export const MEASURED_AGE_HOURS = 48;
export const MIN_MEASURED_PER_STYLE = 3;
export const MAX_HASHTAGS = 5;
export const MAX_CAPTION_CHARS = 2200;
export const MAX_BODY_CHARS = 700;
export const MAX_RECYCLE_OVERLAP = 0.5;

export const HOOK_STYLES = Object.freeze({
  question: 'Open with a question the viewer is already asking themselves about this kind of product.',
  pov: 'Open with "POV:" and a relatable everyday moment the video shows.',
  ingredient: 'Lead with what is in the product (and what is not), using only the product name and what the creator says.',
  creator_quote: 'Lead with one short line the creator actually says in the video, quoted word for word.',
  routine: 'Frame the video as one step in an ordinary daily routine.',
  honest_take: "Frame it as a real person's honest first impression, in a plain conversational voice.",
  one_liner: 'One short punchy line and the call to action. Nothing else.',
});
export const HOOK_STYLE_KEYS = Object.freeze(Object.keys(HOOK_STYLES));

const ms = (h) => h * 3_600_000;
const day = 86_400_000;

export function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

export function transcriptText(s) {
  return String(s?.transcript?.text || '').trim();
}

/**
 * Split approved submissions into what may post and what may not, with a reason
 * for every refusal (the digest names them).
 */
export function eligibleVideos(submissions, ledger = {}, { excluded = [] } = {}) {
  const excludedIds = new Map((excluded || []).map((e) => [e.submission_id, e.reason || 'excluded']));
  const all = submissions || [];
  const superseded = new Set(all.map((s) => s?.revision_of).filter(Boolean));
  const failures = {};
  for (const f of ledger.failures || []) failures[f.submission_id] = (failures[f.submission_id] || 0) + 1;

  const eligible = [];
  const skipped = [];
  for (const s of all) {
    if (s?.status !== 'approved' || s.media_type !== 'video') continue;
    if (superseded.has(s.id)) continue; // a newer version exists
    const reason = (() => {
      if (excludedIds.has(s.id)) return `excluded in config/ugc-reels.json: ${excludedIds.get(s.id)}`;
      if (!s.asset?.url) return 'no video file on the submission';
      if ((failures[s.id] || 0) >= MAX_PUBLISH_FAILURES) return `failed ${failures[s.id]} times (caption gate or Instagram); see the ledger's failures`;
      const text = transcriptText(s);
      if (!text) return null; // silent: Sean reviewed it by eye
      const { blocking } = checkSeoCopyFields({ transcript: text }, { surface: COMMERCIAL_SURFACE });
      if (blocking.length) return `claim in transcript: "${blocking.map((b) => b.match).join('", "')}"`;
      return null;
    })();
    if (reason) skipped.push({ submission: s, reason });
    else eligible.push(s);
  }
  eligible.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return { eligible, skipped };
}

export function postsFor(ledger, submissionId) {
  return (ledger.posts || []).filter((p) => p.submission_id === submissionId);
}

const productKey = (s) => (s.products || []).map((p) => p.name).sort().join(' + ');

/**
 * The next video to post, or null with a reason. Unposted videos first, oldest
 * first, avoiding the same product twice in a row when another is available;
 * then repeats, the one whose last run is oldest, never inside MIN_RECYCLE_DAYS.
 */
export function pickNext(eligible, ledger = {}, now = Date.now()) {
  const posts = ledger.posts || [];
  const posted = new Set(posts.map((p) => p.submission_id));
  const lastProduct = posts.length ? posts[posts.length - 1].product_key : null;

  const fresh = eligible.filter((s) => !posted.has(s.id));
  if (fresh.length) {
    const pick = fresh.find((s) => productKey(s) !== lastProduct) || fresh[0];
    return { submission: pick, cycle: 1, previous: [] };
  }

  const lastAt = (s) => Math.max(...postsFor(ledger, s.id).map((p) => Date.parse(p.posted_at) || 0));
  const due = eligible
    .filter((s) => now - lastAt(s) >= MIN_RECYCLE_DAYS * day)
    .sort((a, b) => lastAt(a) - lastAt(b));
  if (!due.length) {
    return { submission: null, reason: eligible.length ? `every video ran within the last ${MIN_RECYCLE_DAYS} days` : 'no eligible videos' };
  }
  const pick = due.find((s) => productKey(s) !== lastProduct) || due[0];
  const previous = postsFor(ledger, pick.id);
  return { submission: pick, cycle: previous.length + 1, previous };
}

export { productKey };

function median(xs) {
  const v = [...xs].sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Posts old enough, with insights, to count in the comparison. */
export function measuredPosts(ledger, now = Date.now()) {
  return (ledger.posts || []).filter((p) =>
    p.insights && typeof p.insights.views === 'number' && now - Date.parse(p.posted_at) >= ms(MEASURED_AGE_HOURS));
}

/** Per-style results: n, median views, median reach, interaction rate. */
export function styleStats(ledger, now = Date.now()) {
  const by = Object.fromEntries(HOOK_STYLE_KEYS.map((k) => [k, []]));
  for (const p of measuredPosts(ledger, now)) if (by[p.hook_style]) by[p.hook_style].push(p);
  return HOOK_STYLE_KEYS.map((style) => {
    const ps = by[style];
    const reach = ps.reduce((a, p) => a + (p.insights.reach || 0), 0);
    const inter = ps.reduce((a, p) => a + (p.insights.total_interactions || 0), 0);
    return {
      style,
      n: ps.length,
      tried: (ledger.posts || []).filter((p) => p.hook_style === style).length,
      medianViews: median(ps.map((p) => p.insights.views)),
      medianReach: median(ps.map((p) => p.insights.reach || 0)),
      interactionRate: reach ? inter / reach : null,
    };
  });
}

/**
 * Choose the caption style for the next post. `rand` is injectable for tests.
 * Never the style this video ran with last time.
 */
export function chooseHookStyle(ledger, previous = [], { now = Date.now(), rand = Math.random, exclude = [] } = {}) {
  const banned = previous.length ? previous[previous.length - 1].hook_style : null;
  const stats = styleStats(ledger, now).filter((s) => s.style !== banned && !exclude.includes(s.style));
  const leastTried = [...stats].sort((a, b) => a.tried - b.tried || HOOK_STYLE_KEYS.indexOf(a.style) - HOOK_STYLE_KEYS.indexOf(b.style))[0];
  const exploring = stats.some((s) => s.n < MIN_MEASURED_PER_STYLE);
  if (exploring) return { style: leastTried.style, why: 'exploring: least-tried style' };
  if (rand() < 1 / 3) return { style: leastTried.style, why: 'exploring (1 in 3): least-tried style' };
  const best = [...stats].sort((a, b) => (b.medianViews ?? -1) - (a.medianViews ?? -1))[0];
  return { style: best.style, why: `exploiting: best median views (${Math.round(best.medianViews)})` };
}

const norm = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Deterministic caption checks beyond the health gate. Shape matches
 * gateGeneratedCopy's `extraChecks`: check(fields) → hits, constraint(hits) → text.
 */
/** Words a caption uses to name each product line. */
const PRODUCT_WORDS = Object.freeze({
  moisturizer: /\bmoisturi[sz]er\b|\bbody cream\b|\bcream\b/,
  lotion: /\blotion\b/,
  toothpaste: /\btoothpaste\b/,
  soap: /\bsoap\b/,
  deodorant: /\bdeodorant\b/,
  'lip balm': /\blip balm\b/,
});

function productLines(name) {
  const n = String(name || '').toLowerCase();
  return Object.keys(PRODUCT_WORDS).filter((k) => PRODUCT_WORDS[k].test(n));
}

/**
 * An ingredient COUNT may only sit in a sentence that names products carrying
 * that count in their own name. Found live on the first server dry run
 * (2026-10-15): a video showing the moisturizer AND the lotion produced "Our
 * coconut moisturizer and body lotion are made with only 6 clean ingredients".
 * Only the lotion has 6; the cream has 7. A product fact pinned to the wrong
 * product is a false statement, so this blocks rather than advises.
 */
export function misattributedCounts(caption, products = []) {
  const hits = [];
  for (const sentence of String(caption || '').split(/(?<=[.!?\n])\s+/)) {
    const lower = sentence.toLowerCase();
    for (const m of lower.matchAll(/\b(\d+)\s+(?:[a-z-]+\s+)?ingredients?\b/g)) {
      const count = m[1];
      for (const [line, re] of Object.entries(PRODUCT_WORDS)) {
        if (!re.test(lower)) continue;
        const owners = products.filter((p) => productLines(p.name).includes(line));
        if (!owners.length) continue;
        if (!owners.some((p) => new RegExp(`\\b${count}\\b`).test(p.name))) hits.push({ line, count, sentence: sentence.trim() });
      }
    }
  }
  return hits;
}

export function captionFormatCheck({ transcript = '', previous = [], products = [] } = {}) {
  return {
    check(fields) {
      const c = String(fields.caption || '');
      const hits = [];
      const hit = (why, match) => hits.push({ field: 'caption', category: 'format', why, match });
      for (const m of misattributedCounts(c, products)) hit(`gives the ${m.line} an ingredient count (${m.count}) that only another product has`, m.sentence);
      if (/[—–]/.test(c)) hit('uses an em or en dash', c.match(/[—–]/)[0]);
      if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co|net|shop)\b/i.test(c)) hit('contains a link (captions are not clickable; say "link in bio")', c.match(/https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|co|net|shop)\b/i)[0]);
      if (c.length > MAX_BODY_CHARS) hit(`is ${c.length} characters; keep it under ${MAX_BODY_CHARS}`, `${c.length} chars`);
      const tags = c.match(/#[\w]+/g) || [];
      if (tags.length > MAX_HASHTAGS) hit(`has ${tags.length} hashtags; use at most ${MAX_HASHTAGS}`, tags.join(' '));
      if (/\$\s?\d|\d+\s?% off|\bdiscount\b|\bcoupon\b|\bcode\b/i.test(c)) hit('mentions a price, discount or code (offers are not ours to invent)', c.match(/\$\s?\d+|\d+\s?% off|discount|coupon|code/i)[0]);
      for (const q of c.match(/"([^"]{12,})"|“([^”]{12,})”/g) || []) {
        const inner = q.slice(1, -1);
        if (inner.split(/\s+/).length >= 3 && !norm(transcript).includes(norm(inner))) hit('quotes words the creator does not say in the video', q);
      }
      for (const p of previous) {
        const o = tokenOverlap(p.caption || '', c);
        if (o > MAX_RECYCLE_OVERLAP) hit(`repeats an earlier caption for this video (${Math.round(o * 100)}% the same words)`, String(p.caption || '').slice(0, 60));
      }
      return hits;
    },
    constraint(hits) {
      return `Your caption broke these rules; rewrite it so none apply:\n${hits.map((h) => `- It ${h.why} (${h.match})`).join('\n')}`;
    },
  };
}

/** The credit line the code appends; the model never writes it. */
export function creditLine(submission, socials = null) {
  const name = submission.creator?.name;
  if (!declinedTag(socials, name)) {
    const handle = handleFor(socials, name);
    if (handle) return `🎥 @${handle}`;
  }
  const first = firstName(name);
  return first ? `🎥 ${first}` : '';
}

export function composeCaption(body, submission, socials = null) {
  const credit = creditLine(submission, socials);
  const out = credit ? `${body.trim()}\n\n${credit}` : body.trim();
  return out.slice(0, MAX_CAPTION_CHARS);
}

/** The "what has worked" block for the caption prompt. Empty until there is data. */
export function learningsForPrompt(ledger, now = Date.now()) {
  const measured = measuredPosts(ledger, now);
  if (measured.length < 6) return '';
  const top = [...measured].sort((a, b) => b.insights.views - a.insights.views);
  const line = (p) => `- ${p.insights.views} views, ${p.insights.total_interactions ?? 0} interactions (${p.hook_style}): ${p.body.split('\n')[0].slice(0, 140)}`;
  return [
    'How earlier captions on this account performed (views 48h+ after posting). Learn from the openers that worked; do not copy them:',
    'Best:', ...top.slice(0, 3).map(line),
    'Weakest:', ...top.slice(-3).map(line),
  ].join('\n');
}

/** Posts whose insights are due for a (re)read. */
export function insightsDue(ledger, now = Date.now()) {
  return (ledger.posts || []).filter((p) => {
    if (!p.media_id) return false;
    const age = now - Date.parse(p.posted_at);
    if (age < ms(INSIGHTS_MIN_AGE_HOURS)) return false;
    if (p.insights_final) return false;
    return !p.insights_at || now - Date.parse(p.insights_at) >= ms(INSIGHTS_REFRESH_HOURS);
  });
}

export function isFinalRead(post, now = Date.now()) {
  return now - Date.parse(post.posted_at) >= FINAL_INSIGHTS_DAYS * day;
}

export function renderStyleTable(ledger, now = Date.now()) {
  const rows = styleStats(ledger, now);
  const fmt = (v, d = 0) => (v == null ? '-' : Number(v).toFixed(d));
  return [
    'Caption style      posted  measured  median views  median reach  interactions/reach',
    ...rows.map((r) => `${r.style.padEnd(18)} ${String(r.tried).padStart(6)}  ${String(r.n).padStart(8)}  ${fmt(r.medianViews).padStart(12)}  ${fmt(r.medianReach).padStart(12)}  ${r.interactionRate == null ? '-' : `${(r.interactionRate * 100).toFixed(1)}%`}`),
  ].join('\n');
}
