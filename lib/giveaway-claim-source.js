// lib/giveaway-claim-source.js
//
// THE GIVEAWAY AS A CLAIM SOURCE.
//
// agents/ad-studio/claims.js holds four sources — pdp, catalog, brandKit, reviews — and a
// running giveaway is none of them. So "enter to win", "entries close September 14, 2026"
// and "thirty-six (36) bars" were all UNSOURCED, and assertClaimsSourced correctly stopped
// every giveaway concept before it rendered. The gate was right; the source index was
// incomplete. This module is the missing source, and nothing here relaxes the gate: it adds
// evidence, and evidence that is not in it is still rejected.
//
// TWO AUTHORITIES, AND THEY MUST AGREE.
//
//   config/giveaway.json          — the single source of truth for TIMING (its own
//                                   _datesNote says so), and the thing the nurture
//                                   schedule and the close-entry cron are computed from.
//   data/giveaway/official-rules.html — the single source of truth for PROSE: what the
//                                   prize is, who may enter, what "no purchase necessary"
//                                   means. It is the published legal document.
//
// The searchable body handed to the claim gate is the RULES PROSE ONLY. The config's job
// here is a CROSS-CHECK, not a contribution: its entry-open and entry-close calendar dates
// must literally appear in the published rules, or this module throws and no giveaway copy
// is generated at all. That is deliberate. If the config said September 21 and the rules
// said September 14, folding the config into the source body would let a writer quote
// "September 21" as sourced evidence for a deadline the published rules contradict — the
// exact failure the claim gate exists to prevent, arriving through the gate's own front
// door. Disagreement is an operator problem to reconcile by hand, never a problem for this
// module to resolve by preferring one file.
//
// Note what is NOT cross-checked: `drawAt`. The published rules describe the drawing
// (Section 8) without naming its date, so requiring drawAt to appear would throw on a
// correct pair of files. It is also deliberately kept OUT of the source body — a date the
// published rules do not carry is a date ad copy must not state.
//
// TIMEZONE. RECONCILED 2026-08-20 — the giveaway runs on PACIFIC. config/giveaway.json
// stamps -07:00 (PDT, which is what August and September are on) and the rules prose says
// "Pacific Time (PT)". They now name the same closing instant. Before that they did not:
// the config stamped -06:00 and called it "store-local" while the prose said "CT" (-05:00
// in September), an hour apart, and the operator's decision made BOTH of them wrong.
//
// Nothing in this module ever depended on the offset and nothing here enforces it: it
// exposes CALENDAR DATES only ("September 14, 2026"), taken from the literal date component
// (see calendarDate), because ad copy states a date and never a UTC instant. So the skew was
// invisible here by design and its repair is likewise invisible here. Where the offset does
// bite is the close-entry cron, which is on the UTC clock and does not follow this config —
// check it separately if the offset ever moves again.
//
// No network, no LLM, no heavy dependency: readFileSync and string work only, so the
// dashboard process can import it as cheaply as the agents do.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeForMatch } from '../agents/ad-studio/claims.js';

export const CONFIG_RELPATH = ['config', 'giveaway.json'];
export const RULES_RELPATH = ['data', 'giveaway', 'official-rules.html'];

/**
 * Byte-for-byte the stripper agents/ad-brief/index.js uses on a PDP body, for the same
 * reason it is duplicated there: two consumers must never read the same HTML into two
 * different plain-text bodies, because the claim gate matches against exactly this output.
 */
export function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * "2026-09-14T23:59:59-07:00" → "September 14, 2026".
 *
 * Reads the LITERAL date component of the timestamp rather than converting through a Date.
 * The offset in the file is the promotion's own zone (Pacific), so the calendar date a
 * reader of the rules sees is the one written in the string; `new Date(...).getMonth()`
 * would return the runner's local
 * month and turn a late-evening close into the following day on a UTC server — which is
 * precisely how a cron box would start rejecting a correct pair of files.
 */
export function calendarDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) throw new Error(`giveaway: "${iso}" is not an ISO date this can read a calendar date out of`);
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) throw new Error(`giveaway: "${iso}" has no valid month`);
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

/**
 * Is the Entry Period open right now? Inclusive of both endpoints, matching the rules'
 * "begins at 12:00 AM ... and ends at 11:59 PM".
 *
 * A malformed or inverted window throws rather than answering false: "there is no giveaway"
 * and "the giveaway config is broken" are different facts, and silently reporting the first
 * for the second is how a campaign runs a month of ads with no giveaway angle in them.
 */
export function isGiveawayLive(config, now = new Date()) {
  const opens = Date.parse(config?.entryOpensAt);
  const closes = Date.parse(config?.entryClosesAt);
  if (!Number.isFinite(opens)) {
    throw new Error(`giveaway: config/giveaway.json entryOpensAt is missing or unparseable (${JSON.stringify(config?.entryOpensAt)})`);
  }
  if (!Number.isFinite(closes)) {
    throw new Error(`giveaway: config/giveaway.json entryClosesAt is missing or unparseable (${JSON.stringify(config?.entryClosesAt)})`);
  }
  if (closes <= opens) {
    throw new Error(
      `giveaway: config/giveaway.json entryClosesAt (${config.entryClosesAt}) is not after ` +
      `entryOpensAt (${config.entryOpensAt}) — the Entry Period is empty or inverted.`
    );
  }
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new Error(`giveaway: "${now}" is not a usable current time`);
  return t >= opens && t <= closes;
}

