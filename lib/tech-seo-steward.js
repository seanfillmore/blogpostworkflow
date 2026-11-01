/**
 * Pure decision logic for agents/tech-seo-steward — the agent that FINISHES
 * what the weekly DataForSEO crawl finds, instead of filing it in a review
 * queue nobody reads.
 *
 * Why it exists (2026-11-01): the crawl had detected the `what-is-natural-skincare`
 * 404, the scheme-less privacy-policy link and 31 long titles, and proposed the
 * correct redirect itself, but rated it MEDIUM and wrote it to
 * `data/reports/technical-seo/redirect-proposals.json`, which no agent, digest
 * or dashboard reads. Operator instruction: the fleet has the data to make
 * these calls, so it makes them.
 *
 * Nothing here does I/O. The agent injects Shopify, GSC and the model.
 */
import { renderTitle, LENGTH_LIMITS } from './seo-copy-length.js';

// ── Dead-link resolution ────────────────────────────────────────────────────

export function urlPath(u) {
  try { return new URL(u, 'https://www.realskincare.com').pathname.replace(/\/+$/, '') || '/'; }
  catch { return String(u || ''); }
}

export function pageType(path) {
  if (path.startsWith('/blogs/')) return 'article';
  if (path.startsWith('/products/') || /\/collections\/[^/]+\/products\//.test(path)) return 'product';
  if (path.startsWith('/collections/')) return 'collection';
  if (path.startsWith('/pages/')) return 'page';
  return 'other';
}

/** Where a dead URL of each type lands when nothing more specific fits. */
export const HUBS = Object.freeze({
  article: '/blogs/news',
  product: '/collections/all',
  collection: '/collections/all',
  page: '/',
  other: '/',
});

/**
 * Which crawled 404s the steward should resolve. A row is dropped when:
 *   - nothing links to it (no reader can reach it, so no redirect is owed),
 *   - a redirect already exists for the path (create-redirects or a human did it),
 *   - the path is LIVE now (the crawl is minutes-to-days old),
 *   - the path is a SCHEDULED or DRAFT article: it 404s today and goes live on
 *     its publish date. Redirecting it would hijack the article's own URL —
 *     `chlorophyll-deodorant-does-it-actually-work` was exactly this on
 *     2026-11-01: linked by 22 posts while scheduled, live the same afternoon.
 *   - the path is not on our site, or is a policy/system path a redirect cannot
 *     own (`/policies/…` is served by Shopify and is fixed at the link instead).
 */
export function selectDeadPaths(rows, { redirectPaths = new Set(), livePaths = new Set(), pendingPaths = new Set() } = {}) {
  const out = []; const seen = new Set(); const skipped = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const inlinks = Number.parseInt(r?.['no._of_all_inlinks'] ?? '0', 10) || 0;
    const path = urlPath(r?.url);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (inlinks <= 0) { skipped.push({ path, why: 'no inbound links' }); continue; }
    if (String(r?.url || '').includes('/cdn-cgi/')) { skipped.push({ path, why: 'Cloudflare false positive' }); continue; }
    if (path.startsWith('/policies/') || path.startsWith('/cdn-cgi/')) { skipped.push({ path, why: 'system path — fixed at the link, not by redirect' }); continue; }
    if (redirectPaths.has(path)) { skipped.push({ path, why: 'redirect already exists' }); continue; }
    if (livePaths.has(path)) { skipped.push({ path, why: 'live now' }); continue; }
    if (pendingPaths.has(path)) { skipped.push({ path, why: 'scheduled/draft article — goes live on its own' }); continue; }
    out.push({ path, inlinks, type: pageType(path) });
  }
  return { targets: out, skipped };
}

/**
 * The model chooses BY NUMBER from a closed list, so it can never invent a URL.
 * The list is every live destination of the dead path's type (plus related
 * types for products/collections) and the type's hub, so "no good match" is
 * always expressible as a real page rather than as a refusal.
 */
export function buildChoiceList(type, inventory) {
  const pick = {
    article: ['articles'],
    product: ['products', 'collections'],
    collection: ['collections', 'products'],
    page: ['pages'],
    other: ['articles', 'pages'],
  }[type] || ['articles'];
  const list = [];
  const seen = new Set();
  for (const k of pick) {
    for (const it of inventory?.[k] || []) {
      if (!it?.path || seen.has(it.path)) continue;
      seen.add(it.path);
      list.push({ path: it.path, title: it.title || '' });
    }
  }
  const hub = HUBS[type] || '/';
  if (!seen.has(hub)) list.push({ path: hub, title: '(section hub — use only when nothing specific fits)' });
  return list;
}

export function buildResolverPrompt({ path, anchors = [], sources = [] }, choices) {
  const lines = choices.map((c, i) => `[${i}] ${c.path} — ${c.title}`).join('\n');
  return [
    'A page on realskincare.com links to a URL that no longer exists. Choose the ONE live page a reader following that link should land on.',
    'Judge by what the dead URL and its link text promised the reader. Prefer the page that answers the same question; fall back to the section hub only when nothing specific fits.',
    '',
    `Dead URL: ${path}`,
    anchors.length ? `Link text used: ${anchors.slice(0, 5).map((a) => `"${a}"`).join(', ')}` : '',
    sources.length ? `Linked from: ${sources.slice(0, 5).join(', ')}` : '',
    '',
    'Live pages:',
    lines,
    '',
    'Reply with ONLY a JSON object: {"choice": <number>, "why": "<one short sentence>"}',
  ].filter((l) => l !== '').join('\n');
}

/** Parse the model's pick; null when it is not a valid index into `choices`. */
export function parseChoice(text, choices) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  const i = Number(obj?.choice);
  if (!Number.isInteger(i) || i < 0 || i >= choices.length) return null;
  return { path: choices[i].path, why: String(obj?.why || '').slice(0, 200) };
}

