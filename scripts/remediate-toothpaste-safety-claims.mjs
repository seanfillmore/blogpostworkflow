#!/usr/bin/env node
/**
 * Soften product-subject remineralization, cavity and "safe for kids" claims on live
 * toothpaste blog posts.
 *
 * Dry by default. `--apply` writes. `--slug <handle>` limits the run to one post.
 *
 * ⚠️  RUN THIS ON THE PRODUCTION SERVER. The body fix is only half the job: every post
 * here has a `data/posts/<handle>/content.html` mirror (and three have a queued
 * `content-refreshed.html`) that exist in their current form ONLY on the server, and
 * `agents/publisher` republishes from the mirror. A local `--apply` would fix Shopify
 * and leave the server's mirror carrying the old claim for the next republish to push
 * back. The committed copies in git are older drafts and do not carry the live wording.
 *
 * WHY. Toothpaste orders started arriving through these posts in September 2026 (five
 * blog-entry toothpaste orders in 15 days, against one in the prior 90), so the copy on
 * them is now read by buyers rather than only indexed. Two shapes of claim sat directly
 * beside a buy box:
 *
 *   1. REMINERALIZATION / CAVITY claims about OUR formula or its ingredients — "Support
 *      natural remineralization with Real Skin Care's…", "supports natural
 *      remineralization", baking soda called a "remineralizing agent", switching
 *      recommended to people who "get cavities regularly". Anticaries is an OTC drug
 *      claim (21 CFR Part 355, the fluoride monograph); a fluoride-free cosmetic
 *      toothpaste may clean, polish and freshen, and may not claim to rebuild enamel or
 *      address cavities.
 *   2. SAFETY claims for children — "Real Skin Care's formula is safe for kids", "safe if
 *      swallowed", "safe for children old enough to spit". Replaced with "ask your
 *      pediatric dentist" and supervision guidance.
 *
 *      ⚠️  REVERSED 2026-09-13. The operator overruled this premise the next day: "Are
 *      these products safe for kids is a resounding yes for every single product." The
 *      15 kids-wording entries were RETIRED from the PLAN below and undone on the live
 *      posts by scripts/restore-toothpaste-kids-wording.mjs, which reuses this file's
 *      `runPlan`. Only the remineralization, cavity and enamel entries remain here, so a
 *      re-run of this script can no longer soften kids wording.
 *
 * Neither is in `lib/seo-copy-health-gate.js`'s vocabulary, which is why nothing caught
 * them; that gate also does not screen article bodies.
 *
 * WHAT IS KEPT, deliberately — this is the scope line, and over-correcting is the
 * expensive mistake on live ranking pages:
 *   · CATEGORY FACTS. "Fluoride strengthens enamel", nano-hydroxyapatite research,
 *     "coconut oil doesn't remineralize enamel". Accurate, cited, and about ingredients
 *     RSC does not sell. ~190 of the ~205 sentences a sweep of 45 live posts matched.
 *   · HEDGED EXPLAINERS on the glycerin post: the Gerard Judd attribution, "large-scale
 *     trials are limited", the ingredient table's "May block natural remineralization"
 *     row, and the practitioner list ("many holistic dentists recommend avoiding
 *     glycerin — especially for patients who…"). Those are information about a debated
 *     idea and say so; the edits target the sentences where OUR voice recommends the
 *     product or the switch for a condition.
 *   · CATEGORY KIDS FAQs on other posts ("Is SLS-free toothpaste safe for kids?"), and
 *     the deodorant / lip balm / scrub "safe for kids" FAQs. Not product-subject, and
 *     not toothpaste respectively.
 *
 * MECHANICS are imported from scripts/remediate-petrolatum-avoidance-claim.mjs
 * (`occurrences`, `decideEntry`), never re-declared: literal BEFORE, literal AFTER, an
 * asserted occurrence count, and a SKIP when live matches neither — somebody edited the
 * copy since this plan was written and blind replacement would clobber it. Entries on
 * one article apply in sequence to one body and are written in ONE update, then re-read
 * and verified. Mirrors apply leniently (replace wherever the BEFORE occurs) because a
 * mirror is allowed to lag, and an entry absent from a mirror is reported, not written.
 *
 * Every AFTER is re-gated at run time through the editorial-surface health gate, and
 * the two SERP descriptions through the 160-character length gate. One failure aborts
 * the run before anything is fetched.
 *
 * Usage (on the server):
 *   node scripts/remediate-toothpaste-safety-claims.mjs --slug why-glycerin-free-toothpaste-matters
 *   node scripts/remediate-toothpaste-safety-claims.mjs --slug why-glycerin-free-toothpaste-matters --apply
 *   node scripts/remediate-toothpaste-safety-claims.mjs --apply
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopyFields, EDITORIAL_SURFACE } from '../lib/seo-copy-health-gate.js';
import { checkCopyLength } from '../lib/seo-copy-length.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { occurrences, decideEntry } from './remediate-petrolatum-avoidance-claim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_ID = 48998449187;

/** Local files that republish into, or will be published over, each live article. */
export const MIRROR_FILES = ['content.html', 'content-refreshed.html'];

