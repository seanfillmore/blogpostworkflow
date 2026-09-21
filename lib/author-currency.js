// lib/author-currency.js
//
// "Does the person named in this byline STILL WORK AT THIS OUTLET?" — the one
// question `lib/article-freshness.js` explicitly declined to answer, and the
// one that accounted for FOUR of the six unusable targets in the 2026-09-20
// audit of `data/reports/pr-targets/latest.json`:
//
//   Nicole Saunders     named at BestProducts  → now Beauty Editor, Women's Health
//   Tatjana Freund      named at Elle          → now Senior Commerce Editor, People
//   Emily Goldman       named at Prevention    → left for the BCRF; her published
//                                                emily.goldman@hearst.com is dead
//   Masha Vapnitchnaia  named at Elite Daily   → no bylines since ~2023
//
// Each wasted pitch costs a real contact, and a byline captured once and never
// re-checked is how that happens. Pure: this module takes HTML and a clock and
// returns a verdict. The agent owns the fetching.
//
// THE OBVIOUS SIGNAL WAS MEASURED AND REJECTED — read this before "improving"
// it into a recency check. The natural design is "fetch the author's archive
// page and see whether their most recent article is recent". Measured live
// 2026-09-20 against the four known-bad targets and four controls, the most
// recent date on the author page reads:
//
//   prevention.com  Emily Goldman     2026-08-27   FRESH   (she has left)
//   elle.com        Tatjana Freund    2026-08-19   FRESH   (she has left)
//   bestproducts.com Nicole Saunders  2026-07-24   FRESH   (she has left)
//   nbcnews.com     Mili Godio        2026-07-10   FRESH   (control, current)
//   nontoxiclab.com Lara Voss         2026-06-27   FRESH   (control, current)
//   bettergoods.org Lindsey St. Mary  2023-08-12   STALE   (already caught by
//                                                  lib/article-freshness.js)
//
// So recency catches ZERO of the four and its only hit is one the existing
// freshness check already demotes. The reason is structural: a big publisher's
// author archive is a generated page that keeps re-rendering (and keeps
// listing the writer's back catalogue) long after the writer has gone. A
// signal that fires on nobody, and fires on a page the other check already
// covers, is worse than no signal — it reads as evidence.
//
// WHAT DOES WORK is the outlet's own BIO, which is prose a human maintains:
//
//   bestproducts.com "Nicole Saunders is the beauty editor at Women's Health"
//   elle.com         "…is Hearst's Fashion & Luxury Commerce Editor.
//                     Previously, she worked at ELLE.com and Marie Claire."
//
// Two shapes, and this module looks for exactly those two: a CURRENT-role
// clause naming an outlet that is not this one, and a FORMER-role clause
// naming an outlet that IS this one. Everything else is UNKNOWN.
//
// WHAT IT CANNOT DO, stated rather than papered over. Emily Goldman's
// Prevention bio still reads "is the deputy digital director at Prevention" —
// the outlet simply has not updated it. Nothing on the page says she left, so
// nothing here can say so either. And Elite Daily's article markup carries no
// author URL at all (its JSON-LD Person has a `worksFor` and no `url`), so
// Masha Vapnitchnaia is never even reachable. Honest score against the four:
// 2 caught, 1 already demoted by article freshness, 1 undetectable from the
// page. Do not quote this as four.

const MS_PER_DAY = 86_400_000;

// Paths a publisher puts an author archive behind. Used only to RECOGNISE a
// candidate href that is already in the markup — never to GUESS a URL, because
// a guessed pattern cannot generalise across 349 domains and a wrong guess
// produces a 404 this module would then have to interpret.
const AUTHOR_PATH = /\/(?:author|authors|profile|profiles|contributor|contributors|staff|people|writer|writers|team|by)\//i;

// Tokens that carry no identity, so they may never be the thing that makes an
// affiliation "match" an outlet.
const GENERIC_TOKENS = new Set([
  'the', 'a', 'an', 'and', 'of', 'com', 'org', 'net', 'inc', 'llc', 'ltd',
  'co', 'group', 'brand', 'brands', 'online', 'digital', 'website', 'site',
]);

