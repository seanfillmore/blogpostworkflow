/**
 * The theme templates may not name petrolatum, dimethicone, mineral oil or petroleum
 * jelly, and may not name a skin disease.
 *
 * Operator ruling, Sean 2026-09-09: "I have never heard a human being say petrolatum or
 * dimethicone" → "Do not use those words."
 *
 * The evidence behind it, so nobody re-adds the words believing they were a position
 * we merely lost our nerve on:
 *   · Across 3,841 real customer search terms in the 30 days to 2026-09-01,
 *     "petrolatum" appears 0 times and "dimethicone" 0 times. Where shoppers raise
 *     the concept they say "silicone" (6) or "vaseline" (2).
 *   · The implied harm has no regulatory backing — CIR, FDA, EU and Health Canada
 *     assess cosmetic-grade mineral oil and petrolatum as safe and non-comedogenic,
 *     and Germany's BfR concludes health risks "are not to be expected". The cancer
 *     association belongs to UNREFINED INDUSTRIAL grades.
 *
 * A scan rather than a lint rule because these are DATA files, not code, and the words
 * are only forbidden here — an article may still discuss the category.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATES = join(ROOT, 'theme', 'templates');

// theme/backup/ is deliberately NOT scanned: those are historical snapshots, and
// rewriting a backup to satisfy a present-day rule destroys the record it exists to be.
const liveTemplates = () =>
  readdirSync(TEMPLATES).filter((f) => f.endsWith('.json')).map((f) => join(TEMPLATES, f));

const INGREDIENT_NAMES = /petrolatum|dimethicone|mineral oil|petroleum jelly/gi;

/**
 * The one permitted disease string is a SOURCE CITATION — the name of a real research
 * body attributing a statistic. Stripping a citation would make the page less
 * verifiable, which is the opposite of the reason the rest of this sweep happened.
 */
const CITATION_ALLOWLIST = ['North American Contact Dermatitis Group'];
const DISEASE_NAMES = /eczema|psoriasis|rosacea|dermatitis/gi;

test('no live theme template names petrolatum, dimethicone, mineral oil or petroleum jelly', () => {
  const offenders = [];
  for (const path of liveTemplates()) {
    const hits = (readFileSync(path, 'utf8').match(INGREDIENT_NAMES) || []);
    if (hits.length) offenders.push(`${path.split('/').pop()}: ${hits.length} (${[...new Set(hits.map((h) => h.toLowerCase()))].join(', ')})`);
  }
  assert.deepEqual(offenders, [],
    'These words are forbidden in theme copy — say what IS in the product, or use the word a shopper actually uses ("silicone").');
});

test('no live theme template names a skin disease outside a source citation', () => {
  const offenders = [];
  for (const path of liveTemplates()) {
    let text = readFileSync(path, 'utf8');
    for (const allowed of CITATION_ALLOWLIST) text = text.split(allowed).join('');
    const hits = (text.match(DISEASE_NAMES) || []);
    if (hits.length) offenders.push(`${path.split('/').pop()}: ${[...new Set(hits.map((h) => h.toLowerCase()))].join(', ')}`);
  }
  assert.deepEqual(offenders, [],
    'A product landing page is a COMMERCIAL surface — naming a condition beside a buy button is the unapproved-drug shape lib/seo-copy-health-gate.js blocks everywhere else.');
});

test('every live template is still parseable JSON', () => {
  // The sweep rewrote raw text to preserve the \/ escaping (a JSON.parse →
  // JSON.stringify round-trip normalizes every one and buries the diff), so validity
  // is not free and has to be asserted.
  for (const path of liveTemplates()) {
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, 'utf8')), `${path} must parse`);
  }
});

test('the allowlist is a real citation, not a loophole', () => {
  // If someone widens CITATION_ALLOWLIST, this fails unless the entry still looks like
  // an attribution rather than a claim.
  for (const entry of CITATION_ALLOWLIST) {
    assert.match(entry, /Group|Journal|et al|Association|Academy|Institute/,
      `"${entry}" must name a source, not describe a product`);
  }
});
