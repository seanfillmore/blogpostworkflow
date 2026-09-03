#!/usr/bin/env node
/**
 * Rewrite the LEAD copy in the two lotion-family PDP theme templates.
 * Dry by default. `--preview` writes to an unpublished theme; `--apply` writes to LIVE.
 *
 * WHY THIS EXISTS. Rewriting `product.body_html` (scripts/rewrite-pdp-hero-copy.mjs)
 * fixed one surface and revealed two more:
 *
 *   - `coconut-lotion` uses template `landing-page-lotion`, which DOES render
 *     body_html — and also renders a theme accordion carrying a near-verbatim
 *     copy of the old chemistry text, so the page said both things at once.
 *   - `coconut-moisturizer` uses `landing-page-cream`, which does NOT render
 *     body_html at all. Its whole PDP is template copy, so the body rewrite was
 *     invisible on the storefront until this ran.
 *
 * Neither template is in this repo's partial `theme/` mirror; both are live-only.
 * Nothing in the fleet gates this surface — which is how the compliance finding
 * below survived on a live buy page.
 *
 * TWO KINDS OF EDIT, and they are not the same decision.
 *
 * 1. COMPLIANCE (would have been caught by lib/seo-copy-health-gate.js if anything
 *    gated templates). Three live strings on the cream PDP name a disease:
 *      - tab-details "Eczema-prone skin" — a list of who the product is FOR, i.e.
 *        an intended-use claim. checkSeoCopyFields returns BLOCKING, category
 *        `disease`. This is the one that genuinely had to go.
 *      - faq-2 "extremely dry or eczema-prone … can work well" — suitability, which
 *        CLAUDE.md's precedent generally KEEPS ("Oily or Acne-Prone Skin"), but the
 *        benefit verb attached to it is what tips it. Minimal removal; the answer
 *        is otherwise unchanged.
 *      - founder-body "our kids' eczema-prone patches" — founder narrative, the
 *        weakest of the three, but it describes applying the product to eczema on a
 *        page with a buy button. One word changes; the story is intact.
 *
 * 2. VOCABULARY (the claim-audit finding). `npm run claim-audit` measured brand
 *    vocabulary against 390 Judge.me reviews: `cold-pressed` 20 uses / 0 customer
 *    mentions, `cold-pressed virgin` 17/0, `organic jojoba` 10/0, `petrolatum` 8/0,
 *    `beeswax` 12/0. What buyers discuss, per product, is different — the lotion
 *    leads on absorption (45/193 absorbs, 36 not greasy), the cream on texture and
 *    placement (9/38 thick-rich-butter, 10/38 hands) — so the two get different copy.
 *
 * WHAT IS DELIBERATELY LEFT ALONE, because over-correcting is the expensive mistake
 * this repo has documented repeatedly:
 *
 *   - the ingredient CARDS on both templates. They are an ingredient-education
 *     module, and their compare-and-contrast framing ("Petrolatum is cheaper and
 *     shelf-stable forever — it also fully occludes. We pay more for beeswax") is
 *     exactly the shape the mechanism rule prescribes. Chemistry belongs in the
 *     detail module; it does not belong in the hook.
 *   - `tab-ingredients` — the literal INCI list.
 *   - every FAQ answering a question the buyer asked ("why does the texture
 *     change", "why does it smell like that", "why beeswax instead of petrolatum").
 *     That is the "why is it important" frame, not filler.
 *   - the founder block's provenance copy, minus the one disease word.
 *   - lotion faq-2's "contact dermatitis" — a cited statement about SYNTHETIC
 *     FRAGRANCE, not a claim about our product. The editorial-framing case.
 *   - lotion `benefit-1` ("Organic coconut oil and jojoba. Both are close to what
 *     your skin makes.") — plain language already, and cutting it would be the
 *     over-correction.
 *
 * MECHANICS. The template is edited as RAW TEXT, never parsed and re-serialised:
 * Shopify stores these with its own escaping and key order, and a reserialise
 * rewrites the whole file (see reference_theme_json_template_escaping). Each edit
 * asserts its JSON-encoded BEFORE occurs exactly once; a miss refuses the whole run.
 * Every AFTER is gated. Originals are written to
 * data/reports/theme-copy-rewrite/<stamp>/ before anything is pushed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getThemes, getMainThemeId, getThemeAssetRaw, updateThemeAsset } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const PREVIEW = args.includes('--preview');

const PLAN = [
  {
    key: 'templates/product.landing-page-lotion.json',
    handle: 'coconut-lotion',
    edits: [
      {
        id: 'lotion-hook',
        why: 'above-the-fold hook, written entirely in 0-mention chemistry vocabulary',
        before:
          '<p>Most lotions sit on top of your skin — mineral oil and water held together with a thickener. We built this around cold-pressed coconut oil and jojoba, which absorb into the skin barrier instead of forming a film over it.</p>',
        after:
          '<p>Most lotions sit on top of your skin — water and a thickener, and you can still feel one there an hour later. This one soaks in. Reviewers keep coming back to the same two things: how fast it absorbs, and that it does not leave them greasy.</p>',
      },
      {
        id: 'lotion-tab-details',
        why: 'the accordion duplicating the old body_html chemistry lecture',
        before:
          "<p><strong>Six clean ingredients.</strong> No mineral oil, petrolatum, dimethicone, or synthetic fragrance — the silicone-and-petroleum cocktail in most commercial lotions.</p><p><strong>Mechanism-driven moisture.</strong> Cold-pressed virgin coconut oil delivers medium-chain fatty acids the skin barrier recognizes. Jojoba mirrors skin's own sebum and absorbs without a film.</p><p><strong>Real antioxidants from unrefined red palm oil.</strong> Naturally occurring vitamin E and beta-carotene — the carotenoids refining strips out of conventional palm oil.</p><p><strong>Honest trade-off.</strong> Texture varies because cold-pressed coconut oil firms below 76°F. Shake the bottle before the first pump if stored cool.</p>",
        after:
          '<p><strong>It soaks in.</strong> Goes on smooth and absorbs quickly, without the slick film that makes you wait before getting dressed.</p><p><strong>Six ingredients.</strong> No mineral oil, no petrolatum, no synthetic fragrance — none of the filler most commercial lotions are mostly made of.</p><p><strong>The scent is the oils, not added fragrance.</strong> Light, and it fades. Pure Unscented is the same formula with none at all.</p><p><strong>Honest trade-off.</strong> The texture shifts a little batch to batch, and it firms below 76°F. Shake the bottle before the first pump if it has been stored cool.</p>',
      },
    ],
  },
  {
    key: 'templates/product.landing-page-cream.json',
    handle: 'coconut-moisturizer',
    edits: [
      {
        id: 'cream-hook',
        why: 'above-the-fold hook, pure chemistry; this template does not render body_html at all',
        before:
          '<p>Beeswax forms a breathable film that locks moisture in without sealing the skin closed the way petrolatum does. Cold-pressed virgin coconut oil delivers medium-chain fatty acids that absorb into the skin barrier rather than coating it.</p>',
        after:
          '<p>Thicker than a lotion — closer to a balm. It goes on like butter and works in, and reviewers reach for it on hands, knees, legs and feet. A little covers more than you expect.</p>',
      },
      {
        id: 'cream-tab-details',
        why: 'BLOCKING disease claim ("Eczema-prone skin") plus chemistry-led framing',
        compliance: true,
        before:
          '<p><strong>Beeswax barrier, not petrolatum.</strong> Locks moisture against the skin without sealing pores closed the way petroleum-based occlusives do.</p><p><strong>Built for the customer who needs more than a lotion.</strong> Eczema-prone skin, extreme dryness, post-shower routines, hands-and-feet rescue, overnight occlusion.</p><p><strong>Plant-based body, no synthetic thickeners.</strong> Palm stearic gives the cream its rich texture; cheaper alternatives use stearyl alcohol or PEG derivatives.</p><p><strong>Honest trade-off.</strong> Closer to a balm than a pump cream. Firms in cold weather because beeswax does. Not for fast-absorption daytime use.</p>',
        after:
          '<p><strong>Thick, but it does not sit on you.</strong> It goes on like butter and works in — heavy enough for rough spots, without the slick film.</p><p><strong>Built for the places a lotion does not fix.</strong> Hands, knees, legs and feet, extreme dryness, post-shower routines, overnight.</p><p><strong>A little goes a long way.</strong> A tiny bit covers more than a pump of lotion does.</p><p><strong>Honest trade-off.</strong> Closer to a balm than a pump cream. It firms in cold weather because beeswax does. Not a fast-absorbing daytime lotion.</p>',
      },
      {
        id: 'cream-benefit-1',
        why: 'benefit bullet led with an ingredient nobody mentions rather than the benefit',
        before: 'Organic beeswax — true breathable barrier, locks moisture in',
        after: 'Thick enough for hands, knees and feet. A little goes a long way.',
      },
      {
        id: 'cream-faq-2-eczema',
        why: 'suitability wording with a benefit verb attached to a disease word; minimal removal',
        compliance: true,
        before: 'If your face is extremely dry or eczema-prone, a thin layer at night can work well.',
        after: 'If your face is extremely dry, a thin layer at night can work well.',
      },
      {
        id: 'cream-founder-eczema',
        why: 'founder narrative describing applying the product to eczema, on a page with a buy button',
        compliance: true,
        before: "a barrier cream we could use on our kids' eczema-prone patches",
        after: "a barrier cream we could use on our kids' driest patches",
      },
    ],
  },
];

/**
 * The JSON-encoded form of a value as it sits inside the stored template text.
 *
 * Shopify serialises these templates with forward slashes escaped — `</p>` is
 * stored as `<\/p>` — which `JSON.stringify` does not do. Both forms decode to
 * the same string, so the candidate that actually occurs is the one to match on;
 * getting this wrong is a silent no-match, which is why the caller refuses on any
 * count other than exactly 1 rather than assuming a miss means "already applied".
 */
