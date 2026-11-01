// lib/trybe-visual-review.js
//
// The pure half of the VISUAL review of a Trybe submission: what we ask a
// vision model about a creator's image (or a video's thumbnail frame), how its
// answer is parsed, and the deterministic checks layered on top. No I/O here.
//
// ── Why it exists ────────────────────────────────────────────────────────────────
//
// The transcript gate (lib/trybe-review.js) can only read spoken words, so every
// static submission reached the digest as "not checked, review by eye" with
// nothing else said about it. Sean, 2026-10-03: "all submissions should be
// reviewed and presented". The first static batch (six AI-rendered images, all
// from one creator) showed what a review actually has to catch, and every rule
// in REVIEW_RULES below is one of those findings or one of Sean's own earlier
// rejection notes:
//
//   - an ingredient card that swapped plant-based emulsifying wax for "essential
//     oils" (rejected twice, by two creators)
//   - a lotion rendered with a PUMP top: the real bottle has a flip-disc cap,
//     and Sean rejected that render "No pump top"
//   - callouts the product does not support ("pure unscented essential oils")
//
// and one thing it must NOT flag: garbled text in the microscopic curved edge
// ring of a label. Sean: "nobody is zooming in on an ad to see it."
//
// ── Ground truth is the LIVE PDP, never a copy ───────────────────────────────────
//
// The reference photographs and the ingredient text come from the product's own
// Shopify page at run time, matched by the Trybe product name (Trybe syncs the
// Shopify title). A facts file in this repo would drift the first time a formula
// or a label changed; the PDP is what a shopper sees.
//
// ── A model's assertion is not a check ──────────────────────────────────────────
//
// The model TRANSCRIBES the readable text in the image; whether that text makes
// a claim is decided by checkSeoCopyFields on the commercial surface, the same
// gate the transcript path uses. A claim found that way forces `needs_changes`
// whatever the model concluded. Same reasoning as truncation detection living in
// lib/html-output-guards.js rather than in the editor's own say-so.
//
// ── It presents; it does not act ─────────────────────────────────────────────────
//
// A visual verdict never sends a revision request, approves or rejects. Packaging
// and ingredient judgements from a vision model are noisier than a regex over a
// transcript, and a revision request is a message to a real person. The verdict
// and a ready-to-paste note go in the digest; Sean responds in the dashboard.

import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';
import { LLM_MODELS } from '../config/llm-models.js';

// The subscription transport runs this through the server's installed Claude
// Code CLI. claude-opus-5-5 needs CLI 2.1.280 or newer and is refused with an
// HTTP 400 on anything older; the server was updated 2.1.273 -> 2.1.288 on
// 2026-10-03 for exactly this, with 2.1.273 kept in ~/claude-cli-2.1.273.bak.
// Before moving to a newer model, check `~/.local/bin/claude --version` on the
// server, or every visual review fails at once.
export const VISUAL_MODEL = LLM_MODELS.flagship;
export const VISUAL_MAX_TOKENS = 2000;

/** Per-run cap on vision calls; the rest wait for tomorrow and are named. */
export const MAX_VISUAL_REVIEWS_PER_RUN = 15;

/** The Messages API refuses an image over 5 MB; base64 inflates by 4/3. */
export const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;

/** Product reference photos sent beside the submission. */
export const MAX_REFERENCE_IMAGES = 3;

/** PDP text sent as ground truth. The ingredient list sits near the top. */
const MAX_FACTS_CHARS = 3000;

export const VERDICTS = ['looks_ready', 'needs_changes', 'unsure'];

export const REVIEW_RULES = [
  'Flag ONLY what a person scrolling past this ad could actually see or read:',
  '1. Packaging that contradicts the reference photos: the wrong closure (for example a pump where the real bottle has a flip-disc cap), the wrong container shape, the wrong label colours or layout, or the wrong product altogether.',
  '2. Legible label text that is wrong: the product name, the scent or variant name, the size. Ignore the tiny curved text running around the edge of a round label even when it is garbled; it is unreadable at ad size and is accepted.',
  '3. Any ingredient list, ingredient callout or "free from" claim in the image that contradicts the product facts: a missing ingredient, an added one, a wrong descriptor (for example "essential oils" listed in place of an ingredient the product actually has), or a claim the facts do not support.',
  '4. Misspelled or garbled headline or caption text (the large overlay text, not the label edge ring).',
  '5. Anything that describes the product as an antiperspirant (it is a deodorant).',
  '6. INGREDIENT COUNTS: a stated count is correct when it equals the product\'s BASE formula count from the catalogue, OR the base count plus that scent\'s added oils. Sean, 2026-10-04: the base count is honest for every scent ("7 is the cream base so we aren\'t lying when we say our cream has 7 ingredients"). Never flag either number.',
  '7. IDENTIFY THE PRODUCT SHOWN using the catalogue below, not only the product tagged. If the image shows a different Real Skin Care product than the tag (for example the body cream JAR tagged as the body lotion), that is NOT a defect: report it once as an issue of type "tag", then judge the image against the product it actually shows.',
  '8. ACCEPTED by the owner, never flag (2026-10-04): the comparison "vs 20+ in most lotions" (or "20+ ingredients in most lotions"), and "handmade" / "handmade in small batches". Also ACCEPTED (Sean, 2026-10-07): "cold-pressed" coconut oil, in any wording ("cold-pressed coconut oil", "cold-pressed virgin coconut oil"); the brand uses organic virgin cold-pressed coconut oil even where the product page does not say so.',
  'Do NOT judge taste, composition, lighting or whether the image is AI-generated. Photographic styling is never a defect.',
].join('\n');