export const ARTICLES = {
  'why-glycerin-free-toothpaste-matters': { blogId: BLOG_ID, articleId: 562341380266 },
  'best-fluoride-free-toothpaste-2025': { blogId: BLOG_ID, articleId: 562334367914 },
  '7-ingredients-to-avoid-in-natural-toothpaste': { blogId: BLOG_ID, articleId: 562341347498 },
  'best-organic-toothpaste-what-to-look-for-why-it-matters': { blogId: BLOG_ID, articleId: 563324649642 },
  'best-natural-toothpaste-2025': { blogId: BLOG_ID, articleId: 562322768042 },
  'can-you-use-coconut-oil-as-toothpaste': { blogId: BLOG_ID, articleId: 561115168938 },
};

/**
 * A fixed, hand-reviewed plan — never a pattern sweep. Literals are byte-exact against
 * the live bodies read on 2026-09-12, including curly apostrophes where a post uses them.
 * `surface` is 'body' (article body_html) or 'description_tag' (the SERP description
 * metafield).
 */
export const PLAN = [
  // ── why-glycerin-free-toothpaste-matters — the post the September orders came through.
  {
    id: 'glycerin-cta-remineralization',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: "Support natural remineralization with Real Skin Care's <a href=",
    after: "Try Real Skin Care's <a href=",
    reason: 'Top-of-page buy-box line claimed our toothpaste supports remineralization — an anticaries-shaped claim above the Shop button.',
  },
  {
    id: 'glycerin-benefit-remineralization',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<strong>Supports natural remineralization:</strong> Saliva can reach your enamel directly and do its repair work without a coating in the way',
    after: '<strong>No glycerin coating:</strong> Nothing sits on your enamel after brushing, which is the main reason people choose a glycerin-free formula',
    reason: 'First of the "5 reasons to switch" promised enamel repair. Replaced rather than removed, so the title\'s count of five still holds.',
  },
  {
    id: 'glycerin-list-cavities',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<li>You have thin or eroding enamel</li>\n  <li>You get cavities regularly despite good brushing habits</li>\n  <li>You have sensitive teeth or gums</li>',
    after: '<li>You have sensitive teeth or gums</li>',
    reason: 'Our voice recommended switching to people with enamel erosion or recurring cavities — positioning the product for a condition.',
  },
  {
    id: 'glycerin-faq-cavities',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'But if you have sensitivity, erosion, or frequent cavities, removing glycerin is a smart, simple step.',
    after: "If you'd like to try a glycerin-free formula, switching is simple and low-risk.",
    reason: 'Same shape as the list above, inside the FAQ.',
  },
  {
    id: 'glycerin-description-tag',
    handle: 'why-glycerin-free-toothpaste-matters',
    surface: 'description_tag',
    expectedOccurrences: 1,
    before: 'Learn why many dentists recommend glycerin-free toothpaste. Discover the benefits for remineralization, sensitivity, and clean oral care—featuring Real Skin Care’s all-natural formula.',
    after: 'What glycerin does in toothpaste, how to spot it on a label, and what to look for in a glycerin-free formula like Real Skin Care’s.',
    reason: 'SERP snippet claimed remineralization benefits and an unsourced "many dentists recommend". The old value was also 185 characters, over the 160 limit.',
  },

  // ── best-fluoride-free-toothpaste-2025
  {
    id: 'fluoride-free-faq-cavities',
    handle: 'best-fluoride-free-toothpaste-2025',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'Yes, when paired with consistent oral hygiene and ingredients like baking soda or hydroxyapatite.',
    after: "No toothpaste does that alone — brushing habits and diet matter most. Among fluoride-free ingredients, hydroxyapatite has the most research behind it; if you're cavity-prone, ask your dentist whether fluoride is right for you.",
    reason: 'Answered "does it prevent cavities?" with "yes" and credited baking soda, an ingredient in our formula, with no anticaries evidence.',
  },

  // ── 7-ingredients-to-avoid-in-natural-toothpaste
  {
    id: 'seven-ingredients-baking-soda-remineralizing',
    handle: '7-ingredients-to-avoid-in-natural-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'Remineralizing agents like baking soda or hydroxyapatite paired with proper oral hygiene.',
    after: 'A gentle fluoride-free formula plus good brushing habits — and if you’re cavity-prone, ask your dentist about hydroxyapatite or fluoride.',
    reason: 'Called baking soda — in our formula, directly above our mid-article CTA — a remineralizing agent. It is not one.',
  },

  // ── best-organic-toothpaste-what-to-look-for-why-it-matters
  {
    id: 'organic-baking-soda-remineralizing',
    handle: 'best-organic-toothpaste-what-to-look-for-why-it-matters',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'It also alkalizes your mouth, disrupting the acid environment bacteria need to thrive — the practical core of what "remineralizing toothpaste" actually means.',
    after: 'It also helps neutralize acidity in your mouth.',
    reason: 'Framed the baking soda in "this formula" (ours) as what makes a remineralizing toothpaste. The later category sentence "baking soda alkalizes your mouth" is kept.',
  },

  // ── best-natural-toothpaste-2025
  {
    id: 'natural-2025-remineralizing-ingredients',
    handle: 'best-natural-toothpaste-2025',
    surface: 'body',
    expectedOccurrences: 1,
    before: 'look for formulas that support enamel health through remineralizing ingredients like baking soda, coconut oil, or nano-hydroxyapatite.',
    after: 'look for a gentle formula with a short ingredient list, and ask your dentist whether an ingredient like nano-hydroxyapatite makes sense for you.',
    reason: 'Listed baking soda and coconut oil — our two base ingredients — as remineralizing. Neither is; the site\'s own coconut-oil posts say so.',
  },

  // ── can-you-use-coconut-oil-as-toothpaste
  {
    id: 'coconut-oil-pros-gum-inflammation',
    handle: 'can-you-use-coconut-oil-as-toothpaste',
    surface: 'body',
    expectedOccurrences: 1,
    before: '<li>Reduces plaque and gum inflammation</li>',
    after: '<li>Helps clean away plaque</li>',
    reason: '"Pros of coconut oil toothpaste" — our product\'s category name — claimed it reduces gum inflammation, a gingivitis-shaped drug claim.',
  },
];

