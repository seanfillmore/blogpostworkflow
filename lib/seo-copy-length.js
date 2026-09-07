// lib/seo-copy-length.js
//
// "Will this meta description be TRUNCATED in the SERP?" — the fourth question
// asked of generated SEO copy, and the only one that is purely mechanical.
// (Titles are a measured, deliberate exclusion; see the section below.)
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
//
// Every SEO-copy prompt in this repo already states a length: meta-optimizer
// says "Title: 50–60 characters / Meta description: 140–155 characters", and
// product-optimizer repeats "140–155 chars" in five separate prompts. NOTHING
// CHECKED THE OUTPUT. The only length validator in the tree was
// agents/pdp-builder/lib/validators.js, which is PDP-only and never ran on the
// weekly meta rewrite.
//
// The cost is measurable and it is growing: Ahrefs Site Audit reported
// `Meta description too long` on **173 URLs (+5 in the week to 2026-09-06)` and
// `Title too long` on 66, while `agents/meta-optimizer` runs `--apply --limit 5`
// every Monday. A truncated description is a pure CTR leak — the page still
// ranks, the snippet just stops mid-sentence — which makes it exactly the kind
// of defect that never announces itself. It is also invisible to the CTR
// program, which measures a rewrite's effect without knowing whether the SERP
// ever showed the whole thing.
//
// ── THE THRESHOLD IS THE HARM BOUNDARY, NOT THE PROMPT'S TARGET ────────────────
//
// **160** is what Ahrefs Site Audit flags as "Meta description too long",
// verified against its documentation on 2026-09-06 rather than recalled. Google
// truncates on PIXEL width, not characters, so no character count can be exact —
// but the point of this gate is to stop the fleet generating copy that the
// site's own audit tool will report next week, and that means adopting the audit
// tool's boundary rather than inventing a second one.
//
// Measured live the same day, read-only across 215 articles / 23 products /
// 90 collections / 43 pages, 160 sits exactly in the tail rather than through
// the middle of the distribution:
//
//   description_tag          n=158  median 150  p75 157  p90 162  max 267
//                                   > 155: 31.6%   > 160: 10.8%   > 170: 4.4%
//   └ ARTICLE description_tag n=37  median 156  p75 164  p90 171  max 184
//                                   > 155: 51.4%   > 160: 32.4%   > 170: 13.5%
//   excerpt / summary_html   n=206  median 154  p75 161  p90 166  max 610
//                                   > 155: 43.2%   > 160: 26.7%   > 170: 5.8%
//
// So a gate at 160 leaves the median (150) and p75 (157) untouched and fires on
// roughly a tenth of the corpus — a third of the ARTICLE metas, which is the
// surface `agents/meta-optimizer` rewrites every Monday. A gate at 155 would
// fire on copy that is doing exactly what the prompt asked (140–155), burning a
// retry per page on an unattended cron for no SERP difference. **Do not tighten
// this to the prompt's number.**
//
// ── TITLES ARE MEASURED ON THE **RENDERED** TITLE, NOT THE AUTHORED ONE ────────
//
// A flat "title at most 60" is WRONG on this site and would certify titles that
// truncate. `layout/theme.liquid` (standard Dawn) renders:
//
//   <title>
//     {{ page_title }}
//     {%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}
//   </title>
//
// So ` – Real Skin Care` (17 characters) is appended **unless the title already
// contains the shop name** — a CONDITIONAL suffix, which is why a naive count of
// `title_tag` looks fine (n=122, median 40, p90 60, max 65) while Ahrefs reports
// `Title too long` on 66 URLs. Verified by fetching the live layout asset, not
// inferred.
//
//   title_tag  "SLS Free Toothpaste: Gentle Formulas That Actually Clean"   (55)
//   rendered   "SLS Free Toothpaste: … Actually Clean – Real Skin Care"     (72)
//
// `renderTitle` reproduces that Liquid exactly and the check measures its
// output, which is what Google truncates. **Liquid's `contains` is a
// case-SENSITIVE substring test**, so "real skin care" in lower case does NOT
// suppress the suffix — matching that behaviour is the whole point of mirroring
// the template rather than approximating it.
//
// The budget therefore has two shapes and the writer may use either:
//   - omit the brand      → at most 43 characters authored (43 + 17 = 60)
//   - include the brand   → at most 60 characters authored, no suffix appended
//
// **The prompt change is the load-bearing half of this.** Every prompt in the
// fleet asked for "50–60 characters" while the real budget was 43, so the
// instruction itself guaranteed truncation — gating without fixing the prompt
// would trip on nearly every generation and buy a second model call per page
// for nothing. Both had to land together.
//
// ── IT IS ADVISORY, AND NEVER BLOCKS A WRITE ───────────────────────────────────
//
// This follows agents/ad-studio/golden-thread.js, not lib/seo-copy-health-gate.js,
// and the difference is the consequence of being wrong. A health claim is a
// regulatory problem and refusing to publish it is strictly correct. A 163-
// character description is a truncated snippet — and REFUSING it leaves the OLD
// description live, which is usually worse, because the page was selected for a
// rewrite precisely because its current copy underperforms. Blocking here would
// let a cosmetic rule delete CTR work from an unattended run, the same
// false-positive class that permanently destroyed three paid-for briefs on
// 2026-08-19.
//
// So: one retry naming the exact overage, then SHIP whatever comes back and
// record the finding. It costs no extra model calls — it rides inside the two
// attempts `gateGeneratedCopy` already budgets.
//
// ── UNKNOWN KIND MEANS NO CHECK ────────────────────────────────────────────────
//
// `checkCopyLength` only measures a field whose kind the caller NAMED. A field
// with no declared kind is not measured, which is the same whitelist doctrine as
// lib/product-category-terms.js's PRODUCT_NOUNS: an unrecognised input can only
// ever produce a MISS, never a wrongly-rejected page. That matters because these
// callers pass things that legitimately have no length limit — a 450-650 word
// collection `body_html`, a product `body_html`, FAQ answers.