/**
 * Bump when REVIEW_RULES or the request change in a way that should re-review
 * submissions already cached. Part of the cache key.
 * r2 (2026-10-04): per-scent ingredient counts, product-shown vs tag, accepted copy.
 * r3 (2026-10-04): a mis-tagged image is re-reviewed against the SHOWN product's photos.
 * r4 (2026-10-07): "cold-pressed" coconut oil is an accepted claim, never a defect.
 */
export const REVIEW_REVISION = 4;

/**
 * Every product family, its container, base formula and per-scent oils, from
 * config/ingredients.json. The live PDP does not carry per-scent formulas (the
 * lotion page says "Six ingredients" and lists no scent oil), so this is the
 * only source that can answer "is 7 right for Coconut Breeze?". It also lets
 * the model recognise a sibling product the creator tagged wrongly.
 */
export function catalogueFacts(ingredients) {
  const out = [];
  for (const [, p] of Object.entries(ingredients || {})) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.base_ingredients)) continue;
    const base = p.base_ingredients.length;
    const scents = (p.variations || []).map((v) => {
      const add = (v.essential_oils || []).length;
      return add ? `${v.name} (+ ${v.essential_oils.join(', ')} = ${base + add})` : `${v.name} (= ${base})`;
    });
    out.push(`- ${p.name} [${p.shopify_handle}], container: ${p.format}. Base formula, ${base} ingredient${base === 1 ? '' : 's'}: ${p.base_ingredients.join(', ')}.`
      + (scents.length ? ` Scents: ${scents.join('; ')}. A stated count of ${base} is correct for every scent.` : ''));
  }
  return out.join('\n');
}

/** Strip a PDP body_html down to readable text, capped. */
export function factsFromPdp(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FACTS_CHARS);
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The Shopify product a Trybe product tag refers to. Trybe syncs the Shopify
 * title, so an exact normalised match is expected; a prefix match covers a
 * title truncated on one side. Unknown returns null, never a guess.
 */
export function matchShopifyProduct(trybeProduct, shopifyProducts) {
  const want = norm(trybeProduct?.name);
  if (!want) return null;
  const list = shopifyProducts || [];
  return list.find((p) => norm(p.title) === want)
    || list.find((p) => { const t = norm(p.title); return t.startsWith(want) || want.startsWith(t); })
    || null;
}

/** Which image of a submission to review: the asset for a still, the thumbnail for a video. */
export function submissionImageUrl(submission) {
  if (submission?.media_type === 'image') return submission.asset?.url || submission.thumbnail_url || null;
  return submission?.thumbnail_url || null;
}

/** Cache key: a new version of a submission is a new image and is reviewed again. */
export function cacheKey(submission) {
  return `${String(submission?.id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_')}-v${submission?.version ?? 1}-r${REVIEW_REVISION}`;
}

/**
 * Build the Messages API params for one submission.
 *
 * @param {object} a
 * @param {object} a.submission   the Trybe submission
 * @param {{title: string, facts: string}[]} a.products  matched PDP facts
 * @param {{media_type: string, data: string}[]} a.references  base64 product photos
 * @param {{media_type: string, data: string}} a.image  base64 submission image
 */
/**
 * The handle of a product the image shows that the tag did NOT cover, or null.
 * Only a handle that exists on the store counts; a guess never triggers a
 * second, paid review.
 */
export function untaggedShownHandle(parsed, matchedHandles, shopProducts) {
  const h = parsed?.product_shown_handle;
  if (!h || (matchedHandles || []).includes(h)) return null;
  return (shopProducts || []).some((p) => p.handle === h) ? h : null;
}