/** Replace wherever the BEFORE occurs in a mirror; a mirror is allowed to lag live. */
export function decideMirror(entry, text) {
  if (typeof text !== 'string') return { action: 'no-file' };
  const n = occurrences(text, entry.before);
  if (n > 0) return { action: 'apply', count: n, next: text.split(entry.before).join(entry.after) };
  if (occurrences(text, entry.after) > 0) return { action: 'already-applied' };
  return { action: 'absent' };
}

/** Problems with an entry's AFTER text; empty when it may ship. */
export function gateEntry(entry) {
  const problems = [];
  const gate = checkSeoCopyFields({ [entry.surface]: entry.after }, { surface: EDITORIAL_SURFACE });
  if (!gate.ok) problems.push(`health gate: ${JSON.stringify(gate.blocking)}`);
  if (entry.surface === 'description_tag') {
    const len = checkCopyLength({ description: entry.after }, { description: 'description' });
    if (!len.ok) problems.push(`length: ${JSON.stringify(len.overlong)}`);
  }
  return problems;
}

/** Runs this script's own plan through the shared runner below. */
export function main(opts = {}) {
  return runPlan({
    plan: PLAN,
    articles: ARTICLES,
    reportDir: 'toothpaste-claim-remediation',
    backupTag: 'toothpaste-claims',
    ...opts,
  });
}

/**
 * Apply a fixed BEFORE/AFTER plan to live article bodies, their SERP descriptions and their
 * local mirrors. Dry unless `argv` carries `--apply`. Exported so a later plan against the
 * same posts (scripts/restore-toothpaste-kids-wording.mjs) reuses these mechanics instead of
 * carrying a second copy.
 */
