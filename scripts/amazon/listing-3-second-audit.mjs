#!/usr/bin/env node
/**
 * The 3-SECOND TEST, audited per RSC listing — READ-ONLY.
 *
 * Never writes to Amazon, an ad account or Shopify. The only thing it writes is a
 * report under data/reports/listing-3-second-audit/.
 *
 * WHY THIS EXISTS. Two tactics from
 * .claude/skills/marketing-conversion-friction-audit (PR #862):
 *
 *   1. "A shopper must be able to confirm the specific attribute they searched for
 *      within three seconds, which means repeating that deciding fact in the images,
 *      the bullets AND the A+ content rather than stating it once." Shoppers arrive on
 *      different devices and scroll different sections, so any single placement is
 *      missed by a large share of them.
 *   2. "Publish the verification detail a buyer needs — for a formulated product, the
 *      full ingredient list — on the listing itself, never only on your own website
 *      behind clicks." A sceptical buyer who cannot close their own loop on-page goes
 *      back to the search results instead.
 *
 * THE QUALIFIERS ARE MINED FROM REAL CUSTOMER SEARCH TERMS, NOT GUESSED. The tactic
 * is about "the attribute they SEARCHED for", so the candidate list comes from the
 * Sponsored Products search-term report — the actual queries that produced clicks on
 * each ASIN's own campaigns — weighted by clicks. A hand-written list of qualifiers we
 * *think* matter would be measuring our own assumptions instead of demand, which is
 * the same error as importing a generic conversion benchmark.
 *
 * SCOPE IS RSC ONLY. CLAUDE.md puts Culina out of scope for everything except its
 * Amazon PPC spend, and this is a listing-content audit, not a PPC audit. Brand is
 * decided by CLAUDE.md's documented title rule via classifyBrand, imported from the
 * CVR diagnosis rather than re-implemented — one taxonomy, not two.
 *
 * WHAT IT CANNOT SEE, stated up front rather than implied: it reads TEXT surfaces
 * (title, bullets, product description, A+ modules). It cannot read the pixels of an
 * image, so "is the qualifier legible in the hero frame" is reported as UNVERIFIED and
 * listed for a human to check, never as a pass. A tool that silently scored an unread
 * surface as passing would be worse than one that admits the gap.
 *
 * Usage:
 *   node scripts/amazon/listing-3-second-audit.mjs
 *   node scripts/amazon/listing-3-second-audit.mjs --json
 *   node scripts/amazon/listing-3-second-audit.mjs --asin B0B687583D
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient, getMarketplaceId, request } from '../../lib/amazon/sp-api-client.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { classifyBrand, col, parseCsv } from './paid-vs-organic-cvr.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'listing-3-second-audit');

/** Same worktree-aware resolution as the CVR diagnosis: the exports live in the main checkout. */
function resolveAdsDir() {
  const local = join(ROOT, 'data', 'amazon-explore', 'ads-reports');
  if (existsSync(local)) return local;
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
    if (commonDir) {
      const shared = join(dirname(commonDir), 'data', 'amazon-explore', 'ads-reports');
      if (existsSync(shared)) return shared;
    }
  } catch { /* not a repo — fall through */ }
  return local;
}
const ADS_DIR = resolveAdsDir();

/**
 * Qualifier SHAPES, not a list of qualifiers.
 *
 * The distinction matters: a fixed list ("aluminum free", "fluoride free", ...) can
 * only ever find the attributes we already thought of, which defeats mining real
 * demand. These patterns recognise the GRAMMAR shoppers use to state a hard
 * criterion — an exclusion ("X free", "no X", "without X"), a provenance claim, or a
 * skin/use qualifier — and let the noun come from the query itself.
 */
const QUALIFIER_PATTERNS = [
  // "aluminum free", "fluoride-free", "paraben free".
  // ONE word before "free", deliberately. Capturing two produced "deodorant aluminum
  // free", "women aluminum free" and "womens aluminum free" as three separate criteria
  // alongside "aluminum free" — four rows for one criterion, and since the listing
  // confirms only the canonical form the other three were counted as gaps. That
  // inflated the failure count from 8 to 41 on the first run. The criterion is the
  // noun immediately before "free"; everything earlier is the shopper's phrasing.
  /\b([a-z]{3,})[\s-]free\b/g,
  // "no aluminum", "without fluoride"
  /\b(?:no|without)\s+([a-z]{3,})\b/g,
  // standing single-word criteria that are not exclusions
  /\b(unscented|fragrance[\s-]?free|organic|natural|vegan|hypoallergenic|sensitive)\b/g,
];

