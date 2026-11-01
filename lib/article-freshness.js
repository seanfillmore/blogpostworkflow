// lib/article-freshness.js
//
// "Is the ARTICLE we want to be added to still maintained?" — answered from the
// page `agents/pr-target-finder` already fetches, with no extra request.
//
// WHY THIS EXISTS. The 2026-09-20 audit of 13 ranked PR targets found 6
// unusable, and the pattern behind most of them is the same: the agent captured
// a byline once and never asked whether anything on that page had moved since.
// Two of the six were abandoned pages — bettergoods.org last modified
// 2023-08-12, and an Elite Daily piece never touched since 2021-02-06 by an
// author inactive since ~2023. Pitching to be added to a roundup nobody edits
// any more cannot succeed, and it costs the same outreach hour as a live one.
//
// Pure: takes HTML and a clock, returns dates. It makes no claim about the
// AUTHOR's current employer — that needs a per-author fetch and is deliberately
// out of scope here.

// Roughly 18 months.
//
// MEASURED AGAINST THE 2026-09-20 AUDIT rather than picked, and it sits inside
// a wide gap rather than through the middle of one — the same calibration
// doctrine as lib/content-reconcile.js's DIFFERENT_ARTICLE_MAX. Ages that day:
//
//   Non-Toxic Lab   modified 2026-04-03   ~170 days   live
//   The Daley Dose  modified 2026-03-05   ~199 days   live
//   Better Goods    modified 2023-08-12  ~1135 days   abandoned
//   Elite Daily     published 2021-02-06 ~2052 days   abandoned
//
// So the live pages cluster under 200 days and the dead ones start at 1,135:
// anything from ~250 to ~1,100 separates them. 540 is chosen inside that gap
// for a reason of its own — "best X" roundups are refreshed on an annual cycle
// (their titles carry a year), so a page untouched for more than 18 months has
// missed at least one full refresh cycle. It is a FLAG, never a drop.
export const STALE_ARTICLE_DAYS = 540;

const MS_PER_DAY = 86_400_000;
// A date outside this range is a parsing artifact, not a publication date:
// themes emit `0000-00-00`, unix epoch zero, and template placeholders.
const EARLIEST_PLAUSIBLE = Date.UTC(1995, 0, 1);
const FUTURE_GRACE_DAYS = 2;

function toIso(value, now) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  if (t < EARLIEST_PLAUSIBLE) return null;
  if (t > now + FUTURE_GRACE_DAYS * MS_PER_DAY) return null;
  return new Date(t).toISOString();
}

// Walk a parsed JSON-LD payload (object, array or @graph) yielding every node.
function* ldNodes(json) {
  const stack = [json];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    yield cur;
    if (cur['@graph']) stack.push(cur['@graph']);
  }
}

/**
 * Extract publication / modification dates from an article page.
 *
 * Sources, in the order they are trusted:
 *   1. Parsed JSON-LD `datePublished` / `dateModified`
 *   2. <meta property="article:published_time" / "article:modified_time">,
 *      plus the og:updated_time and itemprop spellings
 *   3. A RAW regex over `"dateModified":"..."` — 58 of this site's own pages
 *      carry JSON-LD that does not parse (see CLAUDE.md), and other people's
 *      pages are no better, so a block that fails JSON.parse must still yield
 *      its dates rather than being thrown away.
 *   4. <time datetime="..."> — an updated/modified-classed one first.
 *
 * @returns {{ published: string|null, modified: string|null }} ISO strings.
 */
export function extractArticleDates(html, { now = Date.now() } = {}) {
  let published = null;
  let modified = null;
  if (!html || typeof html !== 'string') return { published, modified };

  // 1. JSON-LD.
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    for (const n of ldNodes(json)) {
      if (!published) published = toIso(n.datePublished || n.dateCreated, now);
      if (!modified) modified = toIso(n.dateModified, now);
    }
  }

  // 2. <meta> spellings.
  const metaFirst = (names) => {
    for (const name of names) {
      const re = new RegExp(
        `<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i');
      const hit = html.match(re) || html.match(new RegExp(
        `<meta[^>]*content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${name}["']`, 'i'));
      if (hit) {
        const iso = toIso(hit[1], now);
        if (iso) return iso;
      }
    }
    return null;
  };
  if (!modified) modified = metaFirst(['article:modified_time', 'og:updated_time', 'dateModified', 'lastmod']);
  if (!published) published = metaFirst(['article:published_time', 'datePublished', 'pubdate', 'publish-date', 'parsely-pub-date', 'date']);

  // 3. Raw regex over unparseable JSON-LD.
  if (!modified) {
    const raw = html.match(/"dateModified"\s*:\s*"([^"]+)"/i);
    if (raw) modified = toIso(raw[1], now);
  }
  if (!published) {
    const raw = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
    if (raw) published = toIso(raw[1], now);
  }

  // 4. <time datetime="...">. Prefer one explicitly marked as an update.
  if (!modified) {
    for (const m of html.matchAll(/<time[^>]*datetime=["']([^"']+)["'][^>]*>/gi)) {
      if (!/updat|modif/i.test(m[0])) continue;
      const iso = toIso(m[1], now);
      if (iso) { modified = iso; break; }
    }
  }
  if (!published) {
    const t = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
    if (t) published = toIso(t[1], now);
  }

  return { published, modified };
}

// How old is the page, in whole days, judged on the most recent thing it claims
// about itself? `null` when the page says nothing — an UNKNOWN age must never
// read as a fresh one, and must never read as a stale one either.
export function articleAgeDays({ published = null, modified = null } = {}, { now = Date.now() } = {}) {
  const stamps = [published, modified].map((s) => (s ? Date.parse(s) : NaN)).filter(Number.isFinite);
  if (!stamps.length) return null;
  return Math.max(0, Math.floor((now - Math.max(...stamps)) / MS_PER_DAY));
}

// Fails OPEN: a page with no parseable date is NOT stale. Every other gate in
// this fleet declines to guess at a missing measurement, and here the cost of
// guessing wrong is demoting a live target on no evidence.
export function isStaleArticle(dates, { now = Date.now(), maxAgeDays = STALE_ARTICLE_DAYS } = {}) {
  const age = articleAgeDays(dates, { now });
  if (age == null) return false;
  return age > maxAgeDays;
}
