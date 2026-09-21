// lib/html-byline.js
//
// Best-effort author + publication extraction from a fetched article page.
// Pure (takes HTML in). Returns nulls rather than throwing — a missing author
// must never block a PR target (you can still "pitch the editor at <pub>").
//
// A BYLINE IS ONLY USEFUL IF IT NAMES A PERSON WE CAN EMAIL. The 2026-09-20
// audit of 13 live PR targets found the extractor happily returning a URL, a
// WordPress theme vendor's slug (`cultivatewp`), and a masthead ("Better Goods
// Team", with the only named human being a medical REVIEWER) in the `author`
// field. Those rows read as actionable in the report and are not. So the two
// predicates below sit between extraction and the returned `author`, and each
// records WHY it rejected a string rather than quietly nulling it — the report
// has to be able to say "this target has a team byline", which is a different
// finding from "we could not find a byline at all".

function clean(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').replace(/^by\s+/i, '').trim();
  return t ? t.slice(0, 80) : null;
}

// A pitchable byline is a human name. Four words is the ceiling: it covers
// "Mary Beth Van Horn" and "Natalie Arroyo Camacho" (both real bylines in the
// current report) while cutting the descriptive strings this extractor keeps
// picking up out of byline markup ("Written by our editorial staff in NYC").
export const MAX_AUTHOR_WORDS = 4;