const encodedForms = (s) => {
  const plain = JSON.stringify(s).slice(1, -1);
  const slashEscaped = plain.replace(/\//g, '\\/');
  return slashEscaped === plain ? [plain] : [slashEscaped, plain];
};

/** Pick the encoding that appears in `text`, or null when neither appears exactly once. */
function resolveEncoding(text, value) {
  for (const form of encodedForms(value)) {
    if (countOccurrences(text, form) === 1) return form;
  }
  return null;
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n += 1;
    i = at + needle.length;
  }
}

async function main() {
  if (APPLY && PREVIEW) throw new Error('Pass --preview or --apply, not both.');

  // Gate every AFTER before reading a single theme asset.
  const fields = {};
  for (const t of PLAN) for (const e of t.edits) fields[`${t.handle}:${e.id}`] = e.after;
  const gate = checkSeoCopyFields(fields);
  if (!gate.ok) {
    console.error('REFUSED — replacement copy fails the SEO copy health gate:');
    for (const v of gate.blocking) console.error(`  [${v.category}] ${v.field}: "${v.match}"`);
    process.exit(1);
  }
  for (const a of gate.advisory || []) console.log(`  advisory [${a.category}] ${a.field}: "${a.match}"`);
  console.log(`Health gate: PASS on ${Object.keys(fields).length} replacement strings`);

  // Confirm the BEFOREs still carry the claims this run says they do, rather than
  // trusting the header. A compliance edit whose BEFORE is already clean is a
  // stale plan, not a fix.
  const beforeFields = {};
  for (const t of PLAN) for (const e of t.edits) if (e.compliance) beforeFields[`${t.handle}:${e.id}`] = e.before;
  const beforeGate = checkSeoCopyFields(beforeFields);
  const flagged = new Set((beforeGate.blocking || []).map((v) => v.field));
  console.log(`Compliance entries: ${Object.keys(beforeFields).length}, of which ${flagged.size} trip the blocking tier today`);
  for (const v of beforeGate.blocking || []) console.log(`  BLOCKING today [${v.category}] ${v.field}: "${v.match}"`);

  const liveId = await getMainThemeId();
  let targetId = liveId;
  let targetName = 'LIVE';
  if (PREVIEW) {
    const themes = await getThemes();
    const unpub = themes.filter((t) => t.role === 'unpublished').sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (!unpub.length) throw new Error('No unpublished theme to preview into.');
    targetId = unpub[0].id;
    targetName = `PREVIEW "${unpub[0].name}" (${targetId})`;
  }
  console.log(`\nSource: live theme ${liveId} · Target: ${targetName}\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'theme-copy-rewrite', stamp);
  const results = [];

  for (const t of PLAN) {
    const asset = await getThemeAssetRaw(liveId, t.key);
    if (!asset || typeof asset.value !== 'string') throw new Error(`Could not read ${t.key} from theme ${liveId}.`);
    let text = asset.value;
    const original = text;

    for (const e of t.edits) {
      const alreadyThere = encodedForms(e.after).some((f) => text.includes(f));
      const beforeStillThere = encodedForms(e.before).some((f) => text.includes(f));
      if (alreadyThere && !beforeStillThere) {
        console.log(`  ${t.key} :: ${e.id} — already applied.`);
        results.push({ key: t.key, id: e.id, outcome: 'already-applied' });
        continue;
      }
      const encBefore = resolveEncoding(text, e.before);
      if (!encBefore) {
        const counts = encodedForms(e.before).map((f) => countOccurrences(text, f)).join('/');
        throw new Error(
          `${t.key} :: ${e.id} — expected exactly 1 occurrence of the BEFORE, found ${counts} ` +
            `across the candidate encodings. The template has changed since this plan was ` +
            `written; refusing the whole run.`
        );
      }
      // Match the encoding actually in use so the file's escaping style is preserved.
      const encAfter = encBefore.includes('\\/')
        ? JSON.stringify(e.after).slice(1, -1).replace(/\//g, '\\/')
        : JSON.stringify(e.after).slice(1, -1);
      text = text.replace(encBefore, encAfter);
      console.log(`  ${t.key} :: ${e.id} — rewritten${e.compliance ? ' (compliance)' : ''}`);
      results.push({ key: t.key, id: e.id, outcome: 'rewritten', compliance: Boolean(e.compliance) });
    }

    if (text === original) {
      console.log(`  ${t.key}: no change needed.`);
      continue;
    }

    // JSON.parse is a VALIDATION step only — the text pushed is the edited raw
    // string, never a reserialisation of this object.
    try {
      JSON.parse(text);
    } catch (err) {
      throw new Error(`${t.key} — edited template is not valid JSON (${err.message}); refusing to push.`);
    }

    mkdirSync(dir, { recursive: true });
    const base = t.key.replace(/\//g, '__');
    writeFileSync(join(dir, `${base}.before`), original);
    writeFileSync(join(dir, `${base}.after`), text);

    if (!APPLY && !PREVIEW) {
      console.log(`  ${t.key}: DRY RUN — ${original.length}b → ${text.length}b (backup in ${dir}/)`);
      continue;
    }
    await updateThemeAsset(targetId, t.key, text);
    console.log(`  ${t.key}: PUSHED to theme ${targetId}`);
  }

  if (results.length) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ at: new Date().toISOString(), liveThemeId: liveId, targetThemeId: targetId, preview: PREVIEW, applied: APPLY, results }, null, 2)
    );
    console.log(`\nRun record: ${dir}/run.json`);
  }
  if (!APPLY && !PREVIEW) console.log('\nDRY RUN — pass --preview to stage on an unpublished theme, or --apply to write LIVE.');
  if (PREVIEW) {
    console.log(`\nPreview:  https://www.realskincare.com/products/coconut-lotion?preview_theme_id=${targetId}`);
    console.log(`          https://www.realskincare.com/products/coconut-moisturizer?preview_theme_id=${targetId}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