export async function runPlan({ plan, articles, reportDir, backupTag, shopify, argv = process.argv.slice(2), root = ROOT, log = console.log }) {
  const apply = argv.includes('--apply');
  const slugAt = argv.indexOf('--slug');
  const onlySlug = slugAt >= 0 ? argv[slugAt + 1] : null;
  if (slugAt >= 0 && !articles[onlySlug]) throw new Error(`--slug ${onlySlug} is not in the plan`);

  for (const entry of plan) {
    const problems = gateEntry(entry);
    if (problems.length) throw new Error(`ABORT — entry ${entry.id}: ${problems.join('; ')}`);
  }

  const api = shopify ?? await import('../lib/shopify.js');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(root, 'data', 'reports', reportDir);
  const results = [];

  const handles = Object.keys(articles).filter((h) => !onlySlug || h === onlySlug);
  for (const handle of handles) {
    const { blogId, articleId } = articles[handle];
    const bodyEntries = plan.filter((e) => e.handle === handle && e.surface === 'body');
    const metaEntries = plan.filter((e) => e.handle === handle && e.surface === 'description_tag');
    log(`\n== ${handle}`);

    if (bodyEntries.length) {
      const live = (await api.getArticle(blogId, articleId))?.body_html;
      let next = live;
      const applied = [];
      for (const entry of bodyEntries) {
        const d = decideEntry(entry, next);
        results.push({ id: entry.id, handle, surface: 'body', action: d.action, why: d.why });
        log(`  ${entry.id} — ${d.action.toUpperCase()}: ${d.why}`);
        if (d.action === 'apply') { next = d.next; applied.push(entry); }
      }

      if (applied.length && apply) {
        // Backup BEFORE the write, always. This file is the restore path.
        mkdirSync(join(outDir, 'backups', stamp), { recursive: true });
        writeFileSync(join(outDir, 'backups', stamp, `${handle}.body_html.html`), live);
        await api.updateArticle(blogId, articleId, { body_html: next });
        const reread = (await api.getArticle(blogId, articleId))?.body_html;
        for (const entry of applied) {
          if (occurrences(reread, entry.before) !== 0 || occurrences(reread, entry.after) === 0) {
            throw new Error(`VERIFY FAILED — ${entry.id}: live body does not carry the AFTER after the write. Backup: ${join(outDir, 'backups', stamp)}`);
          }
        }
        log(`  ✓ body written and verified (${applied.length} edit(s))`);
      } else if (applied.length) {
        log('  (dry run — pass --apply to write)');
      }

      for (const file of MIRROR_FILES) {
        const path = join(root, 'data', 'posts', handle, file);
        if (!existsSync(path)) continue;
        const original = readFileSync(path, 'utf8');
        let text = original;
        const rows = [];
        for (const entry of bodyEntries) {
          const d = decideMirror(entry, text);
          rows.push({ id: entry.id, action: d.action, count: d.count ?? 0 });
          if (d.action === 'apply') text = d.next;
        }
        const changed = text !== original;
        const absent = rows.filter((r) => r.action === 'absent').map((r) => r.id);
        results.push({ handle, mirror: file, changed, rows });
        log(`  mirror ${file}: ${rows.map((r) => `${r.id}=${r.action}${r.count ? `×${r.count}` : ''}`).join(', ')}`);
        if (changed && apply) {
          mkdirSync(join(root, 'data', 'posts', handle, 'backups'), { recursive: true });
          writeFileSync(join(root, 'data', 'posts', handle, 'backups', `${backupTag}-${stamp}-${file}`), original);
          writeFileSync(path, text);
          log(`  ✓ mirror ${file} written`);
        }
        if (absent.length) {
          log(`  ⚠ ${file} does not carry ${absent.length} of the live wordings (${absent.join(', ')}) — check it by hand before it is ever republished`);
        }
      }
    }

    for (const entry of metaEntries) {
      const mf = (await api.getMetafields('articles', articleId) || [])
        .find((m) => m.namespace === 'global' && m.key === 'description_tag');
      const d = decideEntry(entry, mf?.value);
      results.push({ id: entry.id, handle, surface: 'description_tag', action: d.action, why: d.why, before_value: mf?.value ?? null });
      log(`  ${entry.id} — ${d.action.toUpperCase()}: ${d.why}`);
      if (d.action !== 'apply') continue;
      if (!apply) { log('  (dry run — pass --apply to write)'); continue; }
      await api.upsertMetafield('articles', articleId, 'global', 'description_tag', d.next, mf.type);
      const now = (await api.getMetafields('articles', articleId) || [])
        .find((m) => m.namespace === 'global' && m.key === 'description_tag')?.value;
      if (now !== d.next) throw new Error(`VERIFY FAILED — ${entry.id}: description_tag reads ${JSON.stringify(now)}`);
      log('  ✓ description_tag written and verified');
    }
  }

  mkdirSync(outDir, { recursive: true });
  const record = { generated_at: new Date().toISOString(), applied: apply, slug: onlySlug, results };
  writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(record, null, 2));
  log(`\nRun record: ${join(outDir, `run-${stamp}.json`)}`);
  return record;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
