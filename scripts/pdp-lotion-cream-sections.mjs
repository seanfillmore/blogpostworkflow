#!/usr/bin/env node
/**
 * Lotion + cream PDPs: name the top pre-purchase objection with real proof beside
 * it, and give the cream a SERP title that matches what shoppers search.
 *
 *   node scripts/pdp-lotion-cream-sections.mjs --theme <id>                 # dry: templates vs that theme
 *   node scripts/pdp-lotion-cream-sections.mjs --theme <id> --apply         # write templates to that theme + repo mirror
 *   node scripts/pdp-lotion-cream-sections.mjs --metafields [--apply]       # cream title_tag / description_tag (live)
 *
 * TEMPLATES ARE BUILT FROM THE REPO, NEVER FROM LIVE. PR #866 swept ingredient
 * names out of theme/templates on main, but on 2026-09-11 that sweep was still
 * unpublished — held on preview theme 148727070890 at the operator's request.
 * Reading live and writing it back (or writing live's JSON into the repo mirror,
 * which scripts/build-product-templates.mjs does on --apply) would re-publish the
 * old text and silently revert #866 in git. So the base is the committed mirror,
 * `applyManifest` brings the shared blocks current (the lotion trust-line quote),
 * this plan is layered on top, and the target theme must still hold exactly the
 * committed version — anything else is somebody's unmerged work and is refused.
 * The PUBLISHED theme is refused without --live, because publishing this also
 * publishes the #866 sweep, which is not this script's decision.
 *
 * WHY THE LOTION SECTION. Absorption is the dominant pre-purchase anxiety in
 * data/context/voice-of-customer.md — "natural oils don't absorb / greasy baked
 * good" (5 mentions) and "too thin or too greasy" (5). The first section under
 * the lotion's buy box already talked about absorption, but as an assertion with
 * no proof in it, and its contrast — "most lotions sit on top of your skin —
 * water and a thickener" — describes THIS lotion's own ingredient list (purified
 * spring water, plant-based emulsifying wax). That contrast is the likeliest
 * source of the "no water" claim product-optimizer published on 2026-09-10. It is
 * rewritten as a NAMED question with verbatim coconut-lotion reviews inside it,
 * per marketing-conversion-friction-audit's top-objection rule (a named section
 * with proof, never an FAQ line).
 *
 * WHY THE CREAM TITLE. 3,106 impressions / 90d, average position 28.7, 1 click
 * (GSC, to 2026-09-10). The rendered <title> was "Coconut Moisturizer – Real Skin
 * Care" — no "cream" — while nearly every query it earns impressions on carries
 * the word. DataForSEO, 2026-09-10: "coconut body cream" 320/mo and "coconut oil
 * cream" 320/mo return all-product-page SERPs a PDP can win, while "coconut oil
 * moisturizer" (5,400/mo) is an informational SERP (Reddit, Healthline, Byrdie).
 * 38 of the internal links pointing at this page already use "organic body
 * cream" / "coconut body cream" anchors. So the title leads with the cream.
 *
 * THE PRODUCT TITLE IS NOT TOUCHED. Klaviyo's live post-purchase and reorder
 * flows branch on `"Coconut Moisturizer" in items` (data/brand/email-rebuild/
 * specs.js), which matches the ORDER LINE ITEM title. Renaming the product would
 * silently drop cream buyers out of those branches. `title_tag` changes the SERP
 * and nothing an order records.
 *
 * WHAT MAY NOT BE WRITTEN. Every AFTER must clear: the SEO copy health gate on the
 * commercial surface, the ad-copy health gate, the SERP length check, the
 * ingredient-absence check against the template's OWN Ingredients tab, and the
 * operator's FORBIDDEN_EVEN_NEGATED terms, read from agents/pdp-builder/lib/
 * validators.js rather than restated (never name mineral oil, petrolatum or
 * dimethicone — not even as "no …"; "petroleum jelly" is allowed, ruling 2026-09-11). Quotes are verbatim Judge.me
 * reviews OF THE PRODUCT WHOSE PAGE SHOWS THEM; REVIEWS records each review id.
 *
 * SAFETY. Dry by default. A value matching neither BEFORE nor AFTER is DRIFT and
 * is skipped, never overwritten. Idempotent. The target's current value is backed
 * up before any write and read back after; the repo mirror is written only when
 * the readback matches. Backups land under the MAIN checkout, because this runs
 * from a worktree whose removal would delete them.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { isDirectRun } from '../lib/is-direct-run.js';
import { serialize, applyManifest } from './build-product-templates.mjs';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { checkCopyLength } from '../lib/seo-copy-length.js';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';
import { ingredientAbsenceCheck, ingredientTextFromTemplate } from '../lib/ingredient-absence-claims.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Verbatim Judge.me review excerpts, each shown only on the page of the product
 * it reviews. `verification` is Judge.me's own field.
 */