export function buildVisualRequest({ submission, products = [], references = [], image, catalogue = '', retaggedFrom = null }) {
  const isVideo = submission?.media_type === 'video';
  const tagged = (submission?.products || []).map((p) => p.name).join(', ') || 'none tagged';
  const factsBlock = products.length
    ? products.map((p) => `PRODUCT: ${p.title}\n${p.facts}`).join('\n\n')
    : 'No product facts available; judge packaging only against the reference photos, and say so.';
  const content = [];
  if (references.length) {
    content.push({ type: 'text', text: `REFERENCE PHOTOS of the real product (${references.length}). These show the true packaging:` });
    for (const r of references) content.push({ type: 'image', source: { type: 'base64', media_type: r.media_type, data: r.data } });
  }
  content.push({ type: 'text', text: isVideo
    ? 'CREATOR SUBMISSION: one frame (the thumbnail) of a video. Judge only what this frame shows.'
    : 'CREATOR SUBMISSION: a static ad image.' });
  content.push({ type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } });
  content.push({ type: 'text', text: [
    `This is a creator submission for Real Skin Care, a natural cosmetics brand. Products tagged: ${tagged}.`,
    ...(retaggedFrom ? [`The creator TAGGED this as ${retaggedFrom}, but a first review found it shows the product below; the reference photos and facts are for the product SHOWN. Report the tag mismatch once as type "tag" and judge everything else against these references.`] : []),
    '',
    'PRODUCT FACTS from the live product page:',
    factsBlock,
    '',
    ...(catalogue ? ['THE FULL REAL SKIN CARE CATALOGUE (formulas per scent, and each product\'s container):', catalogue, ''] : []),
    REVIEW_RULES,
    '',
    'Reply with ONLY a JSON object, no prose, in exactly this shape:',
    '{',
    '  "overlay_text": ["every piece of readable headline, caption or callout text in the submission, verbatim, one entry per block; exclude the product label"],',
    '  "product_shown": "which product and variant the submission shows, or \\"none\\"",',
    '  "product_shown_handle": "the [handle] from the catalogue of the product the image shows, or \\"\\" if unsure or none",',
    '  "issues": [{"type": "packaging|label|ingredients|text|claim|tag|other", "detail": "what is wrong, in one sentence, citing what the reference or facts say instead"}],',
    '  "verdict": "looks_ready | needs_changes | unsure",',
    '  "summary": "one sentence a busy owner can read",',
    '  "creator_note": "if needs_changes: a short, friendly note to the creator naming exactly what to change, with no em dashes; otherwise empty"',
    '}',
  ].join('\n') });
  return {
    model: VISUAL_MODEL,
    max_tokens: VISUAL_MAX_TOKENS,
    messages: [{ role: 'user', content }],
  };
}

/**
 * Sean pastes the creator note to a real person, and em dashes are the most
 * recognisable LLM tell in copy he sends. The prompt asks for none; this makes
 * it true rather than hoped for.
 */
export function noEmDashes(text) {
  return String(text || '').replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/,\s*,/g, ',');
}

/** Parse the model's reply. Returns null for anything that is not the expected shape. */
export function parseVisualVerdict(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object' || !VERDICTS.includes(obj.verdict)) return null;
  return {
    overlay_text: Array.isArray(obj.overlay_text) ? obj.overlay_text.map(String).filter((s) => s.trim()) : [],
    product_shown: String(obj.product_shown || ''),
    product_shown_handle: String(obj.product_shown_handle || '').trim().toLowerCase(),
    issues: Array.isArray(obj.issues)
      ? obj.issues.filter((i) => i && i.detail).map((i) => ({ type: String(i.type || 'other'), detail: String(i.detail) }))
      : [],
    verdict: obj.verdict,
    summary: String(obj.summary || ''),
    creator_note: noEmDashes(obj.creator_note),
  };
}

/**
 * Layer the deterministic claim check over a parsed verdict. A claim in the
 * image's own text forces `needs_changes` whatever the model said; and a model
 * that said `looks_ready` while listing issues is downgraded to `unsure`, since
 * the two halves of its answer disagree.
 */
export function finalizeVerdict(parsed) {
  const v = { ...parsed, issues: [...parsed.issues], claims: [] };
  if (v.overlay_text.length) {
    const { blocking } = checkSeoCopyFields({ overlay: v.overlay_text.join('\n') }, { surface: COMMERCIAL_SURFACE });
    v.claims = [...new Set(blocking.map((b) => b.match))];
    if (v.claims.length) {
      v.issues.push({ type: 'claim', detail: `image text makes a claim the creator brief forbids: ${v.claims.map((c) => `"${c}"`).join(', ')}` });
      v.verdict = 'needs_changes';
    }
  }
  // A "tag" issue (the image shows a sibling product, not the one tagged) is
  // information for Sean, not a defect in the creative.
  if (v.verdict === 'looks_ready' && v.issues.some((i) => i.type !== 'tag')) v.verdict = 'unsure';
  return v;
}
