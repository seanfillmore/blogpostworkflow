// agents/ad-studio/flexible.js
//
// The 3-2-2 Flexible Ad — three plates, two primary texts, two headlines, assembled as
// ONE deliverable that goes into Ads Manager as a single ad.
//
// WHY THIS SHAPE. Twelve combinations (3 x 2 x 2) share a single learning pool, so every
// impression feeds one bucket instead of splitting signal across twelve ads that each
// accumulate too slowly to mean anything. That is the whole mechanism, and it is why the
// three plates must share ONE aspect ratio: mixing ratios asks Meta to answer two
// comparison questions at once — which creative, and which shape — on a budget that
// cannot separate one.
//
// The arithmetic is what makes this the right structure HERE rather than a preference.
// At $30/day and a modelled ~$2.50 per entry, splitting across three ad sets is ~28
// entries/ad set/week, under the ~50 Meta wants to exit the learning phase. Consolidated,
// it is ~84/week and learning can actually exit. See the tactic and its provenance in
// .claude/skills/marketing-paid-creative-testing/SKILL.md.
//
// WHAT THIS MODULE DOES NOT DO: it never creates, edits or launches anything on Meta. It
// writes a manifest a human carries into Ads Manager. Spend is a human decision.

// DEFAULT_OBJECTIVE is imported as well as re-exported below: `export ... from` creates no
// local binding, and buildFlexibleCopyPrompt uses it as a parameter default.
import { buildClaimRules, buildGiveawayBlock, DEFAULT_OBJECTIVE, giveawayIsCitable } from './copy.js';

/** The 3, the 2 and the 2. Named because "3" appears three times below and they are not the same 3. */
export const PLATE_COUNT = 3;
export const PRIMARY_TEXT_COUNT = 2;
export const HEADLINE_COUNT = 2;

/**
 * Meta's own limits. Enforced here rather than left to Ads Manager because a headline
 * truncated at 40 characters is not a shorter headline, it is a different one — and the
 * operator finds out after the ad is built.
 */
export const HEADLINE_MAX_CHARS = 40;
export const PRIMARY_TEXT_MAX_CHARS = 125;

/**
 * Flexible mode constrains an otherwise free-form run into the exact shape above, and
 * says WHY on each failure — the numbers are not arbitrary and an operator who reads only
 * the error should still understand what the mode is for.
 *
 * Pure and exported so the whole contract is testable without running main().
 *
 * @param {{formats: string[], targets: object[], variations: number}} args
 */
export function assertFlexibleArgs({ formats, targets, variations }) {
  if (formats.length !== PLATE_COUNT) {
    throw new Error(
      `ad-studio: --flexible needs exactly ${PLATE_COUNT} --formats (got ${formats.length}: ${formats.join(', ') || 'none'}). ` +
      `The three plates are three DISTINCT cold openings — a founder-voice angle, a problem angle, a proof angle — ` +
      `so no two ads chase the same person. Three variations of one format would be three ads competing for one buyer.`
    );
  }
  if (targets.length !== 1) {
    throw new Error(
      `ad-studio: --flexible needs exactly ONE target (got ${targets.length}: ` +
      `${targets.map(t => `${t.platform}=${t.ratio}`).join(', ') || 'none'}). ` +
      `All three plates share one aspect ratio — mixing ratios asks Meta to decide creative AND shape at once, ` +
      `which a $30/day budget cannot separate. Pass e.g. --targets meta=4:5.`
    );
  }
  if (targets[0].platform !== 'meta') {
    throw new Error(
      `ad-studio: --flexible is a Meta ad format; --targets named "${targets[0].platform}". ` +
      `Demand Gen has no flexible-ad equivalent. Pass --targets meta=1:1, meta=4:5 or meta=9:16.`
    );
  }
  if (variations !== 1) {
    throw new Error(
      `ad-studio: --flexible fixes --variations at 1 (got ${variations}). ` +
      `Each of the ${PLATE_COUNT} formats contributes exactly one plate; more variations would be more ads, ` +
      `which is the split this mode exists to avoid.`
    );
  }
}