// Strings that are structurally not a person's name. Returns a short reason
// code, or null when the string looks like a name. Deliberately shape-based —
// it never asks whether a specific human exists, only whether this string
// could be one.
export function nonPersonReason(author) {
  const a = author == null ? '' : String(author).trim();
  if (!a) return 'empty';
  // A URL in the author field. Observed live on marieclaire.com, thefiltery.com,
  // theguardian.com and organicbeautylover.com — some themes put the author
  // ARCHIVE link's href where the name should be, and one puts a facebook.com
  // profile URL there.
  if (/^(https?:)?\/\//i.test(a)) return 'url';
  if (/\b(?:https?:\/\/|www\.)/i.test(a)) return 'url';
  // Email BEFORE the bare-domain heuristic — an address contains a domain, and
  // the more specific reason is the one worth reporting.
  if (/\S+@\S+\.\S+/.test(a)) return 'email';
  if (/[a-z0-9-]+\.(?:com|org|net|co|io|uk|edu|gov|info|blog|shop)\b/i.test(a)) return 'url';
  // @handle, or a bare social handle with no spaces.
  if (/(^|\s)@\w/.test(a)) return 'social-handle';
  // Must contain letters at all — "2024", "—", "•" all turn up in byline slots.
  if (!/\p{L}/u.test(a)) return 'no-letters';
  const words = a.split(/\s+/).filter(Boolean);
  if (words.length > MAX_AUTHOR_WORDS) return 'too-long';
  // A single token is either a mononym or, far more often here, a slug:
  // `cultivatewp` (a WordPress theme vendor) is what thefiltery.com returns.
  // Either way it is not something a pitch can be addressed to.
  if (words.length < 2) return 'single-token';
  return null;
}

export function looksLikePersonName(author) {
  return nonPersonReason(author) === null;
}

// Words that make a byline a masthead rather than a person. Whole-word matched
// and kept narrow on purpose: surnames like Cook, Bishop and Marshall are real,
// so only nouns that cannot plausibly be a surname are listed.
const TEAM_WORDS = [
  'team', 'teams', 'staff', 'editor', 'editors', 'editorial', 'newsroom',
  'contributor', 'contributors', 'admin', 'administrator', 'guest',
  'writers', 'desk', 'bureau', 'correspondents',
];

// Organization nouns. A byline ending in one of these is an institution
// ("Cleveland Clinic", "Mayo Clinic", "BABOR GmbH").
const ORG_WORDS = [
  'clinic', 'hospital', 'institute', 'foundation', 'association', 'society',
  'university', 'college', 'laboratories', 'labs', 'inc', 'llc', 'ltd',
  'gmbh', 'corp', 'corporation', 'company', 'media', 'magazine', 'press',
  'publishing', 'agency', 'network', 'group', 'brands', 'reviewed', 'review',
  'reviews',
];

function normalizeForCompare(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Is this byline the OUTLET rather than a person at the outlet? Returns a
// reason code or null.
//
// The `domain`/`publication` comparison is the general rule and the team-word
// list is the backstop, not the other way round: "Dental Reviewed",
// "Better Goods Team", "BABOR Team" and "Cleveland Clinic" are all just their
// own site's name in the author slot, and matching that is far more durable
// than enumerating every brand that ever bylines itself.
export function teamBylineReason(author, { domain, publication } = {}) {
  const a = author == null ? '' : String(author).trim();
  if (!a) return null;
  const words = a.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some((w) => TEAM_WORDS.includes(w))) return 'team-byline';
  if (ORG_WORDS.includes(words[words.length - 1])) return 'organization';

  // The byline IS the site. Compare alphanumerics only, so "Better Goods"
  // matches bettergoods.org and "Dental Reviewed" matches dentalreviewed.com.
  //
  // EXACT equality, never a prefix: a prefix test flags "Lara Voss" on
  // laravoss.com, and a personal-brand blog is a GOOD pitch target. Exact
  // equality still catches that case and the residual is accepted knowingly —
  // pinned by a test — because the consequence is a demoted row carrying the
  // reason `matches-publication`, not a dropped one. Every byline in the
  // 2026-09-20 audit was already caught by the two word lists above; this rule
  // is the general backstop for the mastheads nobody has enumerated yet.
  const norm = normalizeForCompare(a);
  if (norm.length >= 4) {
    for (const candidate of [publication, domain]) {
      if (!candidate) continue;
      const host = normalizeForCompare(String(candidate).replace(/^www\./i, '').replace(/\.[a-z]{2,}$/i, ''));
      if (host.length >= 4 && host === norm) return 'matches-publication';
    }
  }
  return null;
}

export function isTeamByline(author, opts) {
  return teamBylineReason(author, opts) !== null;
}

// The single decision: given a raw extracted byline, is it pitchable?
// Returns { author, reason } — `author` null when rejected, `reason` naming
// which check rejected it so the report can SAY so instead of dropping it.
export function classifyByline(author, { domain, publication } = {}) {
  const raw = clean(author);
  if (!raw) return { author: null, reason: null };
  const team = teamBylineReason(raw, { domain, publication });
  if (team) return { author: null, reason: team };
  const shape = nonPersonReason(raw);
  if (shape) return { author: null, reason: shape };
  if (raw.length < 3) return { author: null, reason: 'too-short' };
  return { author: raw, reason: null };
}

export function extractByline(html, { domain } = {}) {
  let author = null;
  let publication = null;

  if (html) {
    // 1. <meta name="author"> / article:author
    const meta = html.match(/<meta[^>]+(?:name|property)=["'](?:author|article:author)["'][^>]+content=["']([^"']+)["']/i);
    if (meta) author = clean(meta[1]);

    // 2. JSON-LD author / publisher (most reliable when present)
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let json;
      try { json = JSON.parse(m[1].trim()); } catch { continue; }
      const nodes = Array.isArray(json) ? json : (json['@graph'] || [json]);
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        if (!author && n.author) {
          const a = typeof n.author === 'string'
            ? n.author
            : (Array.isArray(n.author) ? n.author[0]?.name : n.author.name);
          author = clean(a);
        }
        if (!publication && n.publisher?.name) publication = clean(n.publisher.name);
      }
    }

    // 3. og:site_name as publication fallback
    if (!publication) {
      const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
      if (og) publication = clean(og[1]);
    }

    // 4. rel="author" or a byline element as a last resort for author
    if (!author) {
      const rel = html.match(/rel=["']author["'][^>]*>\s*(?:by\s+)?([^<]{3,50})</i)
        || html.match(/class=["'][^"']*byline[^"']*["'][^>]*>\s*(?:by\s+)?([A-Z][^<]{2,40})</i);
      if (rel) author = clean(rel[1]);
    }
  }

  if (!publication && domain) publication = domain;
  const pub = publication || null;
  const { author: ok, reason } = classifyByline(author, { domain, publication: pub });
  // `author_raw` is kept even when rejected: a human reading the report needs to
  // see WHAT we found, or "no byline" and "a byline we refused" look identical.
  return { author: ok, publication: pub, author_raw: clean(author), author_rejected: reason };
}

// Does the fetched page already mention our brand? (If so, we're on it — lower
// priority / different angle.)
export function pageMentionsBrand(html, aliases = []) {
  if (!html || !aliases.length) return false;
  const lower = html.toLowerCase();
  return aliases.some((a) => lower.includes(String(a).toLowerCase()));
}

// Is this an ecommerce STORE (a single brand selling the category) rather than
// an editorial publication? Such sites get cited by LLMs but aren't pitch
// targets — they're competitors we don't track. Detect store platform markers /
// product-page signals without an editorial article signal.
export function looksLikeStore(html) {
  if (!html) return false;
  const lower = html.toLowerCase();
  const storeSignals = [
    'cdn.shopify.com', 'myshopify.com', 'woocommerce', 'bigcommerce',
    'add to cart', 'add-to-cart', '"@type":"product"', '"@type": "product"',
    'og:type" content="product', 'product:price', '/cart"', 'shopify-section',
  ];
  const hits = storeSignals.filter((s) => lower.includes(s)).length;
  // Editorial sites can have a shop link; require a couple of strong signals.
  return hits >= 2;
}