/**
 * Below this many clicks a qualifier is one or two shoppers' phrasing, not demand.
 * Same reasoning as the skill's negation click floor: at this account's volume a
 * single-click term is noise, and treating it as a content gap sends someone to
 * rewrite a listing for an audience of one.
 */
export const MIN_QUALIFIER_CLICKS = 3;

/**
 * AN ABSENT QUALIFIER IS TWO COMPLETELY DIFFERENT FINDINGS, and conflating them sends
 * the operator to do the wrong job.
 *
 *   the product SATISFIES the criterion but the listing never says so
 *       → CONTENT GAP. Fix the listing. (the 3-second test)
 *   the product DOES NOT satisfy the criterion
 *       → NEGATIVE KEYWORD. Stop buying the click; writing the words would be a lie.
 *         (the proactive-negation tactic in marketing-amazon-ppc-management)
 *
 * Search terms are routed to every ASIN advertised in the ad group that served them —
 * there is no per-term ASIN attribution in Amazon's report — so a deodorant query
 * legitimately lands against a lotion listing. Without this split the audit reported
 * "unscented" as a content gap on the COCONUT BREEZE lotion, whose whole identity is
 * being scented. Writing "unscented" there is not a fix, it is a false claim.
 *
 * Only contradictions the catalogue can actually PROVE are asserted. Everything else
 * stays an unclassified gap for a human, because guessing which way it falls is how a
 * listing acquires a claim nobody checked.
 */
export function contradictsProduct(qualifier, attrs) {
  const q = qualifier.toLowerCase();
  const scent = String(attrs?.scent ?? '').toLowerCase();
  if ((q === 'unscented' || q === 'fragrance free') && scent && scent !== 'unscented') {
    return `product scent is "${attrs.scent}"`;
  }
  return null;
}

/** Words that are the PRODUCT, not a qualifier of it — never treat these as criteria. */
const PRODUCT_NOUNS = new Set([
  'lotion', 'deodorant', 'toothpaste', 'soap', 'balm', 'cream', 'moisturizer',
  'paste', 'stick', 'body', 'skin', 'care', 'oil', 'gel', 'wash', 'bar', 'the', 'and', 'for',
]);

/**
 * Pull qualifier phrases out of one customer search term.
 * Returns normalised phrases like "aluminum free", "unscented", "fluoride free".
 */
export function extractQualifiers(term) {
  const t = String(term ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return [];
  const found = new Set();
  for (const re of QUALIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      if (m[1] && PRODUCT_NOUNS.has(m[1])) continue;
      // Normalise "fluoride-free" and "fluoride free" to one phrase.
      const phrase = (m[0].replace(/-/g, ' ').replace(/\s+/g, ' ').trim());
      if (phrase.length < 4) continue;
      found.add(phrase);
    }
  }
  return [...found];
}

/**
 * Does a surface CONFIRM a qualifier?
 *
 * Deliberately tolerant of separators and word order for the exclusion shapes, because
 * a listing legitimately writes "Aluminum-Free", "Aluminum Free" or "Free of Aluminum"
 * and all three confirm the same criterion to a reader. Matching only the literal query
 * string would report false gaps and send someone to rewrite copy that is already fine.
 */
export function surfaceConfirms(surfaceText, qualifier) {
  const s = String(surfaceText ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
  if (!s) return false;
  const q = qualifier.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.includes(q)) return true;
  const m = q.match(/^(.+)\sfree$/);
  if (m) {
    // PLURALS ARE MATCHED IN BOTH DIRECTIONS, and this is not a nicety: a shopper
    // searches "paraben free" while the bullet reads "Free of parabens", and a strict
    // match reports a content gap on copy that already confirms the criterion. Same
    // class of bug as \bsoap\b never matching "soaps" in lib/keyword-index/cluster.js.
    const noun = m[1].replace(/s$/, '');
    const n = `${noun}s?`;
    // "free of aluminum", "free from aluminum", "no aluminum", "without aluminum"
    if (new RegExp(`\\bfree\\s+(?:of|from)\\s+${n}\\b`).test(s)) return true;
    if (new RegExp(`\\b(?:no|without)\\s+${n}\\b`).test(s)) return true;
    // "parabens free" written as "paraben free" and vice versa
    if (new RegExp(`\\b${n}[\\s-]free\\b`).test(s)) return true;
  }
  return false;
}

