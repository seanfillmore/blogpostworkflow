/**
 * What a blog article actually shows in a search result — and what a title or
 * description rewrite therefore has to write to reach it.
 *
 * `agents/meta-optimizer` wrote `article.title` and `summary_html` for its whole
 * life. Measured on 2026-09-21 against the live theme and 178 live articles:
 *
 *   - The rendered <title> is the `global.title_tag` metafield when set, else
 *     `article.title`. 159 of 178 articles carry a title_tag (minted by
 *     scripts/remediate-long-titles.mjs on 2026-09-06/07), so a title rewrite
 *     changed only the on-page H1 and never the SERP.
 *   - The rendered meta description is the `global.description_tag` metafield
 *     when set, else the start of the article BODY — never `summary_html`. Only
 *     35 articles carry one, so a description rewrite has never reached the SERP
 *     on any page.
 *
 * Every A/B test the CTR program ran therefore measured nothing, and the H1
 * churn put invented claims on live pages ("7 Picks" on pages with no list of
 * seven). Writing the two metafields is the only change that reaches the SERP,
 * and it leaves the on-page H1 and excerpt alone. Pure, so testable without
 * credentials.
 */

export const TITLE_TAG = 'title_tag';
export const DESCRIPTION_TAG = 'description_tag';

function tagValue(metafields, key) {
  const f = (Array.isArray(metafields) ? metafields : []).find((m) => m?.namespace === 'global' && m?.key === key);
  return f && typeof f.value === 'string' && f.value.trim() ? f.value : null;
}

export function bodyText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @returns {{title:string, description:string, titleTag:string|null, descriptionTag:string|null}}
 *   `description` without a tag approximates Shopify's body fallback (first
 *   ~160 characters), used only as the "before" copy shown to the writer.
 */
export function renderedSerp({ article, metafields }) {
  const titleTag = tagValue(metafields, TITLE_TAG);
  const descriptionTag = tagValue(metafields, DESCRIPTION_TAG);
  return {
    title: titleTag ?? (article?.title || ''),
    description: descriptionTag ?? bodyText(article?.body_html).slice(0, 160),
    titleTag,
    descriptionTag,
  };
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/**
 * Numbers in proposed copy that the article body does not contain. A count in a
 * title is a promise ("5 Recipes"); on 2026-09-21 the writer invented it on four
 * pages because the retry prompt suggested "a count" as a way to be different.
 * A four-digit year is exempt (the stale-year pass owns years), as is a
 * percentage. A number is supported when the body carries it as digits or as
 * its word.
 */
export function unsupportedNumbers(copy, html) {
  const body = bodyText(html).toLowerCase();
  const out = [];
  for (const m of String(copy || '').matchAll(/\b(\d{1,3})\b(?!\s*%)/g)) {
    const n = Number(m[1]);
    if (m[1].length === 4) continue;
    const asDigits = new RegExp(`(^|[^\\d])${n}([^\\d]|$)`).test(body);
    const asWord = NUMBER_WORDS[n] ? new RegExp(`\\b${NUMBER_WORDS[n]}\\b`).test(body) : false;
    if (!asDigits && !asWord && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * How to undo a SERP-field rewrite: restore each tag to its prior value, or
 * DELETE it where no tag was set before (so the page falls back exactly as it
 * did). Pure: returns the operations; the caller performs them.
 *
 * @param {{originalTitleTag?:string|null, originalDescriptionTag?:string|null}} entry
 * @param {Array<{id:number, namespace:string, key:string}>} currentMetafields
 * @returns {Array<{op:'set', key:string, value:string} | {op:'delete', key:string, id:number}>}
 */
export function serpRevertOps(entry, currentMetafields) {
  const ops = [];
  for (const [key, original] of [[TITLE_TAG, entry?.originalTitleTag], [DESCRIPTION_TAG, entry?.originalDescriptionTag]]) {
    if (original) { ops.push({ op: 'set', key, value: original }); continue; }
    const cur = (Array.isArray(currentMetafields) ? currentMetafields : []).find((m) => m?.namespace === 'global' && m?.key === key);
    if (cur?.id != null) ops.push({ op: 'delete', key, id: cur.id });
  }
  return ops;
}

/**
 * No em dashes in published copy (operator standing rule: it is the most
 * recognisable machine-writing tell). In a title a dash separates a keyword
 * from its qualifier, so it becomes a colon; in a description it becomes a
 * comma. An en dash used as a range ("2–3 weeks") is left alone.
 */
export function stripEmDashes(text, { kind = 'meta' } = {}) {
  const sep = kind === 'title' ? ': ' : ', ';
  return String(text || '')
    .replace(/\s*—\s*/g, sep)
    .replace(/\s+–\s+/g, sep)
    .replace(/:\s*:/g, ':')
    .replace(/,\s*,/g, ',')
    .trim();
}

/**
 * True when a proposed description is really the current one handed back —
 * identical, or opening with the same 40 characters. On 2026-09-21 the writer,
 * given a body-derived "before" ("Reviewed by the Real Skin Care editorial team
 * Making a natural moisturizer… like"), returned it verbatim and truncated;
 * writing that into description_tag would pin a cut-off sentence to the SERP.
 */
export function isEchoedDescription(proposed, current) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const p = norm(proposed); const c = norm(current);
  if (!p || !c) return false;
  return p === c || p.slice(0, 40) === c.slice(0, 40);
}

/** Handles named by `--pages a,b` (bare handles or full URLs). */
export function parsePagesArg(value) {
  return new Set(String(value || '').split(',').map((s) => s.trim().replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop()).filter(Boolean));
}
