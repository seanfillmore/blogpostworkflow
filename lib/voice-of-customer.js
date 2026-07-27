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

export function normalizeTavilyResult(r) {
  const title = String(r.title || '').trim();
  const content = String(r.content || '').trim();
  const text = [title, content].filter(Boolean).join(' — ');
  const urlKey = canonicalUrl(r.url);
  return {
    source: 'reddit',
    id: `reddit:${urlKey || textKey(text)}`,
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
  return `- **${e.text}** — ${e.evidence_count} mentions. > "${e.quote}"`;
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
    lines.push(`\`${p.id}\` — ${p.evidence_count} mentions, emotional intensity ${p.emotional_intensity}`, '');
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
