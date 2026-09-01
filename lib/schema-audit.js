/**
 * Structured-data coverage audit — pure logic, no I/O.
 *
 * Answers one question for a piece of HTML: which schema.org types does this page
 * actually publish to a crawler? The caller supplies the HTML (a Shopify article's
 * body_html, or a live rendered page fetched over HTTP) and gets back a record.
 *
 * Two things a naive grep for '"@type":"FAQPage"' gets wrong, and this does not:
 *
 *   1. Types nest. Real pages put them in @graph, in top-level arrays, and inside
 *      properties (AggregateRating inside Product, Question inside FAQPage). A
 *      top-level read undercounts what Google actually sees, so we walk the tree.
 *
 *   2. A JSON-LD block that does not parse publishes NOTHING. Counting it as
 *      coverage would report a page as protected when it is not, so invalid blocks
 *      are counted separately and contribute no types.
 *
 * Deliberately measures presence, not validity-against-Google's-required-fields.
 * "Has a Product node" is not "is eligible for a rich result" — eligibility depends
 * on required properties and on Google's current policy for that type, which is a
 * judgement made outside this module.
 */

/** The types this audit reports on: the ones with a plausible SERP appearance for this catalogue. */
export const TRACKED_TYPES = Object.freeze([
  'FAQPage',
  'Article',
  'Product',
  'BreadcrumbList',
  'AggregateRating',
  'Review',
  'HowTo',
]);

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LDJSON_ATTR_RE = /type\s*=\s*['"]?application\/ld\+json['"]?/i;

/**
 * Pull every application/ld+json block out of an HTML string and parse it.
 * @returns {{ blocks: any[], invalid: number }} parsed blocks, and how many failed to parse.
 */
export function extractJsonLdBlocks(html) {
  const blocks = [];
  let invalid = 0;
  if (typeof html !== 'string' || html.length === 0) return { blocks, invalid };

  SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (!LDJSON_ATTR_RE.test(attrs)) continue;

    let body = (m[2] || '').trim();
    // Some themes wrap the payload in a CDATA guard.
    body = body
      .replace(/^\s*(?:\/\/)?\s*<!\[CDATA\[/i, '')
      .replace(/(?:\/\/)?\s*\]\]>\s*$/i, '')
      .trim();

    if (!body) continue;
    try {
      blocks.push(JSON.parse(body));
    } catch {
      invalid += 1;
    }
  }
  return { blocks, invalid };
}

/** Recursively collect every @type string reachable from the parsed blocks. */
export function collectSchemaTypes(blocks) {
  const types = new Set();
  const seen = new Set();

  const walk = (node) => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    const t = node['@type'];
    if (typeof t === 'string') types.add(t);
    else if (Array.isArray(t)) for (const v of t) if (typeof v === 'string') types.add(v);

    for (const [key, value] of Object.entries(node)) {
      if (key === '@type' || key === '@context') continue;
      walk(value);
    }
  };

  walk(blocks);
  return types;
}

/** Count Question nodes under any FAQPage node, so a one-question FAQ is visible as thin. */
function countFaqQuestions(blocks) {
  let count = 0;
  const seen = new Set();
  const walk = (node, insideFaq) => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, insideFaq);
      return;
    }
    const t = node['@type'];
    const typeList = Array.isArray(t) ? t : typeof t === 'string' ? [t] : [];
    const nowInsideFaq = insideFaq || typeList.includes('FAQPage');
    if (nowInsideFaq && typeList.includes('Question')) count += 1;
    for (const [key, value] of Object.entries(node)) {
      if (key === '@type' || key === '@context') continue;
      walk(value, nowInsideFaq);
    }
  };
  walk(blocks, false);
  return count;
}

/**
 * Audit one HTML document.
 * @returns {{ blockCount, invalidBlocks, allTypes, has, faqQuestionCount, bare }}
 *   bare === true means the document publishes no parseable structured data at all.
 */
export function auditHtml(html) {
  const { blocks, invalid } = extractJsonLdBlocks(html);
  const types = collectSchemaTypes(blocks);
  const has = {};
  for (const t of TRACKED_TYPES) has[t] = types.has(t);
  return {
    blockCount: blocks.length,
    invalidBlocks: invalid,
    allTypes: [...types].sort(),
    has,
    faqQuestionCount: countFaqQuestions(blocks),
    bare: types.size === 0,
  };
}

/** Roll a set of audit records into per-type counts. */
export function summarizeCoverage(records) {
  const byType = {};
  for (const t of TRACKED_TYPES) byType[t] = 0;
  let bare = 0;
  for (const r of records) {
    for (const t of TRACKED_TYPES) if (r.has?.[t]) byType[t] += 1;
    if (r.bare) bare += 1;
  }
  return { total: records.length, byType, bare };
}