/**
 * Character ceilings, keyed by the KIND of copy rather than the field name,
 * because the same kind arrives under many names across the fleet
 * (`meta_description`, `seo_description`, `description_tag`, `meta`).
 */
/**
 * The storefront's shop name, which `layout/theme.liquid` appends to any title
 * that does not already contain it. Hardcoded here rather than read from
 * `config/site.json` so this module stays pure and importable with no I/O —
 * the same choice `lib/product-category-terms.js` makes for the brand tokens.
 * A test pins it against `config/site.json` so a rename cannot drift silently.
 */
export const SHOP_NAME = 'Real Skin Care';

/** The theme emits `&ndash;` — an EN DASH, one code point, with a space each side. */
export const TITLE_SEPARATOR = ' \u2013 ';

/** What the theme appends when the title omits the shop name: 17 characters. */
export const TITLE_SUFFIX = `${TITLE_SEPARATOR}${SHOP_NAME}`;

/**
 * Reproduce `layout/theme.liquid`'s title rule:
 *
 *   {{ page_title }}{%- unless page_title contains shop.name %} &ndash; {{ shop.name }}{% endunless -%}
 *
 * Liquid's `contains` is a case-SENSITIVE substring test, so this uses
 * `String.prototype.includes` and NOT a case-insensitive compare. Getting that
 * wrong would under-report: a title carrying "real skin care" in lower case
 * still gets the suffix on the live page.
 *
 * @param {string|null|undefined} authored
 * @param {string} [shopName]
 * @returns {string} the title as the browser and Google will see it
 */
export function renderTitle(authored, shopName = SHOP_NAME) {
  const t = String(authored ?? '').trim();
  if (!t) return t;
  return t.includes(shopName) ? t : `${t}${TITLE_SEPARATOR}${shopName}`;
}

export const LENGTH_LIMITS = Object.freeze({
  // Ahrefs Site Audit flags "Title too long" past 60, and Google truncates a
  // SERP title around the same width. Measured on the RENDERED title — see the
  // conditional-suffix section in the header.
  title: Object.freeze({ max: 60, label: 'title', render: renderTitle }),
  // Ahrefs Site Audit flags "Meta description too long" past 160.
  description: Object.freeze({ max: 160, label: 'meta description' }),
});

/** The kinds a caller may declare. Anything else is a programming error. */
export const LENGTH_KINDS = Object.freeze(Object.keys(LENGTH_LIMITS));

/**
 * Measure declared fields against their ceiling.
 *
 * @param {Record<string, string|undefined|null>} fields
 *        The same named-field map `checkSeoCopyFields` takes.
 * @param {Record<string, 'description'>} kinds
 *        field name → kind. A field absent from this map is NOT measured.
 * @returns {{ok: boolean, overlong: Array<{field:string, kind:string, length:number, max:number, over:number}>}}
 */
