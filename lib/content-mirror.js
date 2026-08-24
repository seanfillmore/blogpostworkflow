// lib/content-mirror.js
//
// `data/posts/<slug>/content.html` is the LOCAL MIRROR of a live Shopify
// article body. Four production paths republish from it — and every one of them
// pushes the local file over `body_html` without ever looking at what is
// already there:
//
//   scheduler.js:121        daily link-repair → `publisher --force`  (unattended)
//   agents/refresh-runner   content-refresher → `publisher`          (unattended)
//   agents/calendar-runner  first publish of a new post
//   pipeline.js             `publisher --draft`
//
// WHY THIS EXISTS
// ───────────────
// PR #645 noticed in passing that two of the five local files it was editing
// were not stale copies of their live article — they were *different, older
// articles*. Measured properly on 2026-08-23 against live Shopify (read-only,
// all 203 articles, 89 comparable posts) it is not two of five:
//
//   0   byte-identical
//   7   text-identical, markup-only drift          (cosmetic)
//   55  a real but recognisable edit apart         (divergent)
//   27  share under a quarter of their text        (DIFFERENT ARTICLE)
//
// 27 of 89. The scheduler's link-repair step is the live fuse: it repairs links
// in the local file and republishes it with `--force` for any post already on
// Shopify, daily, unattended. On any of those 27 that would replace a live,
// indexed, traffic-earning article with an older draft, and nothing anywhere
// would say so.
//
// WHAT THIS MODULE DOES, AND DELIBERATELY DOES NOT DO
// ───────────────────────────────────────────────────
// It REFUSES the republish. It does not resync, in either direction. A resync
// has to answer "is local stale, or is somebody drafting ahead?" and that
// question is not reliably answerable: on this corpus 80 of 82 divergent files
// were last touched by one bulk-import commit, the working tree is clean, and
// file mtimes under data/posts/ are checkout times rather than edit times (the
// same reason agents/blocked-post-resolver fingerprints an editor report
// instead of stat-ing it). So the tool that cannot tell must not be the tool
// that overwrites. Refusing costs a publish; guessing costs an article.
//
// THE MEASURE: BLOCK SIMILARITY, NOT SHINGLES
// ───────────────────────────────────────────
// Similarity is Dice over the SET OF TEXT BLOCKS — paragraphs, list items,
// headings, table cells — normalized to plain text. Word n-grams were tried
// first and are unusable here: at n=8 a genuinely-same article that had been
// lightly copy-edited scored 0.024, because a single changed word breaks eight
// overlapping grams. Blocks are the unit an edit actually operates on, and the
// score means something a human can check: "these two share 18 of their 20
// paragraphs".
//
// Blocks shorter than MIN_BLOCK_CHARS are dropped. Every post carries the same
// injected product CTA and the same boilerplate list stubs, and counting those
// lets two unrelated articles look related.
//
// THE THRESHOLDS ARE MEASURED, NOT PICKED
// ───────────────────────────────────────
//   0.221  the highest-scoring pair that is genuinely a different article
//   0.324  the next post up (a live article expanded to 84 blocks against a
//          52-block local copy — bad, but the same piece of content)
//   0.775  the DEEPEST legitimate rewrite on record: agents/content-refresher's
//          own queued drafts scored 0.775, 0.923, 0.932, 0.964 and 0.985
//          against the content.html they were generated from.
//
// DIFFERENT_ARTICLE_MAX = 0.25 therefore lands inside a real gap in the data
// (0.221 → 0.324) and three times below the deepest real refresh. It is not
// tuned to a knife's edge in either direction, and it is the only tier that
// blocks anything.
//
// DIVERGENT_WARN_MAX = 0.75 sits just under that deepest real refresh, so a
// legitimate refresh does not routinely warn, but a republish that quietly
// deletes a third of a live page does. A warn never blocks — blocking the
// 0.25–0.75 band would stop a legitimate deep refresh, and this project has
// already destroyed three paid-for briefs by letting a gate decide that work
// was worthless.
//
// Nothing here does I/O. `scripts/check-content-mirrors.mjs` owns the files and
// the Shopify reads; `agents/publisher` owns the gate's one call site.

/** Similarity at or below this is not an edit of the same article. */
export const DIFFERENT_ARTICLE_MAX = 0.25;

/** Below this a republish is loud but still allowed. */
export const DIVERGENT_WARN_MAX = 0.75;

/** Text blocks shorter than this are boilerplate, not content. */
export const MIN_BLOCK_CHARS = 40;

const BLOCK_TAGS = 'p|li|h[1-6]|blockquote|td|dd|figcaption';

/**
 * HTML → comparable plain text.
 *
 * Folds exactly the noise that is not content: tags, the entity spellings this
 * corpus actually uses, non-breaking spaces, and runs of whitespace. It does
 * NOT fold punctuation or case-sensitive meaning beyond lowercasing, because
 * over-normalizing here hides the divergence the module exists to find.
 */
