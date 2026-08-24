// lib/voice-of-customer.js
//
// Pure brain for the voice-of-customer agent. No network, no filesystem, no
// LLM — everything here is deterministic and unit-tested so the agent shell
// stays thin. Mirrors the lib/seo-opportunities.js split.
//
// It also owns the health-claim safety of the persona artifacts it renders —
// see the "persona copy safety" section at the bottom. That import is
// deliberately from agents/ad-studio: health-claims.js is a pure, I/O-free
// policy module that imports nothing, exactly like agents/ad-studio/formats.js,
// which lib/ad-brief-plan.js already imports for the same reason. Importing it
// costs nothing and creates no cycle, so the gate stays in one place instead of
// being restated here.
//
// The same test admits the second import, clusterForText: pure, I/O-free, and
// the fleet's single answer to "which cluster is this product title?". Both are
// here so a rule lives in one place; neither breaks the no-I/O promise above.

import { findHealthClaims } from '../agents/ad-studio/health-claims.js';
// The canonical product-title → cluster helper, already applied to Shopify line
// item titles by lib/product-cluster-revenue.js. Zigpoll hands us the same kind
// of string, so it gets the same classifier rather than a second one. Pure, and
// it reaches assignCluster — the fleet's only cluster taxonomy — through the one
// wrapper that strips brand phrases first.
import { clusterForText } from './cluster-revenue.js';

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

/**
 * The clusters a Zigpoll response's order must touch to enter this corpus.
 *
 * This is `SKIN_CLUSTER_HANDLES` restated in the cluster vocabulary, because
 * Zigpoll records a product TITLE and never a handle — so `filterSkinCluster`,
 * which matches handles, cannot see them. Same split, same reason, as
 * `lib/demand-questions.js`'s `filterLeaksToSkinCluster`: free text needs
 * `assignCluster`, not a handle set.
 *
 * `coconut oil` is the generic-ingredient bucket `assignCluster` falls back to
 * and is included so a title naming only the ingredient is not dropped for
 * failing to say "lotion" or "soap".
 *
 * Note what this exclusion is NOT. Deodorant, lip balm and toothpaste are left
 * out because voice-of-customer is scoped to the skin cluster and always has
 * been — NOT because they earn nothing. Toothpaste in particular earns ($71.50
 * over 90 days as of 2026-08-23) and is no longer held; do not re-justify this
 * list on revenue, or it will drift the moment the revenue changes. Widening
 * voice-of-customer's scope is a separate decision that would also mean
 * widening SKIN_CLUSTER_HANDLES, the personas, and everything downstream of
 * them.
 */
export const ZIGPOLL_CLUSTERS = ['lotion', 'soap', 'coconut oil'];

const ZIGPOLL_CLUSTER_SET = new Set(ZIGPOLL_CLUSTERS);

/**
 * Is this response's order inside voice-of-customer's scope?
 *
 * `titles` is every line item on the order. A response counts as in-scope when
 * ANY line is — a buyer who bought lotion and toothpaste in one order is a
 * lotion buyer whose words belong here, and dropping the order because a second
 * product was out of scope would lose real evidence.
 *
 * An order with NO line items (an exit-intent or cart response, which has no
 * order at all) returns false: nothing says which cluster that visitor was
 * looking at, and letting unscoped records in would silently widen the corpus
 * past the personas' own scope. That is a real limitation rather than a
 * preference — those two surveys went live 2026-08-24 with zero responses, so
 * it costs nothing today. When they have volume, scope them by the landing page
 * in `metadata.url` instead of by an order they will never have.
 */
export function zigpollOrderInScope(titles) {
  return (titles || []).some((t) => ZIGPOLL_CLUSTER_SET.has(clusterForText(t)));
}

/**
 * A Zigpoll open-ended response as a corpus record.
 *
 * `handle` is null so `filterSkinCluster` passes it through — scope was already
 * decided by `zigpollOrderInScope` against the cluster vocabulary, exactly as
 * demand-miner filters leaks before `deriveSeeds` ever sees them. Callers MUST
 * apply that filter; this function does not, so that the scope decision and the
 * record shape stay separately testable.
 */