export function checkCopyLength(fields, kinds = {}) {
  const overlong = [];

  for (const [field, kind] of Object.entries(kinds)) {
    const limit = LENGTH_LIMITS[kind];
    if (!limit) throw new TypeError(`checkCopyLength: unknown kind "${kind}" for field "${field}" (expected one of ${LENGTH_KINDS.join(', ')})`);

    const raw = fields?.[field];
    if (raw == null) continue;
    // Trim first: trailing whitespace is not rendered in a SERP snippet, and
    // failing a description for a stray newline would be a pure false positive.
    const authored = String(raw).trim();
    if (!authored) continue;

    // A kind may declare a `render` step — the title does, because the theme
    // appends the shop name. Measuring the authored string there would certify
    // titles that truncate on the live page.
    const value = limit.render ? limit.render(authored) : authored;

    // Count by CODE POINT, not UTF-16 unit. `.length` counts an emoji or any
    // astral character as 2, which would over-report copy that renders as one
    // glyph. [...value] iterates code points.
    const length = [...value].length;
    const authoredLength = [...authored].length;
    if (length > limit.max) {
      overlong.push({
        field, kind, length, max: limit.max, over: length - limit.max,
        // Both are reported so a digest row can say WHY a 55-character title is
        // over a 60-character limit.
        authoredLength,
        rendered: length === authoredLength ? undefined : value,
      });
    }
  }

  return { ok: overlong.length === 0, overlong };
}

/**
 * Words a title must never END on after an automated trim. A cut that leaves
 * "Benefits, Ingredients &" or "Deodorant for" is technically a word boundary
 * and still reads as damage, which is the whole complaint about the shortener
 * this replaces.
 */
const DANGLING_TAIL = /(?:[\s|\u2013\u2014\u2010-\u2015:;,.&\-]+|\s+(?:and|or|for|the|to|with|of|in|on|at|a|an|by|from|vs|your|our|is|are|what|how|why|that|it))+$/iu;