export function normalizeText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&(?:#39|#8217|rsquo|lsquo|apos);/gi, "'")
    .replace(/&(?:quot|#8220|#8221|ldquo|rdquo);/gi, '"')
    .replace(/&(?:#8211|#8212|ndash|mdash);/gi, '-')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[ ‘’]/g, (c) => (c === ' ' ? ' ' : "'"))
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The set of substantive text blocks in a body.
 *
 * A Set, not a list: a duplicated paragraph is not extra evidence of sameness,
 * and Dice over sets is what makes "shares 18 of 20 paragraphs" true as stated.
 */
export function textBlocks(html) {
  const out = new Set();
  const re = new RegExp(`<(${BLOCK_TAGS})\\b[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    const t = normalizeText(m[2]);
    if (t.length >= MIN_BLOCK_CHARS) out.add(t);
  }
  return out;
}

const intersectionSize = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

const round4 = (n) => Math.round(n * 10000) / 10000;

/**
 * Compare a local mirror against a live body.
 *
 * @param {string} localHtml
 * @param {string} liveHtml
 * @returns {{
 *   identical: boolean, textIdentical: boolean,
 *   blockSimilarity: number, localCoverage: number, liveCoverage: number,
 *   localBlocks: number, liveBlocks: number, sharedBlocks: number,
 *   localOnlyBlocks: number, liveOnlyBlocks: number,
 *   direction: 'same'|'live-superset'|'local-superset'|'both-moved',
 *   tier: 'identical'|'cosmetic'|'divergent'|'different-article',
 * }}
 *
 * `liveOnlyBlocks` is the number the gate and the report both lead with: it is
 * literally how much of the live page a republish would delete. `direction` is
 * what answers "stale or ahead" as far as content alone can answer it —
 * `live-superset` means the live article contains everything local has and
 * more, which is stale and can never be somebody drafting.
 */
export function compareBodies(localHtml, liveHtml) {
  const local = String(localHtml ?? '');
  const live = String(liveHtml ?? '');
  const bl = textBlocks(local);
  const bv = textBlocks(live);
  const shared = intersectionSize(bl, bv);
  const localOnly = bl.size - shared;
  const liveOnly = bv.size - shared;

  const blockSimilarity = (bl.size === 0 && bv.size === 0) ? 1 : round4((2 * shared) / (bl.size + bv.size));
  const localCoverage = bl.size ? round4(shared / bl.size) : 1;
  const liveCoverage = bv.size ? round4(shared / bv.size) : 1;

  const identical = local === live;
  const textIdentical = identical || normalizeText(local) === normalizeText(live);

  const direction = localOnly === 0 && liveOnly === 0 ? 'same'
    : localOnly === 0 ? 'live-superset'
      : liveOnly === 0 ? 'local-superset'
        : 'both-moved';

  const tier = identical ? 'identical'
    : textIdentical ? 'cosmetic'
      : blockSimilarity <= DIFFERENT_ARTICLE_MAX ? 'different-article'
        : 'divergent';

  return {
    identical, textIdentical, blockSimilarity, localCoverage, liveCoverage,
    localBlocks: bl.size, liveBlocks: bv.size, sharedBlocks: shared,
    localOnlyBlocks: localOnly, liveOnlyBlocks: liveOnly,
    direction, tier,
  };
}

/**
 * May this republish proceed?
 *
 * @param {object} o
 * @param {string} o.localHtml            the body about to be pushed
 * @param {string|null} o.liveHtml        the body currently on Shopify
 * @param {boolean} o.liveReadable        false when the live fetch failed
 * @param {boolean} o.hasLiveArticle      false on a create — nothing to destroy
 * @param {boolean} [o.force]             the publisher's generic --force
 * @param {boolean} [o.allowDivergentMirror] this gate's own override
 * @returns {{ allow: boolean, severity: 'ok'|'warn'|'refuse'|'override', tier: string, reason: string, comparison: object|null }}
 *
 * `force` is accepted and DELIBERATELY IGNORED. `scheduler.js`'s daily
 * link-repair republish passes `--force` on every post already on Shopify, and
 * that is the exact unattended path that fires this hazard — a gate the routine
 * caller disarms is not a gate. The override is its own flag, typed by a human
 * who has looked at the diff.
 */
export function assessRepublish({
  localHtml,
  liveHtml,
  liveReadable,
  hasLiveArticle,
  force = false, // eslint-disable-line no-unused-vars -- see docstring: accepted, never honoured
  allowDivergentMirror = false,
} = {}) {
  if (!hasLiveArticle) {
    return { allow: true, severity: 'ok', tier: 'create', reason: 'new article — nothing to overwrite', comparison: null };
  }
  if (!liveReadable) {
    return {
      allow: false,
      severity: 'refuse',
      tier: 'unreadable',
      reason: 'the live article could not be read, so what this republish would overwrite is unknown — refusing, the same rule lib/post-lock.js applies to an unreadable lock',
      comparison: null,
    };
  }

  const live = String(liveHtml ?? '');
  const c = compareBodies(localHtml, live);

  if (c.liveBlocks === 0) {
    return { allow: true, severity: 'ok', tier: 'empty-live', reason: 'the live article has no substantive text blocks — nothing to lose', comparison: c };
  }

  if (c.tier === 'different-article') {
    const detail = `local and live share ${c.sharedBlocks} of ${c.localBlocks}/${c.liveBlocks} text blocks (similarity ${c.blockSimilarity}); publishing would delete ${c.liveOnlyBlocks} of ${c.liveBlocks} live blocks`;
    if (allowDivergentMirror) {
      return { allow: true, severity: 'override', tier: c.tier, reason: `OVERRIDDEN by --allow-divergent-mirror: ${detail}`, comparison: c };
    }
    return {
      allow: false,
      severity: 'refuse',
      tier: c.tier,
      reason: `the local content.html is a different article from what is live — ${detail}`,
      comparison: c,
    };
  }

  if (c.blockSimilarity < DIVERGENT_WARN_MAX) {
    return {
      allow: true,
      severity: 'warn',
      tier: c.tier,
      reason: `deep rewrite: this republish removes ${c.liveOnlyBlocks} of ${c.liveBlocks} live text blocks (similarity ${c.blockSimilarity}, direction ${c.direction})`,
      comparison: c,
    };
  }

  return {
    allow: true,
    severity: 'ok',
    tier: c.tier,
    reason: `${c.tier}: similarity ${c.blockSimilarity}, ${c.liveOnlyBlocks} live block(s) removed`,
    comparison: c,
  };
}
