// lib/year-accuracy.js
//
// Distinguishes a STALE "current-year" reference (e.g. a "Best X 2024" title or
// "updated for 2024" that should now read 2026) from a LEGITIMATE HISTORICAL
// reference (e.g. "the market has expanded since 2020", "a 2021 study",
// "founded in 2019", "the 2020 pandemic", "2018–2021").
//
// The year-accuracy gate exists to keep a post's TITLE / THEME current — NOT to
// rewrite citations or facts about the past. Flagging (or rewriting) a historical
// year is wrong: "since 2020" must never become "since 2026". This module is the
// single source of truth for that distinction, used by the editor's year-accuracy
// verdict so it never raises a dead-end blocker on a legitimate past reference.

const STALE_MIN_YEAR = 2020; // years below this are always treated as historical

// Relational / temporal cues IMMEDIATELY BEFORE the year that mark it as a point
// in the past. "since 2020", "before 2022", "from 2019", "back in 2021", etc.
// (Markers that denote the *present* edition — "in", "for", "as of", "updated" —
// are intentionally NOT here; those are stale-current-year framing and the editor's
// auto-fixer bumps them before this check runs.)
const HISTORICAL_PREFIX = /\b(since|after|before|until|til|till|from|between|throughout|circa|ca|prior to|up to|as early as|as late as|back in|earlier in|the (?:spring|summer|fall|autumn|winter) of|in (?:early|mid|late)|(?:early|mid|late))\s+$/i;
const PRE_POST_PREFIX = /\b(pre|post)-?\s*$/i;
const FOUNDING_PREFIX = /\b(founded|established|launched|started|created|incorporated|opened|began|begun|introduced|debuted|formed|in business since|operating since)\s+(?:in\s+)?$/i;
const COPYRIGHT_PREFIX = /(©|\(c\)|copyright)\s*$/i;
// A year that is the LEFT endpoint of a range: "2018–2021", "2018 to 2021".
const RANGE_BEFORE = /\b20\d{2}\s*(?:[–—-]|to|through|and)\s*$/i;

// A year that is the RIGHT endpoint of a range: "2018–2021", "2018 to 2021".
const RANGE_AFTER = /^\s*(?:[–—-]|to|through)\s*20\d{2}\b/i;
// Dated-event / citation noun immediately AFTER the year: "2021 study", "2020 pandemic".
const CITATION_AFTER = /^\s+(stud(?:y|ies)|reports?|surveys?|analys[ie]s|reviews?|papers?|polls?|census|trials?|data|dataset|statistics|figures|findings|pandemic|recession|elections?|laws?|act|bans?|regulations?|rulings?|crisis|outbreak|recalls?|lawsuits?|guidelines?|standards?|amendment)\b/i;

/**
 * True when the year at `index` in `text` is a legitimate reference to the past
 * (historical fact, citation, range, founding date, copyright) rather than a
 * stale current-year marker that should be bumped.
 *
 * @param {string} text  visible text (tag-stripped)
 * @param {number} index start offset of the 4-digit year within `text`
 */
export function isHistoricalYearReference(text, index) {
  const before = text.slice(Math.max(0, index - 48), index);
  const after = text.slice(index + 4, index + 40);
  return (
    HISTORICAL_PREFIX.test(before) ||
    PRE_POST_PREFIX.test(before) ||
    FOUNDING_PREFIX.test(before) ||
    COPYRIGHT_PREFIX.test(before) ||
    RANGE_BEFORE.test(before) ||
    RANGE_AFTER.test(after) ||
    CITATION_AFTER.test(after)
  );
}

/**
 * Scan visible text for STALE current-year references — years in
 * [STALE_MIN_YEAR, currentYear) that are NOT historical references. Returns one
 * entry per occurrence: { year, index, snippet }.
 *
 * @param {string} text
 * @param {number} [currentYear]
 */
export function findStaleYears(text, currentYear = new Date().getFullYear()) {
  const out = [];
  if (!text) return out;
  const re = /\b(20\d{2})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const yr = parseInt(m[1], 10);
    if (yr < STALE_MIN_YEAR || yr >= currentYear) continue; // current/future/pre-2020 are fine
    if (isHistoricalYearReference(text, m.index)) continue;  // legitimate past reference
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + 50);
    out.push({ year: yr, index: m.index, snippet: text.slice(start, end).replace(/\s+/g, ' ').trim() });
  }
  return out;
}