/**
 * What the ad is FOR. Not decoration — it decides what the copy asks the reader to do, and
 * getting it wrong wastes the whole budget in a way no gate can catch.
 *
 * The first real run made exactly that mistake: the campaign optimises on `LEAD` (a
 * giveaway entry), and the copy sold the lotion. Meta would have been asked to find people
 * likely to enter a giveaway, using an ad that never mentioned one. The plates carried
 * giveaway CTAs — because a live giveaway is a citable source — while the primary text and
 * headline, which are the fields Meta actually renders, did not.
 *
 * ONLY HALF OF THAT WAS FIXED WHEN IT WAS FOUND, and the docstring above described the
 * unfixed half without anyone noticing. `--objective` was threaded into THIS module's
 * ad-level prompt and never into copy.js's plate prompt, so "the plates carried giveaway
 * CTAs ... while the primary text and headline did not" simply INVERTED: from 2026-08-25 a
 * `--objective sale` run wrote selling primary texts over three plates that still asked for
 * an entry. The vocabulary now lives in copy.js, which both prompts import — see the moved
 * block there for the measured case. Re-exported so every existing importer is unchanged.
 */
export { OBJECTIVES, DEFAULT_OBJECTIVE, assertObjective } from './copy.js';

function objectiveBrief(objective, giveaway) {
  if (objective !== 'entry') {
    // The `giveaway` argument was accepted and then ignored on this branch, which is the one
    // branch that needs it: mid-giveaway a bare "sell the product" is not a strong enough
    // instruction on its own. Naming the prohibition is what stops the primary text drifting
    // into "Enter free to win 36 bars".
    return `THE JOB OF THIS AD: sell the product. The reader should want to buy it.${giveaway ? `

A GIVEAWAY IS RUNNING, AND THIS AD IS NOT IT. The Official Rules are deliberately not shown
to you and "giveaway" is NOT a source you may cite. Neither primary text and neither headline
may mention a prize, a giveaway, an entry, a sweepstakes, a draw, "no purchase necessary", or
an entry deadline. The call to action is to BUY. A reader who finishes this copy wanting to
enter something has been sent to the wrong place.` : ''}`;
  }
  return `THE JOB OF THIS AD: get a GIVEAWAY ENTRY. Not a sale — an entry.

The campaign behind this ad optimises for the lead event that fires when someone enters, so
the copy has to ask for exactly that. Lead with the prize and make entering the obvious next
action. The product is the reason the prize is worth having, not the thing being sold here.

- Name the prize and the deadline. Both are in the Official Rules, citable as "giveaway".
- "No purchase necessary" is in the rules and is worth saying — it removes the main hesitation.
- The call to action is to ENTER, in both primary texts. A reader who finishes the copy
  wanting to buy a bottle has been sent to the wrong place.

Quote every date, quantity and prize detail from the OFFICIAL RULES text below, exactly as
it is written there. Do not restate a deadline in your own words and cite that — the gate
matches contiguous verbatim substrings against the rules, so a tidier phrasing is an
unsourced claim no matter how true it is.`;
}

/**
 * Ad-level copy is NOT plate copy. The plate carries no type at all — the operator sets
 * that in Photoshop — whereas primary text and headline are fields Meta renders itself,
 * above and below the image. They are written together, in one call, because the two texts
 * have to be genuinely different ANGLES rather than two phrasings of one idea: asking twice
 * independently reliably produces the latter, and then the shared pool has nothing to learn.
 */
