/**
 * Theme-template claim integrity — the pure half.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────────
 * `lib/supply-duration.js`'s assertDurationClaim guards BUNDLE copy. Nothing
 * guards a theme template, and on 2026-09-05 an audit of all 8 landing pages
 * found FOUR overstated supply claims live — cream and the sensitive-skin set at
 * 2.80x, lotion at 1.87x, toothpaste at 1.24x — plus two pages claiming a
 * duration for products that had no measured rate at all. They had been live for
 * months. The same audit found `coconut-soap` pointing at a templateSuffix whose
 * asset was NOT on the theme: Shopify falls back to the default product template
 * silently, so the page returned 200 while serving a different page entirely.
 *
 * Both are the same failure shape: something plausible is substituted for a
 * missing value instead of failing loudly. This module is the detector.
 *
 * Pure — no network, no fs — so every branch is a case a test constructs.
 */

/** Word-number and unit vocabulary a claim can be written in. */
const WORD_NUMBERS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12 };
const UNIT_DAYS = { day: 1, days: 1, week: 7, weeks: 7, month: 30, months: 30, year: 365, years: 365 };

/**
 * Pull a supply claim out of rendered-ish copy.
 * Returns { days, perDay, text } or null when the copy makes no duration claim.
 *
 * `perDay` matters as much as `days`: the lotion defect was "8 weeks" stated
 * against "$0.40 per day", which implies 75 days on a $30 product. TWO numbers,
 * and a claim is only coherent when they agree.
 */
export function parseDurationClaim(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/lasts?\s+(?:about\s+|around\s+|roughly\s+)?([a-z]+|\d+)\s*(day|days|week|weeks|month|months|year|years)\b/i);
  if (!m) return null;
  const rawN = m[1].toLowerCase();
  const n = /^\d+$/.test(rawN) ? Number(rawN) : WORD_NUMBERS[rawN];
  if (!n) return null;
  const days = n * UNIT_DAYS[m[2].toLowerCase()];
  const pd = text.match(/\$\s*(\d+(?:\.\d+)?)\s*(?:per day|a day|\/\s*day)/i);
  return { days, perDay: pd ? Number(pd[1]) : null, text: text.trim() };
}

/**
 * Judge one claim against the measured rate.
 *
 * TOLERANCE IS ASYMMETRIC, deliberately. config/consumption-rates.json states the
 * error is asymmetric — overstating supply costs the customer and is the
 * documented reason RSC subscribers churned — so claiming SHORT is always fine
 * and claiming long is flagged past a small rounding allowance. "about a month"
 * for a 30-day rate must not fire, so the allowance is not zero.
 */
export const OVERSTATEMENT_TOLERANCE = 1.15;

export function auditClaim({ claim, rateDays, price }) {
  if (!claim) return { verdict: 'no-claim' };
  if (rateDays == null) {
    return { verdict: 'unevidenced', claimedDays: claim.days,
      detail: 'the product has no entry in consumption-rates.json, so no duration claim is supported in either direction' };
  }
  const ratio = claim.days / rateDays;
  const out = { claimedDays: claim.days, rateDays, ratio: Number(ratio.toFixed(2)) };

  if (ratio > OVERSTATEMENT_TOLERANCE) {
    return { ...out, verdict: 'overstates',
      detail: `claims ${claim.days} d against a measured ${rateDays} d (${ratio.toFixed(2)}x)` };
  }
  // Both numbers must describe the same span. This is the defect that shipped on
  // lotion and that a first fix pass reintroduced on toothpaste.
  if (claim.perDay && price) {
    const impliedDays = price / claim.perDay;
    const skew = impliedDays / claim.days;
    if (skew > OVERSTATEMENT_TOLERANCE || skew < 1 / OVERSTATEMENT_TOLERANCE) {
      return { ...out, verdict: 'incoherent', impliedDays: Math.round(impliedDays),
        detail: `states ${claim.days} d but $${claim.perDay}/day on a $${price} product implies ${Math.round(impliedDays)} d` };
    }
  }
  return { ...out, verdict: 'ok' };
}

/**
 * Liquid comments are documentation, not copy. The bar-soap template explains its
 * own arithmetic inside `{% comment %}` — including a per-day figure from an older
 * price — and the gate's first live run pulled the duration from the rendered line
 * and the price from the comment, then reported the mismatch as a defect. Strip
 * comments before anything reads the text.
 */