/** Trim separators, punctuation and dangling connectives off the end of a trimmed title. */
function tidyTail(s) {
  let out = String(s ?? '').trim();
  for (let i = 0; i < 5; i++) {
    const next = out.replace(DANGLING_TAIL, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Shorten a title so its RENDERED form fits the limit — the repair counterpart
 * to `renderTitle`.
 *
 * ── THE BUG THIS REPLACES, because it is instructive ───────────────────────────
 *
 * `agents/technical-seo`'s `fix-titles` did this:
 *
 *   let t = current.slice(0, 57);
 *   if (lastSpace > 40) t = t.slice(0, lastSpace);
 *   if (!t.includes(BRAND)) t += ' | ' + BRAND;   // +17
 *   if (t.length > 60) t = t.slice(0, 60);        // hard cut, MID-BRAND
 *
 * Its input is the RENDERED title from a crawl export, so it already carried
 * ` – Real Skin Care`. The 57-cut removed the brand, the next line added it back,
 * and the last line guillotined the result at 60 — landing inside the brand. Two
 * live titles ended `… | R` and `… | | Real`. Worse, the mangled remnant no
 * longer contains the shop name, so `layout/theme.liquid` appended the FULL
 * suffix on top: `…for Dry Skin | R – Real Skin Care`, 77 characters. **The
 * repair made the page worse than the defect it was fixing.**
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────
 *
 * The brand costs its 17 characters whether we write it or the theme appends it,
 * so there is no version of this where the prose gets more than `max - 17`. This
 * strips any brand the input already carries, trims the remaining prose to that
 * budget ON A WORD BOUNDARY, and returns it WITHOUT re-adding the brand — the
 * theme does that, with its own en dash, which is what 96% of live pages already
 * look like. `renderTitle(shortenToRenderedLimit(x))` is <= max by construction,
 * and a test asserts exactly that over a corpus of real live titles.
 *
 * @param {string|null|undefined} title  may or may not already carry the brand
 * @returns {string}
 */
export function shortenToRenderedLimit(title, { max = LENGTH_LIMITS.title.max, shopName = SHOP_NAME } = {}) {
  const original = String(title ?? '').trim();
  if (!original) return original;
  if ([...renderTitle(original, shopName)].length <= max) return original;

  // Strip a brand the input already carries, plus whatever separator introduced
  // it, so trimming operates on prose and can never cut through the brand.
  let prose = original;
  const at = prose.indexOf(shopName);
  if (at !== -1) prose = prose.slice(0, at);
  prose = tidyTail(prose);

  // The theme will append ` – <shop>`; reserve exactly that.
  const budget = max - [...TITLE_SEPARATOR].length - [...shopName].length;
  if (budget <= 0) return prose; // degenerate config; never throw on a repair path

  const chars = [...prose];
  if (chars.length > budget) {
    let cut = chars.slice(0, budget).join('');
    // Prefer a word boundary, but only if it leaves a usable title — a title cut
    // to two words is worse than one cut a little late.
    const lastSpace = cut.lastIndexOf(' ');
    if (lastSpace >= Math.floor(budget * 0.6)) cut = cut.slice(0, lastSpace);
    prose = tidyTail(cut);
  }
  return prose;
}

/**
 * The sentence appended to the retry prompt. It names the field, the measured
 * length and the ceiling, because "shorten the meta description" is advice a
 * model can satisfy by removing four characters from a description that is
 * thirty over.
 *
 * @param {Array<{field:string, kind:string, length:number, max:number, over:number}>} overlong
 * @returns {string} '' when there is nothing to say, so a caller can concatenate blindly.
 */
export function lengthConstraint(overlong) {
  if (!overlong?.length) return '';

  const lines = overlong.map(({ field, kind, length, max, over, authoredLength, rendered }) => {
    const what = LENGTH_LIMITS[kind]?.label ?? kind;
    // A title over the limit only because of the appended shop name needs the
    // RULE explained, not just a number — otherwise the model trims a few
    // characters off an already-short title and is still over.
    if (kind === 'title' && rendered) {
      return `- The ${field} is ${authoredLength} characters as written, but the storefront renders it as `
        + `"${rendered}" — ${length} characters, ${over} over the ${max}-character limit. `
        + `The theme appends "${TITLE_SUFFIX}" to any title that does not already contain "${SHOP_NAME}". `
        + `So write at most ${max - [...TITLE_SUFFIX].length} characters WITHOUT the brand name, or at most ${max} characters WITH it. `
        + `Keep the target keyword.`;
    }
    return `- The ${field} (${what}) is ${length} characters, which is ${over} over the ${max}-character limit. Rewrite it to ${max} characters or fewer WITHOUT dropping the target keyword.`;
  });

  return [
    'LENGTH: the previous attempt would be truncated in search results.',
    ...lines,
    'Shorten by cutting filler, not by cutting the keyword or the specific detail that earns the click.',
  ].join('\n');
}

/**
 * One-line-per-finding rendering for a run report and the 5 AM digest body.
 * A finding that nobody can see becomes a mystery six weeks later — the same
 * reasoning as renderHoldLines() and renderEfficiencyLines().
 *
 * @param {Array<{page?:string, field:string, kind:string, length:number, max:number}>} findings
 * @returns {string[]}
 */
export function renderLengthLines(findings) {
  if (!findings?.length) return [];
  return [
    `⚠ ${findings.length} field(s) shipped OVER the SERP length limit after a retry — they will be truncated:`,
    ...findings.map((f) => `   · ${f.page ? `${f.page} — ` : ''}${f.field} ${f.length}/${f.max} chars`),
    '   These are advisory: the copy shipped because refusing it would leave the older, worse copy live.',
  ];
}

/** Goes in the FIRST prompt, so most runs never reach the retry. */
export const SEO_COPY_LENGTH_RULE = [
  'LENGTH LIMITS (hard) — count the characters before returning:',
  `- Title: at most ${LENGTH_LIMITS.title.max - [...TITLE_SUFFIX].length} characters. The storefront AUTOMATICALLY appends "${TITLE_SUFFIX}"`,
  `  to any title that does not already contain "${SHOP_NAME}", which brings it to ${LENGTH_LIMITS.title.max}.`,
  `  Do NOT write the brand name yourself unless you keep the whole title under ${LENGTH_LIMITS.title.max} characters including it.`,
  `- Meta description: at most ${LENGTH_LIMITS.description.max} characters.`,
  'Anything longer is truncated mid-sentence in Google results and the cut-off text is wasted.',
].join('\n');