/**
 * Split the rules document into { heading, prose } by its <h2> boundaries, so a section can
 * be quoted to a copy writer verbatim instead of paraphrased into a new claim.
 */
export function rulesSections(html) {
  const src = String(html || '');
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  const heads = [];
  let m;
  while ((m = re.exec(src)) !== null) heads.push({ heading: stripHtml(m[1]), start: m.index, end: re.lastIndex });
  return heads.map((h, i) => ({
    heading: h.heading,
    prose: stripHtml(src.slice(h.end, i + 1 < heads.length ? heads[i + 1].start : src.length)),
  }));
}

/**
 * The one section whose heading matches. Exactly one, or throw naming the file — a rules
 * document that has been renumbered or retitled must stop the run loudly rather than hand
 * the copy writer an empty prize description.
 */
function oneSection(sections, pattern, label) {
  const hits = sections.filter(s => pattern.test(s.heading));
  if (hits.length !== 1) {
    throw new Error(
      `giveaway: expected exactly one "${label}" section in data/giveaway/official-rules.html, ` +
      `found ${hits.length} (headings: ${sections.map(s => s.heading).join(' | ') || 'none'}). ` +
      `Giveaway ad copy is not generated from a rules document this cannot read.`
    );
  }
  if (!hits[0].prose) {
    throw new Error(`giveaway: the "${label}" section of data/giveaway/official-rules.html is empty`);
  }
  return hits[0].prose;
}

/**
 * Build the giveaway claim source from the two authoritative files.
 *
 * @param {{config:object, rulesHtml:string}} args
 * @returns {{name:string, text:string, opensOn:string, closesOn:string,
 *            entryPeriod:string, eligibility:string, howToEnter:string, prizes:string}}
 */
export function buildGiveawaySource({ config, rulesHtml }) {
  const text = stripHtml(rulesHtml);
  if (!text) throw new Error('giveaway: data/giveaway/official-rules.html produced no readable text');
  const haystack = normalizeForMatch(text);

  // THE CROSS-CHECK. Both files are authoritative; if they disagree, stop.
  for (const field of ['entryOpensAt', 'entryClosesAt']) {
    const date = calendarDate(config?.[field]);
    if (!haystack.includes(normalizeForMatch(date))) {
      throw new Error(
        `giveaway: config/giveaway.json ${field} is ${config[field]} — calendar date "${date}" — ` +
        `which does not appear in data/giveaway/official-rules.html. The config owns the timing and ` +
        `the published rules own the prose, both are authoritative, and they disagree. Reconcile them ` +
        `by hand (config/giveaway.json's _datesNote lists everywhere the dates are written). No ` +
        `giveaway ad copy is generated meanwhile, because copy could otherwise cite a deadline the ` +
        `published rules contradict.`
      );
    }
  }

  const sections = rulesSections(rulesHtml);
  const parts = {
    entryPeriod: oneSection(sections, /entry period/i, 'Entry Period'),
    eligibility: oneSection(sections, /eligibility/i, 'Eligibility'),
    howToEnter: oneSection(sections, /how to enter/i, 'How to Enter'),
    prizes: oneSection(sections, /\bprizes?\b/i, 'Prizes'),
  };

  // Everything shown to a copy writer must itself be quotable against the source body, or
  // the writer would be handed text it cannot cite and the gate would reject a quote that
  // was copied faithfully out of its own prompt.
  for (const [key, prose] of Object.entries(parts)) {
    if (!haystack.includes(normalizeForMatch(prose))) {
      throw new Error(
        `giveaway: the "${key}" section is not a contiguous substring of the rules body after ` +
        `normalisation — a writer shown it could not cite it. This is a bug in section extraction, ` +
        `not in the rules document.`
      );
    }
  }

  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(String(rulesHtml || ''));
  return {
    name: h1 ? stripHtml(h1[1]) : 'Giveaway',
    text,
    opensOn: calendarDate(config.entryOpensAt),
    closesOn: calendarDate(config.entryClosesAt),
    ...parts,
  };
}

/**
 * Load the giveaway IF ONE IS ACTUALLY RUNNING, else null.
 *
 * null is the byte-identical-to-before path: no `giveaway` key in the source index, no
 * giveaway block in the copy prompt, no giveaway format offered. A missing config file is
 * null (this repo simply has no giveaway); a config that exists but cannot be read, or a
 * LIVE giveaway with no rules document, throws — a running promotion whose published rules
 * are unreadable must not quietly produce ads that cite them.
 *
 * @param {{root:string, now?:Date}} args
 */
export function loadGiveaway({ root, now = new Date() } = {}) {
  let raw;
  try {
    raw = readFileSync(join(root, ...CONFIG_RELPATH), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const config = JSON.parse(raw);
  if (!isGiveawayLive(config, now)) return null;

  const rulesHtml = readFileSync(join(root, ...RULES_RELPATH), 'utf8');
  return buildGiveawaySource({ config, rulesHtml });
}