function text(s) {
  return String(s == null ? '' : s).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

function hostOf(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
}

// The registrable-ish label: `bestproducts` out of `www.bestproducts.com`.
// Deliberately naive (last label before the TLD) — it only ever feeds a token
// comparison, never a security decision.
export function siteLabel(value) {
  const host = hostOf(value);
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] || '';
  // Handle co.uk / com.au by skipping a 2-letter penultimate label.
  const last = parts[parts.length - 1];
  const penultimate = parts[parts.length - 2];
  if (parts.length >= 3 && penultimate.length <= 3 && last.length === 2) return parts[parts.length - 3];
  return penultimate;
}

function tokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

/**
 * Does an affiliation name ("Women's Health", "NBC Selected") refer to THIS
 * outlet? Token overlap in both directions, plus a substring test against the
 * squashed site label — because a domain label is one token (`nbcnews`) while
 * the prose that names it is two ("NBC Selected"), and neither form contains
 * the other as a token.
 *
 * UNKNOWN-MEANS-MATCH is the safety property: an affiliation this cannot
 * resolve is treated as "same outlet", so it can only ever fail to demote.
 */
export function affiliationMatchesOutlet(affiliation, { domain, publication } = {}) {
  const affTokens = tokens(affiliation);
  if (!affTokens.length) return true;
  const affSquashed = affTokens.join('');
  const candidates = [publication, domain, siteLabel(domain)].filter(Boolean);
  if (!candidates.length) return true;
  for (const candidate of candidates) {
    const candTokens = tokens(candidate);
    const candSquashed = candTokens.join('') || String(candidate).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (affTokens.some((t) => candTokens.includes(t))) return true;
    // "NBC Selected" → nbc ⊂ nbcnews; "Better Goods" → better ⊂ bettergoods.
    if (candSquashed && affTokens.some((t) => candSquashed.includes(t))) return true;
    if (affSquashed && candTokens.some((t) => affSquashed.includes(t))) return true;
  }
  return false;
}

function* ldNodes(json) {
  const stack = [json];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) { stack.push(...cur); continue; }
    yield cur;
    if (cur['@graph']) stack.push(cur['@graph']);
    if (cur.mainEntity) stack.push(cur.mainEntity);
  }
}

function* ldBlocks(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    yield json;
  }
}

function nameMatches(a, b) {
  const at = tokens(a);
  const bt = tokens(b);
  if (!at.length || !bt.length) return false;
  return at.some((t) => bt.includes(t));
}

function absolutize(href, domain) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (!domain) return null;
  if (raw.startsWith('/')) return `https://${hostOf(domain)}${raw}`;
  return null;
}

/**
 * Find the author's archive/profile page URL from the ARTICLE's own markup.
 *
 * Derived, never guessed: a per-publisher URL pattern cannot generalise across
 * 349 domains, and a guess that 404s would have to be interpreted as evidence.
 * Sources in order of trust: JSON-LD `author.url` / `author["@id"]`, an
 * `author` object in JSON-LD that does not parse, a `rel="author"` anchor, the
 * raw byline string when the extractor already found a URL there (four live
 * domains put the archive link where the name should be), and finally any
 * `/author/`-shaped href whose slug shares a token with the byline.
 *
 * The candidate MUST be on the same site as the article. Without that,
 * thefiltery.com and organicbeautylover.com hand back a facebook.com profile
 * URL, which is not an outlet page and cannot answer this question.
 */