export function buildFlexibleCopyPrompt({
  product, concepts, sourceIds, persona, pdpBody = '', reviews = [],
  objective = DEFAULT_OBJECTIVE, giveaway = null,
}) {
  // The SAME block the plate writer gets — verbatim Official Rules, prize framing and all —
  // and, since 2026-08-26, gated on the SAME predicate. It used to be unconditional, so
  // fixing the plate writer alone left this half still writing entry copy: a `--objective
  // sale` rebuild returned the primary text "Gentle enough for sensitive skin ... Enter free
  // to win 36 bars. Entries close September 14, 2026." That is the identical half-fix this
  // file's own OBJECTIVES docstring describes, committed a second time in the same week.
  // Whenever this predicate is consulted anywhere, it must be consulted everywhere.
  const citable = giveawayIsCitable(objective, giveaway);
  const giveawayBlock = citable ? buildGiveawayBlock(giveaway) : '';
  // Shown and citable move together — see giveawayIsCitable.
  const offeredSourceIds = (sourceIds || []).filter(id => id !== 'giveaway' || citable);
  const angles = concepts
    .map((c, i) => `  ${i + 1}. ${c.format.key} — ${c.format.name} (awareness: ${c.format.awareness})`)
    .join('\n');

  return `You are writing the AD-LEVEL copy for one Meta "flexible ad" for Real Skin Care.

${objectiveBrief(objective, giveaway)}

This is not copy that appears on the image. The three images carry no text at all. You are
writing the fields Meta renders around the image: the PRIMARY TEXT (above it) and the
HEADLINE (below it).

PRODUCT: ${product.title} (${product.handle}) — ${product.priceLabel}
${giveawayBlock}
THE THREE IMAGES THIS COPY RUNS AGAINST:
${angles}

PRODUCT PAGE COPY (a source you may cite as "pdp"):
${pdpBody}

${reviews.length ? `CUSTOMER REVIEWS (a source you may cite as "reviews") — real, verbatim, 4 and 5 star:
${reviews.slice(0, 6).map((r, i) => `  [${i + 1}] ${String(r).slice(0, 400)}`).join('\n')}
` : ''}
${persona ? `BUYER: ${persona.name}\nWHAT THEY ALREADY TRIED: ${(persona.angles || []).join('; ')}` : ''}

Write exactly ${PRIMARY_TEXT_COUNT} primary texts and exactly ${HEADLINE_COUNT} headlines.

THE HARD PART, AND THE POINT: the two primary texts must be two genuinely DIFFERENT
ANGLES, not two phrasings of one. Same for the headlines. Meta pairs every text with every
headline against every image and learns which combination works — if the two texts say the
same thing in different words, there is nothing to learn and the whole structure is wasted.
Two different angles means, for example, one that names the problem the buyer already
failed to solve and one that leads with what makes this different. Not "gentle care for dry
skin" and "dry skin deserves gentle care".

LENGTH: each headline ${HEADLINE_MAX_CHARS} characters or fewer, each primary text
${PRIMARY_TEXT_MAX_CHARS} characters or fewer. Meta truncates past that, and a truncated
headline is a different headline, not a shorter one.

RULES:
${buildClaimRules({ sourceIds: offeredSourceIds, unit: 'field' })}

Respond with JSON only, no commentary:
{
  "primaryTexts": ["...", "..."],
  "headlines": ["...", "..."],
  "claims": [
    { "zone": "primaryText1", "text": "...", "factual": true, "sourceId": "pdp", "evidence": "..." }
  ]
}
In claims, "zone" is one of: primaryText1, primaryText2, headline1, headline2.`;
}

/** Pull a JSON object out of a response that may be fenced or chatty. Mirrors copy.js. */
function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Validate hard. A flexible ad with three primary texts is not a flexible ad with a bonus
 * — it is a different structure than the one whose arithmetic justified the mode, and it
 * silently changes how many combinations share the pool.
 *
 * Identical strings are rejected for the same reason the prompt argues against them: two
 * copies of one angle mean the pool learns nothing, and this is the one failure the
 * operator cannot see by looking at the manifest, because both entries look fine alone.
 * Case and surrounding whitespace are ignored when comparing — "Dry skin?" and "dry skin?"
 * are one angle.
 *
 * @returns {{primaryTexts: string[], headlines: string[], claims: object[]}}
 */
export function parseFlexibleCopyResponse(raw) {
  const obj = extractJson(raw);
  if (!obj) throw new Error('ad-studio: flexible copy response was not JSON');

  const check = (key, want) => {
    const arr = obj[key];
    if (!Array.isArray(arr)) throw new Error(`ad-studio: flexible copy response missing "${key}" array`);
    if (arr.length !== want) {
      throw new Error(
        `ad-studio: flexible copy needs exactly ${want} ${key} (got ${arr.length}). ` +
        `The 3-2-2 shape is what makes twelve combinations share one learning pool; a different count is a different structure.`
      );
    }
    const clean = arr.map((s, i) => {
      if (typeof s !== 'string' || !s.trim()) {
        throw new Error(`ad-studio: ${key}[${i}] is empty — every field of a flexible ad has to carry copy`);
      }
      return s.trim();
    });
    const seen = new Set(clean.map(s => s.toLowerCase()));
    if (seen.size !== clean.length) {
      throw new Error(
        `ad-studio: the ${want} ${key} are not distinct. Two phrasings of one angle give the shared pool nothing to learn — ` +
        `that is the whole reason for writing two.`
      );
    }
    return clean;
  };

  const primaryTexts = check('primaryTexts', PRIMARY_TEXT_COUNT);
  const headlines = check('headlines', HEADLINE_COUNT);

  const tooLong = [
    ...headlines.filter(h => h.length > HEADLINE_MAX_CHARS).map(h => `headline ${h.length}/${HEADLINE_MAX_CHARS}: "${h}"`),
    ...primaryTexts.filter(t => t.length > PRIMARY_TEXT_MAX_CHARS).map(t => `primary text ${t.length}/${PRIMARY_TEXT_MAX_CHARS}: "${t}"`),
  ];
  if (tooLong.length) {
    throw new Error(`ad-studio: flexible copy exceeds Meta's field limits — Meta truncates, it does not wrap:\n  ${tooLong.join('\n  ')}`);
  }

  return { primaryTexts, headlines, claims: Array.isArray(obj.claims) ? obj.claims : [] };
}