export const REVIEWS = Object.freeze({
  lotionNicole: { reviewId: 759720336, handle: 'coconut-lotion', createdAt: '2025-02-13', rating: 5, verification: 'verified-purchase', name: 'Nicole H.', excerpt: 'It absorbs quickly yet is effective all day.' },
  lotionSuzy: { reviewId: 514327215, handle: 'coconut-lotion', createdAt: '2023-05-01', rating: 5, verification: 'none', name: 'Suzy', excerpt: '…even my husband, who doesn’t like lotions, loved how easily this soaked into his dry skin.' },
  lotionMike: { reviewId: 593827114, handle: 'coconut-lotion', createdAt: '2024-05-28', rating: 5, verification: 'email', name: 'Mike G.', excerpt: 'It absorbs quickly, is not greasy like some lotions can be, and has a great scent.' },
  creamNicole: { reviewId: 759721043, handle: 'coconut-moisturizer', createdAt: '2025-02-13', rating: 5, verification: 'verified-purchase', name: 'Nicole H.', excerpt: "This is THE moisturizer for Wisconsin winters for my whole family. It's long lasting and doesn't feel greasy." },
  creamElla: { reviewId: 514327202, handle: 'coconut-moisturizer', createdAt: '2023-12-31', rating: 5, verification: 'buyer', name: 'Ella M.', excerpt: 'Incredibly soft. Doesn’t make you feel greasy or sticky after use.' },
});

const VERIFIED = new Set(['verified-purchase', 'buyer']);

export function quoteHtml(r) {
  const who = VERIFIED.has(r.verification) ? `${r.name}, verified buyer` : r.name;
  return `<p><em>&ldquo;${r.excerpt}&rdquo;</em> &mdash; ${who}</p>`;
}

const proofBlock = (...reviews) => ({
  type: 'text',
  settings: {
    text: reviews.map(quoteHtml).join(''),
    text_size: 'typeset',
    secondary_color: false,
    enable_highlight: false,
    highlight_style: 'marker',
  },
});

export const TEMPLATE_PLAN = [
  {
    file: 'product.landing-page-lotion.json',
    handle: 'coconut-lotion',
    section: 'hook-rich-text',
    edits: [
      {
        block: 'hook-heading',
        key: 'heading',
        before: 'Built around oils your skin actually recognizes.',
        after: 'Will a coconut oil lotion leave you greasy?',
      },
      {
        block: 'hook-text',
        key: 'text',
        before: '<p>Most lotions sit on top of your skin — water and a thickener, and you can still feel one there an hour later. This one soaks in. Reviewers keep coming back to the same two things: how fast it absorbs, and that it does not leave them greasy.</p>',
        after: "<p>It's the fair question. Straight coconut oil can sit on your skin for a long time. This isn't straight oil — it's a lotion built on coconut oil and jojoba, which is close to the oil your skin makes. Reviewers keep coming back to how quickly it soaks in.</p>",
      },
    ],
    insert: { id: 'hook-proof', after: 'hook-text', block: proofBlock(REVIEWS.lotionNicole, REVIEWS.lotionSuzy) },
    reviews: ['lotionNicole', 'lotionSuzy'],
  },
  {
    file: 'product.landing-page-cream.json',
    handle: 'coconut-moisturizer',
    section: 'hook-rich-text',
    edits: [
      {
        block: 'hook-heading',
        key: 'heading',
        before: 'Built around what locks moisture in — not what seals it out.',
        after: 'A coconut oil body cream thick enough for heels, hands and elbows.',
      },
    ],
    insert: { id: 'hook-proof', after: 'hook-text', block: proofBlock(REVIEWS.creamNicole, REVIEWS.creamElla) },
    reviews: ['creamNicole', 'creamElla'],
  },
];

