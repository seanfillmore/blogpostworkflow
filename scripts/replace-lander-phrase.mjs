#!/usr/bin/env node
/**
 * Replace a phrase across every bundle-lander surface at once.
 *
 *   node scripts/replace-lander-phrase.mjs --from "singly" --to "on their own"
 *   node scripts/replace-lander-phrase.mjs --from "singly" --to "on their own" --apply
 *
 * ── WHY A TOOL AND NOT A HAND EDIT ──────────────────────────────────────────
 * A wording change never lives in one place. "singly" was in SEVEN metaobject
 * fields across five landers and THREE product descriptions — and the product
 * description matters most, because `seo.description` is null on these products,
 * so the body is also the meta description, the og/twitter tags and the
 * ProductGroup JSON-LD. Fixing the visible copy and missing the description is
 * how a corrected phrase survives in the SERP snippet.
 *
 * ── IT IS WORD-BOUNDARY MATCHED, DELIBERATELY ───────────────────────────────
 * A substring replace of "singly" would also hit nothing here, but a substring
 * replace of, say, "single" would hit "singles" and "single order". The operator
 * objected to the ADVERB "singly" and not the noun "singles" ("twelve singles"
 * reads fine), so the boundary is what keeps the two apart.
 *
 * ── EVERY REWRITE IS RE-GATED ───────────────────────────────────────────────
 * The replacement text goes through checkSeoCopyFields before anything is
 * written, per the SEO-copy rule: this writes live product descriptions and
 * metaobject copy, which are exactly the surfaces the gate exists for.
 */

import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

/** Lander metaobjects, plus the product each one backs. */
export const LANDERS = Object.freeze({
  'clean-swap': 'gid://shopify/Metaobject/219719139498',
  '90-day-clean-swap': 'gid://shopify/Metaobject/219195736234',
  'head-to-toe': 'gid://shopify/Metaobject/219322482858',
  'gift-box': 'gid://shopify/Metaobject/219719565482',
  '99-coconut-reset-digital': 'gid://shopify/Metaobject/220166586538',
});

/** Fields that hold prose. `faq`/`tabs` are JSON blobs and are rewritten as text. */
export const TEXT_FIELDS = Object.freeze([
  'heading', 'subheading', 'cta_label', 'rating_caption', 'bullets', 'buybox_bullets',
  'whats_in_it_note', 'faq', 'tabs', 'founder_note', 'stats', 'timeline',
  'mechanism', 'ingredient_cards', 'timeline_eyebrow', 'timeline_heading', 'timeline_lede',
]);

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Word-boundary pattern for a phrase — but `\b` is applied ONLY where the phrase
 * actually starts or ends in a word character.
 *
 * A flat `\b<phrase>\b` can never match a phrase beginning or ending in
 * punctuation: `\b$10\b` requires a word boundary immediately before `$`, and
 * there is none, so the phrase silently never applies. That is not hypothetical
 * here — CLAUDE.md records the identical defect in `agents/internal-linker`,
 * where a suggestion like `FAQ (2026)` was reported as applicable and then never
 * applied. A copy sweep that reports "0 occurrences" for a phrase that is plainly
 * on the page is the same failure wearing a quieter costume.
 */
export function phraseRe(from, flags = 'g') {
  const left = /^\w/.test(from) ? '\\b' : '';
  const right = /\w$/.test(from) ? '\\b' : '';
  return new RegExp(`${left}${escapeRe(from)}${right}`, flags);
}

/** Whole-word where the phrase is a word, case-sensitive. */
export function replacePhrase(text, from, to) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(phraseRe(from), to);
}

export function countPhrase(text, from) {
  if (typeof text !== 'string' || !text) return 0;
  return (text.match(phraseRe(from)) || []).length;
}

export function parseArgs(argv) {
  const a = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--from') a.from = argv[++i];
    else if (t === '--to') a.to = argv[++i];
    else if (t === '--apply') a.apply = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else throw new Error(`unknown argument: ${t}`);
  }
  return a;
}

export function validate(a) {
  if (!a.from) return { ok: false, reason: '--from is required' };
  if (a.to === undefined) return { ok: false, reason: '--to is required (pass "" to delete the phrase)' };
  if (a.from === a.to) return { ok: false, reason: '--from and --to are identical' };
  return { ok: true };
}