/**
 * An ingredient list is recognised STRUCTURALLY, not by a keyword.
 *
 * "Ingredients" appearing once in a bullet ("made with clean ingredients") is marketing
 * copy, not the verification detail a sceptical buyer needs. What counts is an actual
 * ENUMERATION — a labelled list with several comma-separated botanical/INCI-style
 * items. Requiring the label AND the enumeration is what separates the two.
 */
export function findsIngredientList(text) {
  const s = String(text ?? '');
  const labelled = /\bingredient(s|\slist|\sdeclaration)?\b\s*[:\-—]/i.test(s);
  if (!labelled) return { found: false, reason: 'no labelled ingredient list' };
  const after = s.slice(s.search(/\bingredient(s|\slist|\sdeclaration)?\b\s*[:\-—]/i));
  const items = after.split(/[,;]/).map((x) => x.trim()).filter((x) => x.length > 2 && /[a-z]/i.test(x));
  if (items.length < 4) return { found: false, reason: `label present but only ${items.length} item(s) listed` };
  return { found: true, count: items.length };
}

const num = (r, k) => Number(r[k] ?? 0) || 0;

async function readAdsReport(fragment) {
  if (!existsSync(ADS_DIR)) throw new Error(`No ads exports at ${ADS_DIR}.`);
  const files = readdirSync(ADS_DIR);
  const csv = files.find((f) => f.toLowerCase().endsWith('.csv') && f.toLowerCase().includes(fragment));
  if (csv) return parseCsv(readFileSync(join(ADS_DIR, csv), 'utf8'));
  const xls = files.find((f) => f.toLowerCase().endsWith('.xlsx') && f.toLowerCase().includes(fragment));
  if (!xls) throw new Error(`No report matching "${fragment}" in ${ADS_DIR}`);
  const X = (await import('xlsx')).default;
  const wb = X.readFile(join(ADS_DIR, xls));
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

/** Flatten every text string out of an A+ document's module tree. */
export function aplusText(doc) {
  const out = [];
  const walk = (n) => {
    if (n == null) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'object') {
      if (typeof n.value === 'string') out.push(n.value);
      for (const [k, v] of Object.entries(n)) { if (k !== 'value') walk(v); }
      return;
    }
  };
  walk(doc?.contentDocument?.contentModuleList ?? doc?.contentModuleList ?? doc);
  return out.join(' \n ');
}

async function fetchListing(client, asin) {
  const cat = await request(client, 'GET', `/catalog/2022-04-01/items/${asin}`, {
    marketplaceIds: getMarketplaceId(), includedData: 'summaries,attributes,images',
  });
  const a = cat.attributes ?? {};
  const val = (k) => (a[k] ?? []).map((x) => x.value ?? '').filter(Boolean);
  const title = cat.summaries?.[0]?.itemName ?? '';
  const bullets = val('bullet_point');
  const description = val('product_description').join('\n');
  const imageCount = cat.images?.[0]?.images?.length ?? 0;
  const attrs = { scent: (a.scent ?? [])[0]?.value ?? '' };

  // A+ — en_US EBC modules are what a US shopper sees. BrandStory is brand-level and
  // is NOT the product's A+ stack, so it is counted separately rather than folded in.
  //
  // THE DOCUMENT FETCH ROUTINELY FAILS ON THIS ACCOUNT AND THAT IS NOT A BUG HERE.
  // RSC's A+ uses PREMIUM modules (e.g. premium-module-2-fullbackground-image) and the
  // 2020-11-01 A+ API cannot deserialize them — it returns 400 InvalidInput rather than
  // the document. So presence is knowable and CONTENT IS NOT.
  //
  // The distinction is load-bearing: an earlier version let the empty string fall
  // through to the qualifier check, which scored every A+ surface as a MISS and
  // reported "1 of 64 checks passing" — a number produced entirely by the tool's own
  // blindness. An unreadable surface must never be scored as a failing one.
  let aplus = '', aplusRecords = [], hasEnUsEbc = false, aplusReadable = false, aplusError = null;
  try {
    const pr = await request(client, 'GET', '/aplus/2020-11-01/contentPublishRecords', {
      marketplaceId: getMarketplaceId(), asin,
    });
    const recs = pr.publishRecordList ?? [];
    aplusRecords = recs.map((r) => `${r.contentType}/${r.locale}`);
    const en = recs.filter((r) => r.contentType === 'EBC' && r.locale === 'en_US');
    hasEnUsEbc = en.length > 0;
    for (const r of en) {
      try {
        const doc = await request(client, 'GET', `/aplus/2020-11-01/contentDocuments/${r.contentReferenceKey}`, {
          marketplaceId: getMarketplaceId(), includedDataSet: 'CONTENTS',
        });
        aplus += ' \n ' + aplusText(doc);
        aplusReadable = true;
      } catch (err) {
        const d = /Unsupported content module type \[([^\]]+)\]/.exec(err.message);
        aplusError = d ? `premium module not readable by the A+ API (${d[1]})` : err.message.slice(0, 100);
      }
    }
  } catch (err) {
    aplusError = err.message.slice(0, 100);
  }
  return {
    asin, title, bullets, description, imageCount,
    aplus, aplusRecords, hasEnUsEbc, aplusReadable, aplusError, attrs,
  };
}