/**
 * The zones object the two gates take. assertNoHealthClaims and assertClaimsSourced are
 * reused UNCHANGED from the plate path — ad-level copy is subject to exactly the same law,
 * and a second implementation would be a second thing to keep strict.
 */
export function flexibleZones({ primaryTexts, headlines }) {
  const zones = {};
  primaryTexts.forEach((t, i) => { zones[`primaryText${i + 1}`] = t; });
  headlines.forEach((h, i) => { zones[`headline${i + 1}`] = h; });
  return zones;
}

/**
 * The deliverable. JSON for anything downstream, Markdown because the person building
 * this in Ads Manager is reading it on a second monitor and typing.
 */
export function renderFlexibleManifest({ runId, product, variant, target, plates, primaryTexts, headlines, claims }) {
  const combinations = plates.length * primaryTexts.length * headlines.length;
  const json = {
    kind: 'flexible-ad',
    runId,
    product: { handle: product.handle, title: product.title, variant: variant || null },
    placement: { platform: target.platform, ratio: target.ratio },
    structure: { plates: plates.length, primaryTexts: primaryTexts.length, headlines: headlines.length, combinations },
    plates: plates.map(p => ({ format: p.format, file: p.file, verified: p.verified })),
    primaryTexts,
    headlines,
    claims,
  };

  const md = [
    `# Flexible ad — ${product.title}${variant ? ` (${variant})` : ''}`,
    '',
    `**Run:** \`${runId}\`  `,
    `**Placement:** ${target.platform} ${target.ratio} — all three plates share this ratio.  `,
    `**Structure:** ${plates.length} images × ${primaryTexts.length} primary texts × ${headlines.length} headlines = **${combinations} combinations sharing one learning pool.**`,
    '',
    '## Build it as ONE ad',
    '',
    'In Ads Manager, create a single ad and add all three images and both copy variants to it.',
    'Do not create three ads. Three ads split the data three ways, which is the failure this',
    'structure exists to avoid.',
    '',
    '## Images',
    '',
    ...plates.map((p, i) => (
      p.file
        ? `${i + 1}. \`${p.file}\` — ${p.format}${p.verified ? '' : '  ⚠️ did not pass verification — do not ship'}`
        : `${i + 1}. **no artifact produced** — ${p.format}  ⚠️ nothing rendered for this concept`
    )),
    '',
    '## Primary texts',
    '',
    ...primaryTexts.map((t, i) => `${i + 1}. ${t}  \n   _(${t.length}/${PRIMARY_TEXT_MAX_CHARS} chars)_`),
    '',
    '## Headlines',
    '',
    ...headlines.map((h, i) => `${i + 1}. ${h}  \n   _(${h.length}/${HEADLINE_MAX_CHARS} chars)_`),
    '',
    '## Reading it once it runs',
    '',
    'Judge the ad as a whole. There is no per-combination breakdown, and that is deliberate —',
    'the shared pool is what makes the allocation work. The only question is whether this ad',
    'is good enough to scale.',
    '',
    'If one combination visibly dominates — spend consolidating on it plus disproportionate',
    'comments — harvest it by copying its post ID into a separate ad rather than rebuilding it,',
    'and leave this ad running.',
    '',
    '## Claims',
    '',
    ...(claims.length
      ? claims.map(c => `- [${c.zone}] "${c.text}" — ${c.factual ? `sourced: ${c.sourceId} ("${c.evidence}")` : 'persuasion (not factual)'}`)
      : ['(none)']),
    '',
  ].join('\n');

  return { json, md };
}