async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 1; }
  if (a.help) { console.log('Usage: --from <phrase> --to <phrase> [--apply]'); return 0; }
  const v = validate(a);
  if (!v.ok) { console.error(`REFUSED: ${v.reason}`); return 64; }

  const { shopifyGraphQL } = await import('../lib/shopify.js');
  let hits = 0;
  const moWrites = [];
  const prodWrites = [];

  for (const [handle, id] of Object.entries(LANDERS)) {
    const r = await shopifyGraphQL(`{ metaobject(id:"${id}"){ fields{ key value } } }`);
    const fields = [];
    for (const f of r.metaobject.fields) {
      if (!TEXT_FIELDS.includes(f.key)) continue;
      const n = countPhrase(f.value, a.from);
      if (!n) continue;
      const next = replacePhrase(f.value, a.from, a.to);
      hits += n;
      console.log(`  ${handle}  ${f.key}  (${n})`);
      for (const m of f.value.match(new RegExp(`[^."]{0,60}${phraseRe(a.from).source}[^.",]{0,30}`, 'g')) || []) {
        console.log(`      - ${m.trim()}`);
        console.log(`      + ${replacePhrase(m.trim(), a.from, a.to)}`);
      }
      fields.push({ key: f.key, value: next });
    }
    if (fields.length) moWrites.push({ handle, id, fields });
  }

  for (const handle of Object.keys(LANDERS)) {
    const r = await shopifyGraphQL(
      `{ productByIdentifier(identifier:{handle:"${handle}"}){ id descriptionHtml seo{ title description } } }`,
    );
    const p = r.productByIdentifier;
    if (!p) continue;

    const nBody = countPhrase(p.descriptionHtml, a.from);
    // `seo.description` is the `description_tag` metafield and is a SEPARATE
    // surface from the body — it is what the SERP snippet, og and twitter tags
    // actually use when it is set. Sweeping only the body left the old phrase in
    // the meta description on two of six landers, visible in search and in every
    // share card, while the page itself read correctly. `seo.title` is swept for
    // the same reason.
    const nSeoD = countPhrase(p.seo?.description, a.from);
    const nSeoT = countPhrase(p.seo?.title, a.from);
    if (!nBody && !nSeoD && !nSeoT) continue;
    hits += nBody + nSeoD + nSeoT;

    const w = { handle, id: p.id };
    if (nBody) { w.html = replacePhrase(p.descriptionHtml, a.from, a.to); console.log(`  ${handle}  product description  (${nBody})`); }
    if (nSeoD) { w.seoDescription = replacePhrase(p.seo.description, a.from, a.to); console.log(`  ${handle}  meta description  (${nSeoD})  — the SERP snippet`); }
    if (nSeoT) { w.seoTitle = replacePhrase(p.seo.title, a.from, a.to); console.log(`  ${handle}  meta title  (${nSeoT})`); }
    prodWrites.push(w);
  }

  if (!hits) { console.log(`\n"${a.from}" does not appear on any lander surface.`); return 0; }

  const gate = {};
  for (const w of moWrites) for (const f of w.fields) gate[`${w.handle} ${f.key}`] = f.value;
  for (const w of prodWrites) {
    if (w.html) gate[`${w.handle} description`] = w.html;
    if (w.seoDescription) gate[`${w.handle} meta description`] = w.seoDescription;
    if (w.seoTitle) gate[`${w.handle} meta title`] = w.seoTitle;
  }
  const g = checkSeoCopyFields(gate);
  if (!g.ok) {
    console.error('\nBLOCKED by the copy gate — nothing written:');
    for (const c of g.claims) console.error(`  ${c.field}: ${c.category} — "${c.match}"`);
    return 1;
  }
  console.log('\nhealth gate: every rewrite clear');

  if (!a.apply) {
    console.log(`${hits} occurrence(s) across ${moWrites.length} metaobject(s) and ${prodWrites.length} description(s). Re-run with --apply.`);
    return 0;
  }

  for (const w of moWrites) {
    const res = await shopifyGraphQL(
      `mutation($id:ID!, $fields:[MetaobjectFieldInput!]!){
         metaobjectUpdate(id:$id, metaobject:{fields:$fields}){ userErrors{ field message } } }`,
      { id: w.id, fields: w.fields },
    );
    if (res.metaobjectUpdate.userErrors.length) { console.error(w.handle, res.metaobjectUpdate.userErrors); return 1; }
  }
  for (const w of prodWrites) {
    const input = { id: w.id };
    if (w.html) input.descriptionHtml = w.html;
    if (w.seoDescription || w.seoTitle) {
      input.seo = {};
      if (w.seoDescription) input.seo.description = w.seoDescription;
      if (w.seoTitle) input.seo.title = w.seoTitle;
    }
    const res = await shopifyGraphQL(
      'mutation($in:ProductUpdateInput!){ productUpdate(product:$in){ userErrors{ field message } } }',
      { in: input },
    );
    if (res.productUpdate.userErrors.length) { console.error(w.handle, res.productUpdate.userErrors); return 1; }
  }
  console.log(`rewrote ${hits} occurrence(s). Verify the rendered pages before calling this done.`);
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