// ── Scheme-less external links ──────────────────────────────────────────────

// `href="www.allaboutcookies.org"` is resolved by browsers RELATIVE to the
// current page, so the privacy policy linked to
// /policies/www.allaboutcookies.org, a 404. Only a value that is plainly a
// hostname is touched: "www." prefix, or a bare host on a common TLD. A
// relative file name such as "guide.pdf" never matches.
const SCHEMELESS = /^(?:www\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|co|us|info))(?:[/?#][^\s"']*)?$/i;

export function fixSchemelessHrefs(html) {
  const fixed = [];
  const out = String(html ?? '').replace(/(<a\b[^>]*?\bhref=)(["'])([^"']*)\2/gi, (all, pre, q, val) => {
    const v = val.trim();
    if (!SCHEMELESS.test(v)) return all;
    fixed.push(v);
    return `${pre}${q}https://${v}${q}`;
  });
  return { html: out, fixed };
}

// ── Sitemap hygiene ─────────────────────────────────────────────────────────

/** Map a storefront URL to the Shopify resource that owns it. */
export function resourceForPath(path) {
  let m;
  if ((m = path.match(/^\/products\/([^/]+)$/))) return { resource: 'products', handle: m[1] };
  if ((m = path.match(/^\/collections\/([^/]+)$/))) return { resource: 'collections', handle: m[1] };
  if ((m = path.match(/^\/pages\/([^/]+)$/))) return { resource: 'pages', handle: m[1] };
  if ((m = path.match(/^\/blogs\/[^/]+\/([^/]+)$/))) return { resource: 'articles', handle: m[1] };
  return null;
}

export function parseRenderedPage(html) {
  const s = String(html || '');
  const robots = (s.match(/<meta[^>]+name=["']robots["'][^>]*>/gi) || []).join(' ');
  const desc = s.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ?? null;
  const title = s.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ?? null;
  return { noindex: /noindex/i.test(robots), metaDescription: desc == null ? null : decodeEntities(desc), title };
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”');
}

/**
 * An orphan page earns a sitemap slot only if somebody finds it. Hide it when
 * NOTHING links to it AND search sent it no impressions in 90 days — both,
 * because a page with search demand is worth linking to, not hiding. Pages
 * only: products and collections are reached through the catalogue and menus.
 */
export function shouldHideOrphan({ resource, inlinks, impressions90d }) {
  return resource === 'pages' && Number(inlinks) === 0 && impressions90d === 0;
}

// ── SERP copy validation ────────────────────────────────────────────────────

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'with', 'what', 'how', 'why', 'is', 'it', 'your', 'you', 'that', 'this', 'vs', 'best']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
/**
 * Every count in a string, as digits. Spelled-out counts are normalised
 * ("three-ingredient" → 3) because a model writing copy prefers words, and a
 * digits-only check let "six alternatives" through unverified. "one" is
 * skipped: it is a pronoun far more often than a count.
 */
export const numbersIn = (s) => {
  const text = String(s || '').toLowerCase();
  const out = text.match(/\d+/g) || [];
  for (const m of text.matchAll(/\b([a-z]+)\b/g)) {
    const i = NUMBER_WORDS.indexOf(m[1]);
    if (i > 1) out.push(String(i));
  }
  return out;
};

/**
 * The words a title RANKS on: everything before the first colon/dash, minus
 * stop words. A rewrite must keep all of them, in any order, so
 * "Ivory Soap Alternatives: …" may become "6 Natural Ivory Soap Alternatives"
 * but never "Gentle Bar Soaps That Clean".
 */
export function headKeywords(title) {
  const head = String(title || '').split(/\s*[:–—|]\s*|\s-\s/)[0];
  return words(head).filter((w) => !STOP.has(w));
}

/**
 * Validate a model-written replacement title against the title it replaces.
 * Returns a list of problems; empty means it may ship (the caller still runs
 * the health gate). Any number must already be in the source, because a count
 * the article does not contain is a claim — the "7 Picks" H1s of 2026-09 were
 * exactly that.
 */
export function titleRewriteProblems(proposed, source) {
  const p = String(proposed || '').trim();
  const problems = [];
  if (!p) return ['empty'];
  const rendered = renderTitle(p);
  if ([...rendered].length > LENGTH_LIMITS.title.max) problems.push(`renders at ${[...rendered].length} > ${LENGTH_LIMITS.title.max}`);
  const have = new Set(words(p));
  const missing = headKeywords(source).filter((w) => !have.has(w));
  if (missing.length) problems.push(`drops ranking words: ${missing.join(', ')}`);
  const srcNums = new Set(numbersIn(source));
  const invented = numbersIn(p).filter((n) => !srcNums.has(n));
  if (invented.length) problems.push(`invents numbers: ${invented.join(', ')}`);
  if (/[<>]|https?:\/\//.test(p)) problems.push('contains markup or a URL');
  return problems;
}

/** Same discipline for a description: fits, no invented numbers, no markup. */
export function descriptionProblems(proposed, source = '') {
  const p = String(proposed || '').trim();
  if (!p) return ['empty'];
  const problems = [];
  const n = [...p].length;
  if (n > LENGTH_LIMITS.description.max) problems.push(`${n} > ${LENGTH_LIMITS.description.max} characters`);
  if (n < 70) problems.push(`${n} < 70 characters`);
  const srcNums = new Set(numbersIn(source));
  const invented = numbersIn(p).filter((x) => !srcNums.has(x));
  if (invented.length) problems.push(`invents numbers: ${invented.join(', ')}`);
  if (/[<>]|https?:\/\//.test(p)) problems.push('contains markup or a URL');
  return problems;
}
