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
// .claude/skills/marketing-paid-acquisition-scaling/SKILL.md.
//
// WHAT THIS MODULE DOES NOT DO: it never creates, edits or launches anything on Meta. It
// writes a manifest a human carries into Ads Manager. Spend is a human decision.

import { buildClaimRules } from './copy.js';

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
 * Ad-level copy is NOT plate copy. The plate carries no type at all — the operator sets
 * that in Photoshop — whereas primary text and headline are fields Meta renders itself,
 * above and below the image. They are written together, in one call, because the two
 * texts have to be genuinely different ANGLES rather than two phrasings of one idea:
 * asking twice independently reliably produces the latter, and then there is nothing for
 * the shared learning pool to learn.
 */
export function buildFlexibleCopyPrompt({ product, concepts, sourceIds, persona, giveawayBlock = '', pdpBody = '', reviews = [] }) {
  const angles = concepts
    .map((c, i) => `  ${i + 1}. ${c.format.key} — ${c.format.name} (awareness: ${c.format.awareness})`)
    .join('\n');

  return `You are writing the AD-LEVEL copy for one Meta "flexible ad" for Real Skin Care.

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
${buildClaimRules({ sourceIds, unit: 'field' })}

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