export function extractAuthorUrl(html, { domain, author, authorRaw } = {}) {
  const wanted = author || authorRaw || '';
  const candidates = [];
  const push = (href) => { const abs = absolutize(href, domain); if (abs) candidates.push(abs); };

  if (html && typeof html === 'string') {
    for (const json of ldBlocks(html)) {
      for (const node of ldNodes(json)) {
        if (!node.author) continue;
        const authors = Array.isArray(node.author) ? node.author : [node.author];
        for (const a of authors) {
          if (!a || typeof a !== 'object') continue;
          const url = a.url || a['@id'];
          if (!url || typeof url !== 'string') continue;
          if (wanted && a.name && !nameMatches(a.name, wanted)) continue;
          push(url);
        }
      }
    }
    // Unparseable JSON-LD still yields its author URL (58 of this site's own
    // pages carry JSON-LD that does not parse; other people's are no better).
    for (const m of html.matchAll(/"author"\s*:\s*\{[^{}]*?"url"\s*:\s*"([^"]+)"/gi)) push(m[1]);
    for (const m of html.matchAll(/<a[^>]+rel=["'][^"']*\bauthor\b[^"']*["'][^>]*href=["']([^"']+)["']/gi)) push(m[1]);
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*\bauthor\b[^"']*["']/gi)) push(m[1]);
  }

  if (authorRaw && /^https?:\/\//i.test(String(authorRaw).trim())) push(String(authorRaw).trim());

  if (html && typeof html === 'string' && wanted) {
    for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = m[1];
      if (!AUTHOR_PATH.test(href)) continue;
      const slug = href.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() || '';
      if (nameMatches(slug.replace(/[-_]+/g, ' '), wanted)) push(href);
    }
  }

  const site = hostOf(domain);
  for (const url of candidates) {
    const host = hostOf(url);
    if (!host) continue;
    if (site && host !== site && !host.endsWith(`.${site}`) && !site.endsWith(`.${host}`)) continue;
    const path = url.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
    if (!path || path === '/') continue; // the homepage answers nothing
    return url;
  }
  return null;
}

/**
 * Pull the outlet's own bio for the author, from their archive page.
 * `worksFor` is kept separate from the prose because it is a structured claim
 * and the prose is not.
 */
export function extractPersonBio(html, { author } = {}) {
  const empty = { name: null, jobTitle: null, worksFor: null, description: null };
  if (!html || typeof html !== 'string') return empty;
  let best = null;
  for (const json of ldBlocks(html)) {
    for (const node of ldNodes(json)) {
      const isPerson = node['@type'] === 'Person'
        || (Array.isArray(node['@type']) && node['@type'].includes('Person'))
        || (node.jobTitle && node.name);
      if (!isPerson) continue;
      const cand = {
        name: text(node.name) || null,
        jobTitle: text(node.jobTitle) || null,
        worksFor: text(typeof node.worksFor === 'string' ? node.worksFor : node.worksFor?.name) || null,
        description: text(node.description) || null,
      };
      if (!cand.description && !cand.jobTitle && !cand.worksFor) continue;
      // Prefer the node whose name matches the byline we are checking.
      if (author && cand.name && nameMatches(cand.name, author)) return cand;
      if (!best) best = cand;
    }
  }
  if (best) return best;
  const md = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,600})["']/i);
  if (md) return { ...empty, description: text(md[1]) };
  return empty;
}

const FORMER_MARKER = /\b(?:previously|formerly|prior to|before joining|used to (?:be|work)|was (?:the|a|an) [a-z][^.;]{0,40}? at|until \d{4})\b/i;

// Capture an outlet name: a run of Capitalised (or ALLCAPS, or dotted-domain)
// words. Deliberately narrow — it is only ever compared against THIS outlet,
// and a miss means UNKNOWN, which is the safe direction.
//
// THE CAPITAL IS LOAD-BEARING, and it is why these patterns spell their
// marker words as `[Pp]reviously` instead of carrying an `i` flag. A
// case-insensitive compile would let `[A-Z]` match lower case and the capture
// would swallow ordinary prose ("she worked at home") as an outlet name. The
// first version of this module compiled with `'g'` alone and silently matched
// NOTHING at a sentence start, which is where "Previously," always sits — it
// scored `bio-names-no-outlet` on the Elle bio that says, in as many words,
// "Previously, she worked at ELLE.com".
const OUTLET = "([A-Z][\\w&.'’-]*(?:\\s+(?:and\\s+)?[A-Z][\\w&.'’-]*){0,3})";

function sentences(s) {
  return String(s || '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}

// A capture may span several outlets ("ELLE.com and Marie Claire"). It is kept
// as ONE blob rather than split: `affiliationMatchesOutlet` matches on any
// token, so a blob can only ever make the FORMER test easier to satisfy and
// the CURRENT test harder — and "harder to call somebody departed" is the
// direction this whole module fails in.
function outletsIn(sentence, patterns) {
  const found = [];
  for (const source of patterns) {
    for (const m of sentence.matchAll(new RegExp(source, 'g'))) {
      const name = text(m[1]).replace(/[.,;:]+$/, '').replace(/\s+(?:and|where|who|which)$/i, '').trim();
      if (name) found.push(name);
    }
  }
  return found;
}

const CURRENT_PATTERNS = [
  // "is the beauty editor at Women's Health" / "works as a writer for Elle"
  `\\b(?:[Ii]s|[Aa]re|[Ss]erves|[Ww]orks|[Ww]rites)\\b[^.;]{0,70}?\\b(?:at|for)\\s+${OUTLET}`,
  // "is Hearst's Fashion & Luxury Commerce Editor" — the possessive is OUTSIDE
  // the capture; leaving the apostrophe inside the character class made this
  // pattern unmatchable, because the greedy run ate the `'s` it then required.
  `\\b[Ii]s\\s+([A-Z][\\w&.-]*)['’]s\\s+[A-Za-z]`,
  // "founder of NonToxicLab" / "editor-in-chief of Better Goods"
  `\\b(?:[Ff]ounder|[Cc]o-founder|[Oo]wner|[Ee]ditor|[Ee]ditor-in-chief|[Cc]reator)\\s+(?:and\\s+[\\w-]+\\s+)?of\\s+${OUTLET}`,
];

const FORMER_PATTERNS = [
  // `joining` is deliberately NOT an affiliation preposition here. "Before
  // joining SELF, she was a Wellness Reporter at USA TODAY" names SELF as the
  // outlet she joined — the CURRENT one — and reading it as former inverts the
  // sentence exactly backwards. It produced a live false positive on
  // self.com/Jenna Ryu, whose bio opens "is a Lifestyle Writer at SELF".
  `\\b(?:[Pp]reviously|[Ff]ormerly|[Pp]rior to|[Bb]efore)\\b[^.;]{0,70}?\\b(?:at|for|with)\\s+${OUTLET}`,
  `\\b[Ww]as\\s+(?:the|a|an)\\s+[^.;]{0,50}?\\bat\\s+${OUTLET}`,
  `\\b[Uu]sed to (?:be|work)\\b[^.;]{0,50}?\\b(?:at|for)\\s+${OUTLET}`,
];

/**
 * Does the bio associate this author with THIS outlet anywhere at all — in any
 * grammatical shape, current or past, role clause or passing mention?
 *
 * This is the precision guard on `current-role-elsewhere`, and it was added
 * because that rule produced a live false positive on the first real run:
 * harpersbazaar.com's Lindy Segal bio reads "In addition to regularly
 * contributing to BAZAAR.COM, she also writes for Glamour, People,
 * WhoWhatWear…". The role clause the patterns above can see is "writes for
 * Glamour", so the rule concluded she had moved to Glamour — when the same
 * sentence says she still writes for us. A freelancer listing their other
 * mastheads is the single most common shape of bio on this corpus, so a rule
 * that reads it as a departure is not usable.
 *
 * Token intersection, never a substring sweep: `tokens()` drops generic words
 * and anything under three characters, so "the" and "com" can never be the
 * thing that suppresses a real departure.
 */
export function bioMentionsOutlet(bioText, { domain, publication } = {}) {
  const bioTokens = new Set(tokens(bioText));
  if (!bioTokens.size) return false;
  const outletTokens = new Set([
    ...tokens(publication), ...tokens(domain), ...tokens(siteLabel(domain)),
  ]);
  for (const t of outletTokens) {
    if (bioTokens.has(t)) return true;
    // "bestproducts" (the domain label) against "Best Products" in prose.
    if (t.length >= 6 && [...bioTokens].some((b) => b.length >= 4 && t.includes(b))) return true;
  }
  return false;
}

/**
 * Split a bio into the outlets it claims as CURRENT and the ones it marks as
 * FORMER. A sentence carrying a former-marker contributes only to `former`,
 * even if it also matches a current-tense pattern — "Previously, she worked at
 * ELLE.com" contains "worked at", and reading that as a current role is the
 * one mistake that would invert this whole check.
 */
export function affiliationClaims(bio = {}) {
  const current = [];
  const former = [];
  if (bio.worksFor) current.push(bio.worksFor);
  const prose = [bio.jobTitle && bio.name ? `${bio.name} is ${bio.jobTitle}.` : '', bio.description || ''].filter(Boolean).join(' ');
  for (const s of sentences(prose)) {
    if (FORMER_MARKER.test(s)) {
      former.push(...outletsIn(s, FORMER_PATTERNS));
      // A former-marked sentence never contributes a current affiliation.
      continue;
    }
    current.push(...outletsIn(s, CURRENT_PATTERNS));
  }
  const uniq = (xs) => [...new Set(xs.map((x) => text(x)).filter(Boolean))];
  return { current: uniq(current), former: uniq(former) };
}

/**
 * The verdict. Three states, and `unknown` is by far the most common one —
 * that is the design, not a shortfall.
 *
 *   'current'   nothing on the outlet's own page says this person left
 *   'departed'  the outlet's own bio says they work somewhere else now, or
 *               names THIS outlet as a former employer
 *   'unknown'   we could not check — no author URL, fetch failed, no bio
 *
 * FAILS OPEN, ALWAYS. Every branch that cannot answer returns `unknown` with
 * a reason string, and `unknown` never demotes. A silently disarmed check that
 * renders identically to a clean run is the failure mode CLAUDE.md warns about
 * repeatedly, so the reason is carried out of here rather than discarded.
 */
export function classifyAuthorCurrency({
  author = null,
  domain = null,
  publication = null,
  authorUrl = null,
  fetchStatus = null,   // 'ok' | 'not-found' | 'error' | null
  html = null,
} = {}) {
  const base = { state: 'unknown', reason: null, evidence: null, author_url: authorUrl || null };
  if (!author) return { ...base, reason: 'no-person-byline' };
  if (!authorUrl) return { ...base, reason: 'no-author-page-found' };
  // A 404 ON THE AUTHOR PAGE IS NOT A DEPARTURE, and that is a measurement
  // rather than caution. The first run of this check called teethtalkgirl.com's
  // Whitney DiFoggio departed on a 404 — and the 404 was the SITE's own markup
  // emitting a doubled path (`/authors//authors/whitney-difoggio`, 404) for a
  // page that serves 200 at `/authors/whitney-difoggio`. A site restructure
  // produces the identical signal. So it is UNKNOWN, which demotes nobody.
  if (fetchStatus === 'not-found') return { ...base, reason: 'author-page-not-found' };
  if (fetchStatus !== 'ok') return { ...base, reason: 'author-page-unreachable' };

  const bio = extractPersonBio(html, { author });
  if (!bio.description && !bio.jobTitle && !bio.worksFor) {
    return { ...base, reason: 'no-author-bio' };
  }
  const { current, former } = affiliationClaims(bio);

  // CURRENT WINS A TIE, always. A bio that names this outlet in both a current
  // and a former clause is describing somebody who is still here — the former
  // clause is almost always a tenure sentence ("Before joining SELF…"), and
  // calling that a departure is the one error this module must not make.
  const stillHere = current.some((c) => affiliationMatchesOutlet(c, { domain, publication }));
  const formerHere = stillHere ? null : former.find((f) => affiliationMatchesOutlet(f, { domain, publication }));
  if (formerHere) {
    return {
      state: 'departed',
      reason: 'previously-at-this-outlet',
      evidence: `bio names ${formerHere} as a FORMER employer`,
      author_url: authorUrl,
      bio_excerpt: (bio.description || bio.jobTitle || '').slice(0, 240) || null,
    };
  }
  const bioText = [bio.jobTitle, bio.worksFor, bio.description].filter(Boolean).join(' ');
  if (current.length && !current.some((c) => affiliationMatchesOutlet(c, { domain, publication }))) {
    // Only when the bio does not associate them with us ANYWHERE — see
    // bioMentionsOutlet for the live false positive this guard exists to stop.
    if (bioMentionsOutlet(bioText, { domain, publication })) {
      return { ...base, state: 'current', reason: 'bio-names-other-outlets-too', evidence: `bio still names this outlet alongside ${current.join(', ')}` };
    }
    return {
      state: 'departed',
      reason: 'current-role-elsewhere',
      evidence: `bio says they are now at ${current.join(', ')}`,
      author_url: authorUrl,
      bio_excerpt: (bio.description || bio.jobTitle || '').slice(0, 240) || null,
    };
  }
  if (!current.length) return { ...base, reason: 'bio-names-no-outlet' };
  return {
    state: 'current',
    reason: null,
    evidence: `bio still places them at ${current.join(', ')}`,
    author_url: authorUrl,
    bio_excerpt: null,
  };
}

// Reasons that mean "we could not check", as opposed to "we checked and it is
// fine". The agent counts these separately so nobody reads a run with no
// departures as a run where every author was verified.
export const UNCHECKABLE_REASONS = new Set([
  'no-person-byline', 'no-author-page-found', 'author-page-unreachable', 'author-page-not-found',
  'no-author-bio', 'bio-names-no-outlet',
]);

export function isDepartedAuthor(currency) {
  return currency != null && currency.state === 'departed';
}

export { MS_PER_DAY };
