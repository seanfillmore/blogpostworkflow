// lib/voice-of-customer.js
//
// Pure brain for the voice-of-customer agent. No network, no filesystem, no
// LLM — everything here is deterministic and unit-tested so the agent shell
// stays thin. Mirrors the lib/seo-opportunities.js split.

/**
 * The skin cluster, as an explicit handle list rather than a keyword match.
 * A keyword match on "lotion"/"soap" would silently pull in or drop products
 * as the catalog changes; this list is asserted in tests.
 *
 * organic-foaming-hand-soap is deliberately included: it is a skin-contact
 * wash-off product whose reviewers share the sensitive-skin and
 * ingredient-scrutiny concerns of the lotion buyers.
 */
export const SKIN_CLUSTER_HANDLES = [
  'coconut-lotion',
  'body-lotion-1',
  'coconut-moisturizer',
  'coconut-soap',
  'organic-foaming-hand-soap',
];

const SKIN_SET = new Set(SKIN_CLUSTER_HANDLES);

/** Strip querystring + trailing slash so the same page from two sources matches. */
function canonicalUrl(url) {
  if (!url) return null;
  const withoutQuery = String(url).split(/[?#]/)[0];
  return withoutQuery.replace(/\/+$/, '').toLowerCase();
}

/** Generate a deterministic short key from text content for URL-less records. */
function textKey(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

export function normalizeJudgemeReview(r) {
  return {
    source: 'judgeme',
    id: `judgeme:${r.id}`,
    url: null,
    handle: r.product_handle || null,
    rating: typeof r.rating === 'number' ? r.rating : null,
    text: String(r.body || '').trim(),
  };
}

/**
 * Host of a URL, lowercased, without the leading `www.`. Regex rather than
 * `new URL` so a malformed href degrades to null instead of throwing.
 */
function urlHost(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url || '').trim());
  if (!m) return null;
  return m[1].split('@').pop().split(':')[0].toLowerCase().replace(/^www\./, '');
}

/**
 * A Tavily hit is only labelled `reddit` when it really is on reddit.com.
 * The query used to be scoped by literally prefixing "reddit" to the text,
 * which returned the Reddit Wikipedia page, the Reddit App Store listing and
 * YouTube videos — all labelled `reddit`, all weighted as forum friction by
 * the analysis prompt. Derive the label from the host instead.
 */
export function tavilySourceLabel(url) {
  const host = urlHost(url);
  if (!host) return 'web';
  return host === 'reddit.com' || host.endsWith('.reddit.com') ? 'reddit' : 'web';
}

export function normalizeTavilyResult(r) {
  const title = String(r.title || '').trim();
  const content = String(r.content || '').trim();
  const text = [title, content].filter(Boolean).join(' — ');
  const urlKey = canonicalUrl(r.url);
  const source = tavilySourceLabel(r.url);
  return {
    source,
    id: `${source}:${urlKey || textKey(text)}`,
    url: r.url || null,
    handle: null,
    rating: null,
    text,
  };
}

export function normalizeSerpItem(item) {
  const title = String(item.title || '').trim();
  const description = String(item.description || item.snippet || '').trim();
  const text = [title, description].filter(Boolean).join(' — ');
  const urlKey = canonicalUrl(item.url);
  return {
    source: 'serp',
    id: `serp:${urlKey || textKey(text)}`,
    url: item.url || null,
    handle: null,
    rating: null,
    text,
  };
}

/**
 * Collapse records that point at the same page. Judge.me reviews have no URL
 * and are keyed by their own id, so they never collapse into each other.
 */
export function dedupeRecords(records) {
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    const key = rec.url ? `url:${canonicalUrl(rec.url)}` : rec.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rec);
  }
  return out;
}

/**
 * Keep only skin-cluster material. Records with no handle are external
 * (Reddit/SERP) and are already scoped by the queries that fetched them.
 */
export function filterSkinCluster(records) {
  return records.filter((r) => r.handle === null || SKIN_SET.has(r.handle));
}

// ── analysis validation ──────────────────────────────────────────────────────

export const AWARENESS_LEVELS = [
  'unaware',
  'problem-aware',
  'solution-aware',
  'product-aware',
  'most-aware',
];

const VOC_SECTIONS = [
  { key: 'objections', heading: '## Objections' },
  { key: 'golden_nugget_phrases', heading: '## Golden-nugget phrases' },
  { key: 'trigger_points', heading: '## Trigger points' },
  { key: 'not_for', heading: "## Who we're not for" },
];