export const METAFIELD_PLAN = [
  {
    handle: 'coconut-moisturizer',
    file: 'product.landing-page-cream.json',
    key: 'title_tag',
    kind: 'title',
    before: 'Coconut Moisturizer – Real Skin Care',
    after: 'Coconut Oil Body Cream — Thick Moisturizer',
  },
  {
    handle: 'coconut-moisturizer',
    file: 'product.landing-page-cream.json',
    key: 'description_tag',
    kind: 'description',
    before: 'A thicker cream with beeswax, coconut oil and red palm oil. No petroleum jelly, no silicones, no added fragrance. For skin that needs more than a lotion.',
    after: 'A thick coconut oil body cream with beeswax and red palm oil, for hands, heels, elbows and knees. No synthetic fragrance, no parabens.',
  },
];

const readRepo = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
const parseTemplate = (raw) => JSON.parse(String(raw).replace(/^\s*\/\*[\s\S]*?\*\//, ''));

/** The operator's never-name list, read from the validator that owns it. */
export function forbiddenEvenNegated(read = readRepo) {
  const src = read('agents/pdp-builder/lib/validators.js');
  const m = src?.match(/FORBIDDEN_EVEN_NEGATED\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('FORBIDDEN_EVEN_NEGATED not found in agents/pdp-builder/lib/validators.js');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase());
}

/** Every string this plan would publish, and where it goes. */
export function planTexts() {
  const texts = [];
  for (const e of TEMPLATE_PLAN) {
    for (const ed of e.edits) texts.push({ where: `${e.file} ${ed.block}.${ed.key}`, text: ed.after, file: e.file });
    texts.push({ where: `${e.file} ${e.insert.id}`, text: e.insert.block.settings.text, file: e.file });
  }
  for (const m of METAFIELD_PLAN) texts.push({ where: `${m.handle} ${m.key}`, text: m.after, file: m.file });
  return texts;
}

/**
 * Every gate over every AFTER. `templates` maps file → template JSON (string or
 * parsed) so the ingredient check reads the page's own Ingredients tab.
 * Returns failure strings; empty means publishable.
 */
export function gateCopy({ templates = {}, forbidden }) {
  const failures = [];
  for (const t of planTexts()) {
    const plain = t.text.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
    const health = checkSeoCopyFields({ [t.where]: t.text });
    if (!health.ok) failures.push(`${t.where}: SEO health gate — ${health.blocking.map((v) => v.match).join(', ')}`);
    if (hasHealthClaim(plain)) failures.push(`${t.where}: ad-copy health gate`);
    const named = forbidden.find((w) => plain.toLowerCase().includes(w));
    if (named) failures.push(`${t.where}: names "${named}" (FORBIDDEN_EVEN_NEGATED)`);
    const check = templates[t.file] ? ingredientAbsenceCheck(ingredientTextFromTemplate(templates[t.file])) : null;
    if (!check) failures.push(`${t.where}: no ingredient list to check against`);
    else for (const v of check.check({ [t.where]: t.text })) failures.push(`${t.where}: ${v.why}`);
  }
  for (const m of METAFIELD_PLAN) {
    if (!checkCopyLength({ f: m.after }, { f: m.kind }).ok) failures.push(`${m.handle} ${m.key}: over the ${m.kind} length limit`);
  }
  return failures;
}

/**
 * Apply one template entry to a parsed template, in place. Pure.
 * outcome: 'changed' | 'already-applied' | 'drifted' (nothing mutated).
 */
export function applyTemplateEntry(parsed, entry) {
  const sec = parsed.sections?.[entry.section];
  if (!sec) throw new Error(`${entry.file}: no section "${entry.section}"`);
  const drift = [];
  for (const ed of entry.edits) {
    const live = sec.blocks?.[ed.block]?.settings?.[ed.key];
    if (live !== ed.before && live !== ed.after) drift.push(`${ed.block}.${ed.key}`);
  }
  const existing = sec.blocks?.[entry.insert.id];
  if (existing && existing.settings?.text !== entry.insert.block.settings.text) drift.push(`${entry.insert.id} exists with different text`);
  if (!existing && !sec.block_order?.includes(entry.insert.after)) drift.push(`anchor ${entry.insert.after} missing`);
  if (drift.length) return { outcome: 'drifted', drift, notes: [] };

  const notes = [];
  for (const ed of entry.edits) {
    const settings = sec.blocks[ed.block].settings;
    if (settings[ed.key] !== ed.after) {
      settings[ed.key] = ed.after;
      notes.push(`${ed.block}.${ed.key}`);
    }
  }
  if (!existing) {
    sec.blocks[entry.insert.id] = structuredClone(entry.insert.block);
    sec.block_order.splice(sec.block_order.indexOf(entry.insert.after) + 1, 0, entry.insert.id);
    notes.push(`inserted ${entry.insert.id} after ${entry.insert.after}`);
  }
  return { outcome: notes.length ? 'changed' : 'already-applied', drift: [], notes };
}

/**
 * The full template this change ships, built from the COMMITTED mirror: shared
 * blocks brought current by the builder's own manifest, then this plan on top.
 * Pure given `read`.
 */
export function buildTemplate(entry, read = readRepo) {
  const repoRaw = read(`theme/templates/${entry.file}`);
  if (repoRaw == null) throw new Error(`theme/templates/${entry.file} missing`);
  const parsed = parseTemplate(repoRaw);
  const r = applyTemplateEntry(parsed, entry);
  if (r.outcome === 'drifted') return { ...r, repoRaw, out: null };
  const manifestNotes = applyManifest(parsed, entry.file, read);
  return { ...r, notes: [...manifestNotes, ...r.notes], repoRaw, out: serialize(parsed) };
}

/** Structural equality, so a theme's own escaping or whitespace is not "drift". */
export const sameTemplate = (a, b) => a != null && b != null
  && JSON.stringify(parseTemplate(a)) === JSON.stringify(parseTemplate(b));

/** The main checkout, so backups survive `git worktree remove`. */
function durableRoot() {
  try {
    const common = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: ROOT }).toString().trim();
    return dirname(common);
  } catch {
    return ROOT;
  }
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const THEME = argValue('--theme');
  const LIVE = process.argv.includes('--live');
  const METAFIELDS = process.argv.includes('--metafields');
  if (!THEME && !METAFIELDS) {
    console.error('Nothing to do: pass --theme <id> for the templates and/or --metafields for the cream SEO fields.');
    process.exit(64);
  }
  const shopify = await import('../lib/shopify.js');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(durableRoot(), 'data', 'reports', 'pdp-lotion-cream-sections', stamp);
  const results = [];

  const repoTemplates = Object.fromEntries(
    [...new Set([...TEMPLATE_PLAN, ...METAFIELD_PLAN].map((e) => e.file))].map((f) => [f, readRepo(`theme/templates/${f}`)]),
  );
  const failures = gateCopy({ templates: repoTemplates, forbidden: forbiddenEvenNegated() });
  if (failures.length) {
    console.error('REFUSED — copy fails a gate:');
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`Gates: PASS on ${planTexts().length} strings\n`);

  if (THEME) {
    const theme = (await shopify.getThemes()).find((t) => String(t.id) === String(THEME));
    if (!theme) throw new Error(`theme ${THEME} not found`);
    console.log(`Target theme: ${theme.name} (${theme.id}, role=${theme.role})`);
    if (theme.role === 'main' && !LIVE) {
      console.error('REFUSED — that is the PUBLISHED theme. Publishing these templates also publishes the #866 ingredient sweep; pass --live only once that is decided.');
      process.exit(1);
    }
    for (const e of TEMPLATE_PLAN) {
      const key = `templates/${e.file}`;
      const built = buildTemplate(e);
      if (built.outcome === 'drifted') {
        console.log(`${e.file}: repo mirror DRIFT — ${built.drift.join(', ')}`);
        results.push({ file: e.file, outcome: 'drifted', drift: built.drift });
        continue;
      }
      const target = await shopify.getThemeAsset(theme.id, key);
      const row = { file: e.file, theme: theme.id, notes: built.notes };
      results.push(row);
      if (sameTemplate(target, built.out)) { row.outcome = 'already-applied'; console.log(`${e.file}: already applied on ${theme.id}`); continue; }
      if (!sameTemplate(target, built.repoRaw)) {
        row.outcome = 'target-differs';
        console.log(`${e.file}: REFUSED — theme ${theme.id} does not hold the committed version; it carries someone else's changes.`);
        continue;
      }
      row.outcome = APPLY ? 'applied' : 'would-apply';
      console.log(`${e.file}: ${APPLY ? 'writing' : 'would write'} — ${built.notes.join(', ')}`);
      if (!APPLY) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${theme.id}.${e.file}.before`), target);
      writeFileSync(join(dir, `${theme.id}.${e.file}.after`), built.out);
      await shopify.updateThemeAsset(theme.id, key, built.out);
      row.readback = sameTemplate(await shopify.getThemeAsset(theme.id, key), built.out);
      console.log(`    readback matches: ${row.readback}`);
      if (row.readback) writeFileSync(join(ROOT, 'theme', 'templates', e.file), built.out);
    }
  }

  if (METAFIELDS) {
    const products = await shopify.getProducts({ limit: 250 });
    for (const m of METAFIELD_PLAN) {
      const p = products.find((x) => x.handle === m.handle);
      if (!p) { results.push({ field: `${m.handle}.${m.key}`, outcome: 'not-found' }); continue; }
      const cur = (await shopify.getMetafields('products', p.id)).find((x) => x.namespace === 'global' && x.key === m.key);
      const value = cur?.value ?? null;
      const row = { field: `${m.handle}.${m.key}`, before: value };
      results.push(row);
      if (value === m.after) { row.outcome = 'already-applied'; console.log(`${m.handle} ${m.key}: already applied`); continue; }
      if (value !== m.before) { row.outcome = 'drifted'; console.log(`${m.handle} ${m.key}: DRIFT — live is ${JSON.stringify(value)}`); continue; }
      row.outcome = APPLY ? 'applied' : 'would-apply';
      console.log(`${m.handle} ${m.key}: ${APPLY ? 'writing' : 'would write'} ${JSON.stringify(m.after)}`);
      if (!APPLY) continue;
      await shopify.upsertMetafield('products', p.id, 'global', m.key, m.after, cur?.type || 'single_line_text_field');
      const back = (await shopify.getMetafields('products', p.id)).find((x) => x.namespace === 'global' && x.key === m.key);
      row.readback = back?.value === m.after;
      console.log(`    readback identical: ${row.readback}`);
    }
  }

  if (APPLY) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
    console.log(`\nRun record + backups: ${dir}`);
  } else {
    console.log('\nDRY RUN — pass --apply to write.');
  }
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