export function stripLiquidComments(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

/**
 * A template can hold Liquid that picks copy per product — landing-page-liquid-soap
 * serves both an 8oz bottle and a 32oz refill from one branched line. A static
 * reader sees BOTH branches, so judging the whole string against one product
 * reports the other product's copy as that product's defect. Return only the
 * branch that renders for `handle`.
 *
 * Deliberately narrow: it understands `{% if product.handle == '...' %}` and
 * nothing else. Anything more elaborate is returned untouched, which risks a
 * false positive — and a false positive on this gate is loud and checkable,
 * whereas silently skipping every conditional string would hide real defects.
 */
export function branchForHandle(text, handle) {
  if (typeof text !== 'string' || !/\{%-?\s*if\s+product\.handle/.test(text)) return text;
  const re = /\{%-?\s*if\s+product\.handle\s*==\s*['"]([^'"]+)['"]\s*-?%\}([\s\S]*?)(?:\{%-?\s*else\s*-?%\}([\s\S]*?))?\{%-?\s*endif\s*-?%\}/g;
  return text.replace(re, (_m, h, ifBody, elseBody = '') => (h === handle ? ifBody : elseBody));
}

/**
 * Products whose templateSuffix names an asset the theme does not have.
 * Shopify serves the DEFAULT template in that case and still returns 200.
 */
export function findMissingTemplates(products, assetKeys) {
  const have = new Set(assetKeys);
  const missing = [];
  for (const p of products) {
    if (!p.templateSuffix) continue;
    if (String(p.status).toUpperCase() !== 'ACTIVE') continue; // a draft product serves nobody
    const key = `templates/product.${p.templateSuffix}.json`;
    if (!have.has(key)) missing.push({ handle: p.handle, templateSuffix: p.templateSuffix, expected: key });
  }
  return missing;
}

/** Roll findings into the exit code the cron wrapper reports on. */
/**
 * Is the og:image fallback still on the theme?
 *
 * WHY THIS IS A DRIFT CHECK AND NOT A ONE-OFF FIX
 *
 * `snippets/meta-tags.liquid` gates og:image on `page_image`, which Shopify
 * populates only for a product, an article, or a collection that has an image.
 * The homepage, /pages/*, the blog index and every imageless collection emitted
 * NO og:image at all — 46 URLs on the 2026-09-20 Ahrefs crawl — so a shared
 * link rendered with no preview. The fix adds a `settings.share_image`
 * fallback.
 *
 * All three files it touches (the snippet plus both config files) are STOCK
 * theme files, and this theme's updater has already overwritten every edited
 * stock file once. So the fix is not permanent, its loss is silent, and the
 * only symptom is a missing preview image nobody screenshots. That is a drift
 * check by definition.
 *
 * Deliberately reads the THEME ASSETS rather than fetching rendered pages: it
 * is the same mechanism the rest of this gate uses, costs two asset GETs, and
 * asks the question that actually matters — is our customization still there.
 */
export function auditShareImage({ metaTagsLiquid, settingsDataJson }) {
  const problems = [];

  if (metaTagsLiquid == null) {
    problems.push('snippets/meta-tags.liquid could not be read — unchecked, which is worse than known-bad');
  } else if (!/settings\.share_image/.test(metaTagsLiquid)) {
    problems.push(
      'snippets/meta-tags.liquid no longer references settings.share_image — the og:image fallback is GONE, '
      + 'so the homepage, /pages/*, the blog index and every imageless collection emit no og:image',
    );
  }

  if (settingsDataJson == null) {
    problems.push('config/settings_data.json could not be read — unchecked');
  } else {
    let value;
    try {
      value = JSON.parse(settingsDataJson)?.current?.share_image;
    } catch (e) {
      problems.push(`config/settings_data.json did not parse: ${e.message}`);
    }
    // An empty string is what the customizer writes when someone clears the
    // picker, and it is indistinguishable from "never set" at render time.
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      problems.push('settings.share_image is set but EMPTY — the fallback resolves to nil and emits nothing');
    } else if (value === undefined && !problems.length) {
      problems.push('settings.share_image is not set on the live theme — the fallback has nothing to emit');
    }
  }

  return problems;
}

export function summarize({ missing = [], claims = [], unreadable = [], shareImage = [] }) {
  const bad = claims.filter((c) => ['overstates', 'incoherent', 'unevidenced'].includes(c.verdict));
  if (unreadable.length) return { code: 3, missing, bad, unreadable, shareImage };
  if (missing.length) return { code: 2, missing, bad, unreadable, shareImage };
  if (bad.length) return { code: 1, missing, bad, unreadable, shareImage };
  // Lowest precedence deliberately: a live page telling a customer something
  // untrue outranks a missing social preview image every time.
  if (shareImage.length) return { code: 4, missing, bad, unreadable, shareImage };
  return { code: 0, missing, bad, unreadable, shareImage };
}