/**
 * The subset of voice-of-customer.md the blog-post-writer is allowed to see.
 *
 * "Who we're not for" is a disqualifier — useful to the ad and PDP consumers
 * that are choosing who to talk to, actively harmful to a blog post that
 * auto-publishes to the storefront. "Source notes" is provenance, not material.
 */
export const BLOG_VOC_HEADINGS = VOC_SECTIONS
  .filter((s) => s.key !== 'not_for')
  .map((s) => s.heading);

/**
 * Return only the requested `## ` sections of a voice-of-customer markdown doc,
 * in document order, heading included. Unknown headings contribute nothing.
 * Pure string surgery so consumers never hand-roll a regex over the heading
 * contract.
 */
export function sliceVocSections(markdown, headings) {
  if (!markdown || !Array.isArray(headings) || headings.length === 0) return '';
  const wanted = new Set(headings.map((h) => String(h).trim()));
  const out = [];
  let keeping = false;

  for (const line of String(markdown).split('\n')) {
    if (/^##\s/.test(line)) {
      keeping = wanted.has(line.trim());
      if (keeping) {
        if (out.length) out.push('');
        out.push(line.trim());
      }
      continue;
    }
    if (keeping) out.push(line);
  }

  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

/**
 * Semantic validation of the LLM's output. The API-level JSON schema already
 * guarantees the shape; this catches what a JSON schema cannot express here —
 * non-empty angle and quote arrays, and the awareness enum.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAnalysis(obj) {
  const errors = [];

  if (!obj || typeof obj !== 'object') {
    return { ok: false, errors: ['analysis is not an object'] };
  }

  if (!Array.isArray(obj.personas) || obj.personas.length === 0) {
    errors.push('analysis must contain at least one persona');
  } else {
    obj.personas.forEach((p, i) => {
      const where = `personas[${i}] (${p?.id || 'no id'})`;
      if (!p?.id) errors.push(`${where}: missing id`);
      if (!p?.name) errors.push(`${where}: missing name`);
      if (typeof p?.evidence_count !== 'number') errors.push(`${where}: evidence_count must be a number`);
      if (typeof p?.emotional_intensity !== 'number') errors.push(`${where}: emotional_intensity must be a number`);

      if (!Array.isArray(p?.angles) || p.angles.length === 0) {
        errors.push(`${where}: must have at least one angle`);
        return;
      }
      p.angles.forEach((a, j) => {
        const aWhere = `${where}.angles[${j}] (${a?.id || 'no id'})`;
        if (!a?.id) errors.push(`${aWhere}: missing id`);
        if (!AWARENESS_LEVELS.includes(a?.awareness)) {
          errors.push(`${aWhere}: awareness "${a?.awareness}" not in ${AWARENESS_LEVELS.join('|')}`);
        }
        if (!Array.isArray(a?.source_quotes) || a.source_quotes.length === 0) {
          errors.push(`${aWhere}: source_quotes must be non-empty`);
        }
      });
    });
  }

  for (const { key } of VOC_SECTIONS) {
    if (!Array.isArray(obj[key])) {
      errors.push(`${key} must be an array`);
      continue;
    }
    obj[key].forEach((e, i) => {
      if (!e?.text) errors.push(`${key}[${i}]: missing text`);
      if (!e?.quote) errors.push(`${key}[${i}]: missing quote`);
      if (typeof e?.evidence_count !== 'number') errors.push(`${key}[${i}]: evidence_count must be a number`);
    });
  }

  return { ok: errors.length === 0, errors };
}

// ── quote provenance ─────────────────────────────────────────────────────────
//
// "Nothing enters the file unsourced" is the central promise of this agent, and
// a prompt instruction is not a guarantee. These functions make it structural:
// every quote the model emits must actually appear in the corpus it was given.

/**
 * Fold away the differences that make an honest quote look invented: curly vs
 * straight apostrophes (the live corpus contains both), smart double quotes,
 * en/em dashes, runs of whitespace, and case.
 */
function normalizeQuoteText(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** How much of a quote must match verbatim for it to count as sourced. */
const QUOTE_FRAGMENT_CHARS = 60;

/**
 * Match on a leading fragment rather than the whole quote: trimming a trailing
 * clause is legitimate editing, inventing an opening is not.
 */
function leadingFragment(normalized) {
  if (normalized.length <= QUOTE_FRAGMENT_CHARS) return normalized;
  const cut = normalized.slice(0, QUOTE_FRAGMENT_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return lastSpace > QUOTE_FRAGMENT_CHARS / 3 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Every quote in the analysis that does not appear in any corpus record.
 * @param {object} analysis  the LLM output
 * @param {object|Array} corpus  the corpus object, or a bare records array
 * @returns {Array<{ quote: string, location: string }>} empty when all sourced
 */
export function findUnsourcedQuotes(analysis, corpus) {
  const records = Array.isArray(corpus) ? corpus : ((corpus && corpus.records) || []);
  const haystack = records.map((r) => normalizeQuoteText(r && r.text)).filter(Boolean);

  const unsourced = [];
  const check = (quote, location) => {
    const needle = leadingFragment(normalizeQuoteText(quote));
    // An empty quote is validateAnalysis's finding to report, not this one's.
    if (!needle) return;
    if (!haystack.some((t) => t.includes(needle))) unsourced.push({ quote: String(quote), location });
  };

  (analysis?.personas || []).forEach((p, i) => {
    (p?.angles || []).forEach((a, j) => {
      (a?.source_quotes || []).forEach((q, k) => {
        check(q, `personas[${i}](${p?.id || 'no id'}).angles[${j}](${a?.id || 'no id'}).source_quotes[${k}]`);
      });
    });
  });

  for (const { key } of VOC_SECTIONS) {
    (analysis?.[key] || []).forEach((e, i) => check(e?.quote, `${key}[${i}]`));
  }

  return unsourced;
}

/**
 * Rank by volume AND emotional intensity, highest first. A persona appearing
 * in 12 reviews with intense language outranks one appearing in 40 flat ones.
 * Order is part of the personas.json contract — creative-packager reads
 * personas[0].angles[0] as its default.
 */
export function rankPersonas(personas) {
  const score = (p) => (p.evidence_count || 0) * (p.emotional_intensity || 0);
  return [...personas].sort((a, b) => score(b) - score(a));
}

// ── markdown rendering ───────────────────────────────────────────────────────
//
// Two constraints are binding here and are asserted in tests:
//   1. Heading text never changes between runs, so grep-based lookups keep working.
//   2. Every entry is self-contained — a single grep hit is useful on its own.

function renderEntry(e) {
  const n = e.evidence_count;
  return `- **${e.text}** — ${n} ${n === 1 ? 'mention' : 'mentions'}. > "${e.quote}"`;
}

export function renderVoiceOfCustomerMarkdown(analysis, { partial = false } = {}) {
  const lines = [
    '# Voice of Customer — skin cluster',
    '',
    '> Generated by `agents/voice-of-customer`. Do not hand-edit — rerun the agent.',
    '',
  ];

  for (const { key, heading } of VOC_SECTIONS) {
    lines.push(heading, '');
    const entries = analysis[key] || [];
    if (entries.length === 0) lines.push('_None found in this corpus._');
    else entries.forEach((e) => lines.push(renderEntry(e)));
    lines.push('');
  }

  lines.push('## Source notes', '');
  lines.push('- Judge.me reviews for the skin cluster, Reddit via Tavily, Google page-1 via DataForSEO.');
  if (partial) {
    lines.push('- **Partial corpus: generated without external friction data.** Reddit and/or SERP collection failed on this run, so the objections section reflects our own reviews only and understates friction.');
  }
  lines.push('');

  return lines.join('\n');
}

export function renderPersonasMarkdown(analysis) {
  const lines = [
    '# Personas — skin cluster',
    '',
    '> Generated by `agents/voice-of-customer`. Ranked by evidence volume and emotional intensity.',
    '',
  ];

  rankPersonas(analysis.personas || []).forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.name}`, '');
    const n = p.evidence_count;
    lines.push(`\`${p.id}\` — ${n} ${n === 1 ? 'mention' : 'mentions'}, emotional intensity ${p.emotional_intensity}`, '');
    lines.push(p.summary || '', '');
    (p.angles || []).forEach((a) => {
      lines.push(`### Angle: ${a.label}`, '');
      lines.push(`- \`${a.id}\` · awareness: **${a.awareness}**`);
      lines.push(`- Objection addressed: ${a.objection_addressed}`);
      lines.push(`- Proof: ${a.proof}`);
      (a.hook_examples || []).forEach((h) => lines.push(`- Hook: "${h}"`));
      (a.source_quotes || []).forEach((q) => lines.push(`- Source: > "${q}"`));
      lines.push('');
    });
  });

  return lines.join('\n');
}