export async function main() {
  const jsonOut = process.argv.includes('--json');
  const onlyAsin = (() => { const i = process.argv.indexOf('--asin'); return i > -1 ? process.argv[i + 1] : null; })();

  const ap = await readAdsReport('advertised_product');
  const st = await readAdsReport('search_term');

  // campaign+adgroup → the ASINs advertised there, so a search term can be routed to
  // every listing that was eligible to serve it.
  const cAsin = col(ap, 'Advertised ASIN'), cCam = col(ap, 'Campaign Name'), cAg = col(ap, 'Ad Group Name');
  const groupAsins = new Map();
  const advertised = new Set();
  for (const r of ap) {
    const asin = String(r[cAsin] ?? '').trim();
    if (!asin) continue;
    advertised.add(asin);
    const key = `${r[cCam]}||${r[cAg]}`;
    if (!groupAsins.has(key)) groupAsins.set(key, new Set());
    groupAsins.get(key).add(asin);
  }

  const sCam = col(st, 'Campaign Name'), sAg = col(st, 'Ad Group Name');
  const sTerm = col(st, 'Customer Search Term'), sClicks = col(st, 'Clicks');
  /** asin → Map(qualifier → clicks) */
  const demand = new Map();
  for (const r of st) {
    const clicks = num(r, sClicks);
    if (!clicks) continue;
    const asins = groupAsins.get(`${r[sCam]}||${r[sAg]}`);
    if (!asins) continue;
    const quals = extractQualifiers(r[sTerm]);
    if (!quals.length) continue;
    for (const asin of asins) {
      if (!demand.has(asin)) demand.set(asin, new Map());
      const m = demand.get(asin);
      for (const q of quals) m.set(q, (m.get(q) ?? 0) + clicks);
    }
  }

  const client = getClient();
  let targets = [...advertised];
  if (onlyAsin) targets = targets.filter((a) => a === onlyAsin);

  const results = [];
  for (const asin of targets) {
    let listing;
    try { listing = await fetchListing(client, asin); }
    catch (err) { results.push({ asin, error: err.message.slice(0, 140) }); continue; }
    const brand = classifyBrand(listing.title);
    if (brand !== 'rsc') continue; // Culina is out of scope for listing content.

    const bulletText = listing.bullets.join(' \n ');
    // READABLE text only. A+ is folded in when — and only when — it was actually
    // fetched, so a listing whose ingredients live in an unreadable Premium A+ module
    // is reported as UNKNOWN rather than as missing them.
    const readable = [listing.title, bulletText, listing.description];
    if (listing.aplusReadable) readable.push(listing.aplus);
    const allText = readable.join(' \n ');

    const quals = [...(demand.get(asin) ?? new Map())]
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([qualifier, clicks]) => {
        const inTitle = surfaceConfirms(listing.title, qualifier);
        const inBullets = surfaceConfirms(bulletText, qualifier);
        const inDescription = surfaceConfirms(listing.description, qualifier);
        // null, not false — "we could not look" is a third state.
        const inAplus = listing.aplusReadable ? surfaceConfirms(listing.aplus, qualifier) : null;
        const checked = [inTitle, inBullets, inDescription, inAplus].filter((x) => x !== null);
        const hits = checked.filter(Boolean).length;
        const contradiction = hits === 0 ? contradictsProduct(qualifier, listing.attrs) : null;
        return {
          qualifier, clicks, inTitle, inBullets, inDescription, inAplus,
          hits, checked: checked.length, contradiction,
          // PASS means every surface we could actually read confirms it. It is not a
          // claim about the surfaces we could not read; those are listed separately.
          passes: hits === checked.length,
        };
      });

    const ing = findsIngredientList(allText);
    results.push({
      asin, brand, title: listing.title,
      bulletCount: listing.bullets.length,
      imageCount: listing.imageCount,
      hasEnUsEbc: listing.hasEnUsEbc,
      aplusReadable: listing.aplusReadable,
      aplusError: listing.aplusError,
      aplusRecords: listing.aplusRecords,
      ingredients: listing.aplusReadable || ing.found
        ? ing
        : { ...ing, found: false, unknown: true, reason: `${ing.reason} (A+ unreadable — may be there)` },
      qualifiers: quals,
    });
  }

  const report = { generated_at: new Date().toISOString(), scope: 'rsc', asins: results };
  if (jsonOut) { console.log(JSON.stringify(report, null, 2)); return report; }

  console.log('\nTHE 3-SECOND TEST — RSC listings');
  console.log('Qualifiers mined from real customer search terms that produced clicks on each');
  console.log("listing's own campaigns. ✓ confirms · ✗ absent · ? surface could not be read.\n");

  for (const r of results) {
    if (r.error) { console.log(`${r.asin}  ERROR ${r.error}\n`); continue; }
    console.log('─'.repeat(100));
    console.log(`${r.asin}  ${r.title.slice(0, 80)}`);
    const aplusState = !r.hasEnUsEbc ? 'NONE'
      : r.aplusReadable ? 'present, read'
      : `present but UNREADABLE — ${r.aplusError}`;
    console.log(`  bullets ${r.bulletCount} · images ${r.imageCount} · A+ en_US: ${aplusState}`);
    const ing = r.ingredients;
    console.log(`  ingredient list in readable text: ${ing.found ? `YES (${ing.count} items)` : ing.unknown ? `NOT FOUND — ${ing.reason}` : `NO — ${ing.reason}`}`);
    if (!r.qualifiers.length) { console.log('  no qualifier searches recorded for this listing'); continue; }
    console.log('  qualifier              clicks  title  bullets  descr   A+   verdict');
    for (const q of r.qualifiers) {
      const y = (b) => (b === null ? ' ? ' : b ? ' ✓ ' : ' ✗ ');
      console.log(`  ${q.qualifier.padEnd(22)} ${String(q.clicks).padStart(5)}  ${y(q.inTitle)}   ${y(q.inBullets)}    ${y(q.inDescription)}   ${y(q.inAplus)}  ${q.passes ? 'confirmed' : q.contradiction ? `NEGATE — ${q.contradiction}` : `GAP (${q.hits}/${q.checked} readable)`}`);
    }
  }

  const all = results.filter((r) => !r.error);
  // Only qualifiers clearing the click floor are counted as findings; the rest stay
  // visible in the per-listing tables but must not drive a headline number.
  const material = (r) => r.qualifiers.filter((q) => q.clicks >= MIN_QUALIFIER_CLICKS);
  const totalQ = all.reduce((a, r) => a + material(r).length, 0);
  const passQ = all.reduce((a, r) => a + material(r).filter((q) => q.passes).length, 0);
  const zeroQ = all.reduce((a, r) => a + material(r).filter((q) => q.hits === 0 && !q.contradiction).length, 0);
  const negQ = all.reduce((a, r) => a + material(r).filter((q) => q.contradiction).length, 0);
  const noIng = all.filter((r) => !r.ingredients.found).length;
  const noAplus = all.filter((r) => !r.hasEnUsEbc).length;
  const unreadableAplus = all.filter((r) => r.hasEnUsEbc && !r.aplusReadable).length;
  console.log('\n' + '═'.repeat(100));
  console.log(`SUMMARY — ${all.length} RSC listings, ${totalQ} qualifier checks at >=${MIN_QUALIFIER_CLICKS} clicks`);
  console.log(`  confirmed on every READABLE surface:      ${passQ}`);
  console.log(`  absent, product SATISFIES it → content gap: ${zeroQ}  ← fix the listing`);
  console.log(`  absent, product CONTRADICTS it → negate:   ${negQ}  ← fix the targeting, not the copy`);
  console.log(`  no ingredient list found in readable text: ${noIng} of ${all.length}`);
  console.log(`  A+ present but UNREADABLE by the API:     ${unreadableAplus} of ${all.length}`);
  console.log(`  no en_US A+ at all:                       ${noAplus} of ${all.length}`);
  console.log('\nTWO SURFACES THIS TOOL CANNOT READ — neither is scored above, and a listing is');
  console.log('NOT confirmed against the 3-second test until both are checked by eye:');
  console.log('  · IMAGES — pixels, so "is the qualifier legible in the hero/callout frame" is open.');
  console.log('  · PREMIUM A+ — the 2020-11-01 API returns 400 on premium module types.');
  console.log('A ✓ means the words exist on that text surface. It is not a claim about legibility,');
  console.log('placement, or whether a shopper finds it inside three seconds.');

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'latest.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);
  return report;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