export function normalizeZigpollResponse(r, text) {
  const body = String(text || '').trim();
  return {
    source: 'zigpoll',
    id: `zigpoll:${r?._id || textKey(body)}`,
    url: null,
    handle: null,
    rating: null,
    text: body,
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
/**
 * Minimum mentions for a persona to be treated as real rather than noise.
 * Deliberately well below the 16-25 range the first live run produced, so it
 * only bites on a genuinely thin persona rather than being tuned to one corpus.
 */
export const MIN_PERSONA_EVIDENCE = 8;

/**
 * Rank personas: qualified first, then by emotional intensity.
 *
 * The two fields do different jobs. evidence_count answers "is this persona
 * real?" — and it is a corpus artifact, counting how often a theme appeared in
 * our own reviews, not how many such buyers exist. emotional_intensity answers
 * "which real persona should we lead with?", which is a judgment about the
 * buying decision and the better predictor of paid-social response.
 *
 * Multiplying them let a sampling artifact dominate: the most emotionally
 * charged persona in the first live run (9.2, with real before/after photos)
 * was pushed below a flatter one that happened to be mentioned seven more times.
 *
 * Nothing is dropped — under-evidenced personas sink below qualified ones so
 * personas[0] is always both real and the most intense, which is what
 * creative-packager reads as its default angle. Ties break on evidence_count so
 * the order is deterministic across runs.
 */
export function rankPersonas(personas) {
  const qualified = (p) => ((p.evidence_count || 0) >= MIN_PERSONA_EVIDENCE ? 1 : 0);
  return [...personas].sort((a, b) =>
    qualified(b) - qualified(a)
    || (b.emotional_intensity || 0) - (a.emotional_intensity || 0)
    || (b.evidence_count || 0) - (a.evidence_count || 0));
}

// ── persona copy safety ──────────────────────────────────────────────────────
//
// WHY THIS EXISTS. personas.json is not reference material — it is copy input.
// Four agents read it and every one of them projects persona and angle prose
// straight into an ad-copy prompt:
//
//   agents/ad-studio        persona.name + (angle.objection_addressed || angle.label)
//   agents/ad-brief         persona.name + angle.label/objection_addressed/proof
//   agents/creative-packager persona.name, persona.summary, angle.label,
//                           objection_addressed, proof, hook_examples
//
// Those strings are written by an LLM reading a corpus of real reviews, and real
// reviewers talk about eczema, psoriasis and the steroids their doctor gave them.
// The generated 2026-07-27 file put that language into EVERY copy-facing field of
// the top-ranked persona: `p1a1`'s label named prescriptions, its
// objection_addressed named steroids, its proof named eczema, and the persona's
// own name was "The Eczema-Exhausted Parent". `personas[0].angles[0]` is the
// documented DEFAULT angle, so the default creative brief was seeded with the
// exact language agents/ad-studio/health-claims.js exists to reject.
//
// That is the same shape of bug as the 2026-08-16 testimonial: the gate at the
// end caught it, but only after a paid copy call. selectQuotableReviews solved
// that for reviews by withholding claim-carrying quotes from the writer UP FRONT.
// This is the same withholding for personas, applied at BOTH ends — when the
// generator writes the file, and again when a consumer reads it, because the
// file is regenerated monthly and a bad month must not reach a copy prompt.
//
// WHAT IS AND IS NOT SCREENED. Only the fields that reach a copy model. In
// particular `source_quotes` is NEVER screened or altered: it is the evidence
// record, it must stay verbatim for findUnsourcedQuotes to keep working, and no
// consumer feeds it to a writer. The insight survives in the quotes even when
// the copy-facing paraphrase of it has to be re-worded.

/** Angle fields that are scalar prose and reach a copy prompt. */
export const ANGLE_COPY_FIELDS = ['label', 'objection_addressed', 'proof'];

/** Persona fields that reach a copy prompt ("Audience: <name> — <summary>"). */
export const PERSONA_COPY_FIELDS = ['name', 'summary'];

/**
 * Every health-claim hit in the copy-facing fields of one angle, hooks included.
 * Reporting shape — `field` names where it was found so a human (or a test
 * failure message) can go straight to it.
 *
 * @param {object} angle
 * @returns {{field:string, text:string, category:string, why:string, match:string}[]}
 */
export function findAngleHealthClaims(angle) {
  const hits = [];
  for (const field of ANGLE_COPY_FIELDS) {
    const text = angle?.[field];
    for (const hit of findHealthClaims(text)) hits.push({ field, text: String(text ?? ''), ...hit });
  }
  (angle?.hook_examples || []).forEach((hook, i) => {
    for (const hit of findHealthClaims(hook)) {
      hits.push({ field: `hook_examples[${i}]`, text: String(hook ?? ''), ...hit });
    }
  });
  return hits;
}

/** Every health-claim hit in a persona's own copy-facing fields (not its angles). */
export function findPersonaFieldHealthClaims(persona) {
  const hits = [];
  for (const field of PERSONA_COPY_FIELDS) {
    const text = persona?.[field];
    for (const hit of findHealthClaims(text)) hits.push({ field, text: String(text ?? ''), ...hit });
  }
  return hits;
}

/**
 * Sanitize one angle.
 *
 * The two field kinds get different treatment because the cost of removal
 * differs, not because the rule differs:
 *
 *   - `hook_examples` is a LIST of interchangeable suggestions. Dropping the one
 *     that says "steroids" costs nothing — the other two still direct the writer.
 *   - `label`, `objection_addressed` and `proof` are scalar and required. There is
 *     no partial version of them, so a violation makes the whole angle unusable
 *     as copy input. Passing it through with the offending clause snipped would
 *     be this module inventing research, which is worse than losing an angle.
 *
 * @returns {{angle: object|null, drops: object[]}} angle is null when unusable
 */
export function sanitizeAngle(angle) {
  const drops = [];
  const fieldHits = ANGLE_COPY_FIELDS.flatMap((field) =>
    findHealthClaims(angle?.[field]).map((hit) => ({ field, text: String(angle?.[field] ?? ''), ...hit }))
  );
  if (fieldHits.length) {
    return {
      angle: null,
      drops: fieldHits.map((h) => ({ action: 'dropped-angle', angleId: angle?.id ?? null, ...h })),
    };
  }

  const hooks = [];
  (angle?.hook_examples || []).forEach((hook, i) => {
    const hits = findHealthClaims(hook);
    if (!hits.length) { hooks.push(hook); return; }
    for (const hit of hits) {
      drops.push({ action: 'dropped-hook', angleId: angle?.id ?? null, field: `hook_examples[${i}]`, text: String(hook ?? ''), ...hit });
    }
  });

  if (!drops.length) return { angle, drops };
  return { angle: { ...angle, hook_examples: hooks }, drops };
}

/**
 * Sanitize one persona.
 *
 * A persona whose own name or summary carries a health claim is dropped whole —
 * "The Eczema-Exhausted Parent" cannot be handed to a copy writer as the audience
 * no matter how clean its angles are. So is a persona that HAD angles and has
 * none left after sanitizing, because a persona with no angle is not briefable.
 *
 * A persona that arrived with an empty angle list is passed through untouched:
 * that is a different defect with its own handling in creative-packager's
 * loadPersonas, and swallowing it here would hide it behind the wrong message.
 *
 * @returns {{persona: object|null, drops: object[]}}
 */
export function sanitizePersona(persona) {
  const personaId = persona?.id ?? null;
  const selfHits = findPersonaFieldHealthClaims(persona);
  if (selfHits.length) {
    return { persona: null, drops: selfHits.map((h) => ({ action: 'dropped-persona', personaId, angleId: null, ...h })) };
  }

  const hadAngles = Array.isArray(persona?.angles) && persona.angles.length > 0;
  if (!hadAngles) return { persona, drops: [] };

  const drops = [];
  const angles = [];
  for (const angle of persona.angles) {
    const res = sanitizeAngle(angle);
    for (const d of res.drops) drops.push({ personaId, ...d });
    if (res.angle) angles.push(res.angle);
  }

  if (!angles.length) {
    return {
      persona: null,
      drops: [
        ...drops,
        {
          action: 'dropped-persona', personaId, angleId: null, field: 'angles', text: '',
          category: 'derived', match: '', why: 'every angle carried a health claim, leaving nothing briefable',
        },
      ],
    };
  }

  if (!drops.length) return { persona, drops };
  return { persona: { ...persona, angles }, drops };
}

/**
 * Sanitize a persona list, preserving order.
 *
 * Order is the contract — personas[0].angles[0] is the default angle — so this
 * never reorders, it only removes. The surviving first entry IS the new default,
 * which is the "fall back to the next persona" behaviour every consumer needs.
 *
 * @param {object[]} personas
 * @returns {{personas: object[], drops: object[]}}
 */
export function sanitizePersonas(personas) {
  const out = [];
  const drops = [];
  for (const persona of personas || []) {
    const res = sanitizePersona(persona);
    drops.push(...res.drops);
    if (res.persona) out.push(res.persona);
  }
  return { personas: out, drops };
}

/** One line per drop, for a console warning or a notify body. */
export function formatPersonaDrops(drops) {
  return (drops || []).map((d) => {
    const where = [d.personaId, d.angleId, d.field].filter(Boolean).join('.');
    const what = d.match ? `"${d.match}" (${d.category})` : d.category;
    return `  ${d.action}: ${where} — ${what}: ${d.why}`;
  }).join('\n');
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
    '> Generated by `agents/voice-of-customer`. Ranked by emotional intensity, among personas with enough evidence to be real.',
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

// ── VOC markdown gate ─────────────────────────────────────────────────────────
//
// The generated voice-of-customer.md is not just a human document: BLOG_VOC_HEADINGS
// hands every section but `not_for` to agents/blog-post-writer, and
// agents/pdp-builder is handed the file WHOLE as `voiceOfCustomer`. Both write live
// storefront copy for a COSMETIC, and neither had a health-claims gate.
//
// On 2026-08-17 the file was found carrying the exact quote from the 2026-08-16
// incident — "I have tried prescription strength lotions, steroids, you name it...
// to no avail." — under "## Golden-nugget phrases", a section defined as customer
// language worth using in an ad VERBATIM.
//
// That a bullet is a real, correctly-sourced customer quote is not a defence: the
// FTC holds an advertiser responsible for what an endorsement CONVEYS, and the FDA
// treats testimonials as evidence of intended use, which is what turns a cosmetic
// into an unapproved drug. Same reasoning as selectQuotableReviews — withhold up
// front, because detection after the fact burns retries and, here, could ship.
//
// Bullets are dropped, never rewritten: editing a customer's words would make the
// quote no longer a quote. Headings always survive so the section contract that
// sliceVocSections depends on stays intact even when a section empties.

/** One markdown list item, including any wrapped continuation lines. */
function splitBullets(block) {
  const out = [];
  let cur = null;
  for (const line of block.split('\n')) {
    if (/^\s*[-*]\s+/.test(line)) {
      if (cur) out.push(cur);
      cur = { lines: [line] };
    } else if (cur && line.trim() && !line.startsWith('#')) {
      cur.lines.push(line);
    } else {
      if (cur) { out.push(cur); cur = null; }
      out.push({ raw: line });
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Strip health-claim-carrying bullets from a voice-of-customer markdown document.
 * Returns { markdown, dropped:[{text, reason}] }. Headings and clean bullets are
 * preserved byte-for-byte; a clean document comes back unchanged.
 */
export function sanitizeVocMarkdownWithReport(markdown) {
  if (!markdown || typeof markdown !== 'string') return { markdown: markdown || '', dropped: [] };
  const dropped = [];
  const kept = [];
  for (const item of splitBullets(markdown)) {
    if (item.raw !== undefined) { kept.push(item.raw); continue; }
    const text = item.lines.join('\n');
    const hits = findHealthClaims(text);
    if (hits.length) {
      dropped.push({
        text: text.replace(/^\s*[-*]\s+/, '').trim(),
        reason: `${hits[0].category}: "${hits[0].match}" — ${hits[0].why}`,
      });
      continue;
    }
    kept.push(text);
  }
  return { markdown: kept.join('\n'), dropped };
}

/** sanitizeVocMarkdownWithReport, markdown only. */
export function sanitizeVocMarkdown(markdown) {
  return sanitizeVocMarkdownWithReport(markdown).markdown;
}

/**
 * The copy-writer view of a voice-of-customer document.
 *
 * Every consumer that hands this file to an LLM that writes storefront copy must
 * go through here: agents/blog-post-writer (via sliceVocSections + BLOG_VOC_HEADINGS)
 * and agents/pdp-builder (which takes the file whole).
 *
 * Deliberately NOT applied to the file on disk. The research sections legitimately
 * discuss conditions — "CeraVe is the default recommendation for eczema" is
 * competitive intelligence, and stripping it from the stored document would destroy
 * analysis the generator paid to produce. The document stays complete for humans;
 * what reaches a copy model is gated.
 */
export function vocForCopy(markdown) {
  return sanitizeVocMarkdown(markdown);
}
