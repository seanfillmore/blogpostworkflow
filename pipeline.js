#!/usr/bin/env node
/**
 * SEO Pipeline Runner
 *
 * Orchestrates the full content production pipeline from keyword research
 * through publishing. Each step can be run individually or as part of a
 * complete run. Steps that have already produced output are skipped by
 * default unless --force is passed.
 *
 * STEPS:
 *   1.  index       — Fetch & index site sitemap
 *   2.  blog-list   — Pull blog/article index from Shopify
 *   3.  link-audit  — Map internal links, find orphans
 *   4.  topical-map — Cluster content, surface cross-link opportunities
 *   5.  gap         — Content gap analysis (requires data/content_gap/ CSVs)
 *   6.  strategist  — Build content calendar + brief queue from gap report
 *   7.  research    — Generate content brief(s) for target keyword(s)
 *   8.  write       — Write post(s) from brief(s)
 *   9.  image       — Generate hero image(s)
 *   10. edit         — Editorial review (link health, sources, brand voice)
 *   11. schema       — Inject JSON-LD structured data (Article, FAQPage, HowTo)
 *   12. verify       — Verify links, facts, and meta quality before publishing
 *   13. publish      — Upload to Shopify as draft for manual review
 *   14. rank-tracker  — Snapshot keyword positions, detect changes, flag actions
 *   15. internal-link  — Find and inject inbound links to a newly published post
 *   16. collection-link — Link new post to relevant collection/product pages
 *
 * USAGE:
 *   node pipeline.js                            # run all steps
 *   node pipeline.js --steps index,blog-list    # run specific steps
 *   node pipeline.js --from research            # run from a step onward
 *   node pipeline.js --keyword "natural lip balm" --steps research,write,image,edit
 *   node pipeline.js --slug natural-lip-balm --steps edit,publish
 *   node pipeline.js --slug natural-lip-balm --steps publish
 *   node pipeline.js --force                    # re-run steps even if output exists
 *
 * OPTIONS:
 *   --steps <step1,step2,...>   Run only the listed steps (comma-separated)
 *   --from <step>               Run from this step through the end
 *   --keyword "<kw>"            Target keyword for research/write/image/edit
 *   --slug <slug>               Target post slug for write/image/edit/publish
 *   (publish step always uploads as draft for manual review before going live)
 *   --force                     Re-run steps even if output already exists
 *   --dry-run                   Print what would run without executing
 *   --allow-fallback            Allow research step to run without Ahrefs CSV data (lower quality)
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

const stepsArg = getArg('--steps');
const fromArg = getArg('--from');
const keyword = getArg('--keyword');
const slugArg = getArg('--slug');
const publishAt = getArg('--publish-at');
const isDraft = hasFlag('--draft');
const force = hasFlag('--force');
const dryRun = hasFlag('--dry-run');
const allowFallback = hasFlag('--allow-fallback');

// Derive slug from keyword if not explicitly provided
const slug = slugArg || (keyword ? keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null);

// ── step definitions ──────────────────────────────────────────────────────────

const ALL_STEPS = [
  'index',
  'blog-list',
  'link-audit',
  'topical-map',
  'gap',
  'strategist',
  'research',
  'write',
  'image',
  'edit',
  'link-repair',
  'schema',
  'verify',
  'publish',
  'rank-tracker',
  'internal-link',
  'collection-link',
];

function stepCmd(step) {
  switch (step) {
    case 'index':
      return 'node agents/sitemap-indexer/index.js';
    case 'blog-list':
      return 'node agents/blog-content/index.js list';
    case 'link-audit':
      return 'node agents/internal-link-auditor/index.js';
    case 'topical-map':
      return 'node agents/topical-mapper/index.js';
    case 'gap':
      return 'node agents/content-gap/index.js';
    case 'strategist':
      return 'node agents/content-strategist/index.js';
    case 'research': {
      if (!keyword) return null; // requires --keyword
      const fallbackFlag = allowFallback ? ' --allow-fallback' : '';
      return `node agents/content-researcher/index.js "${keyword}"${fallbackFlag}`;
    }
    case 'write': {
      if (slug) return `node agents/blog-post-writer/index.js data/briefs/${slug}.json`;
      return 'node agents/blog-post-writer/index.js --all';
    }
    case 'image': {
      if (slug) return `node agents/image-generator/index.js data/posts/${slug}/meta.json`;
      return 'node agents/image-generator/index.js --all';
    }
    case 'edit': {
      if (slug) return `node agents/editor/index.js data/posts/${slug}/content.html`;
      return null; // edit requires a slug or iterating posts; handled below
    }
    case 'link-repair': {
      if (!slug) return null;
      return `node agents/link-repair/index.js ${slug}`;
    }
    case 'schema': {
      if (!slug) return null;
      return `node agents/schema-injector/index.js --slug ${slug}`;
    }
    case 'verify': {
      if (!slug) return null; // requires --slug
      return `node agents/blog-post-verifier/index.js ${slug}`;
    }
    case 'publish': {
      if (!slug) return null; // publish requires --slug or iterating
      return `node agents/publisher/index.js data/posts/${slug}/meta.json --draft`;
    }
    case 'rank-tracker':
      return 'node agents/rank-tracker/index.js';
    case 'internal-link': {
      if (!slug) return null; // requires --slug
      return `node agents/internal-linker/index.js --slug ${slug} --apply`;
    }
    case 'collection-link':
      return `node agents/collection-linker/index.js --top-targets --apply`;
    default:
      return null;
  }
}

// Output files that indicate a step has already run (skip unless --force)
function stepOutput(step) {
  switch (step) {
    case 'index':      return 'data/sitemap-index.json';
    case 'blog-list':  return 'data/blog-index.json';
    case 'link-audit': return 'data/link-audit.json';
    case 'topical-map': return 'data/topical-map.json';
    case 'gap':        return 'data/reports/content-gap-report.md';
    case 'strategist': return 'data/reports/content-calendar.md';
    case 'research':   return slug ? `data/briefs/${slug}.json` : null;
    case 'write':      return slug ? `data/posts/${slug}/content.html` : null;
    case 'image':      return slug ? `data/posts/${slug}/image.webp` : null;
    case 'edit':       return slug ? `data/posts/${slug}/editor-report.md` : null;
    case 'link-repair':    return null; // always re-runs (live link check)
    case 'schema':         return null; // always re-runs (idempotent, fast)
    case 'verify':         return null; // always re-runs (checks live links)
    case 'publish':        return null; // always re-runs if requested
    case 'rank-tracker':   return null; // always re-runs (new snapshot each time)
    case 'internal-link':   return slug ? `data/reports/${slug}-internal-links.md` : null;
    case 'collection-link': return null; // always re-runs (top-targets changes over time)
    default:                return null;
  }
}

// ── step selection ────────────────────────────────────────────────────────────

let steps;
if (stepsArg) {
  steps = stepsArg.split(',').map((s) => s.trim());
} else if (fromArg) {
  const idx = ALL_STEPS.indexOf(fromArg);
  if (idx === -1) { console.error(`Unknown step: ${fromArg}`); process.exit(1); }
  steps = ALL_STEPS.slice(idx);
} else {
  steps = [...ALL_STEPS];
}

// Validate
for (const s of steps) {
  if (!ALL_STEPS.includes(s)) {
    console.error(`Unknown step "${s}". Valid steps: ${ALL_STEPS.join(', ')}`);
    process.exit(1);
  }
}

// ── run ───────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  SEO Pipeline');
console.log('══════════════════════════════════════════════════════════════════');
if (keyword) console.log(`  Keyword: ${keyword}`);
if (slug)    console.log(`  Slug:    ${slug}`);
console.log(`  Steps:   ${steps.join(' → ')}`);
if (force)   console.log('  Mode:    force (re-run all steps)');
if (dryRun)  console.log('  Mode:    dry-run (no execution)');
console.log('');

let ran = 0;
let skipped = 0;
let failed = 0;
let publishBlocked = false;

// Check editor report for "Needs Work" verdict after edit step
function checkEditorialGate() {
  if (!slug) return false;
  const reportPath = join(__dirname, 'data', 'posts', slug, 'editor-report.md');
  if (!existsSync(reportPath)) return false;
  try {
    const report = readFileSync(reportPath, 'utf8');
    // Overall Quality verdict is "Needs Work" — block publish
    if (/VERDICT:\s*Needs Work/i.test(report)) {
      const match = report.match(/## Overall Quality[\s\S]*?NOTES:\s*([^\n]+)/i);
      const reason = match ? match[1].trim() : 'See editor report for details.';
      console.log(`\n  ⛔ Editorial gate: post flagged as "Needs Work"`);
      console.log(`     ${reason}`);
      console.log(`     Fix issues in data/posts/${slug}/content.html then re-run edit + publish.\n`);
      return true;
    }
  } catch { /* ignore read errors */ }
  return false;
}

for (const step of steps) {
  const cmd = stepCmd(step);
  const output = stepOutput(step);

  if (!cmd) {
    console.log(`  ⚠️  ${step.padEnd(12)} — skipped (missing required arg)`);
    if (step === 'research') console.log('              → provide --keyword "<keyword>"');
    if (step === 'publish')  console.log('              → provide --slug <slug>');
    if (step === 'edit' && !slug) console.log('              → provide --slug <slug>');
    if (step === 'verify') console.log('              → provide --slug <slug> or --keyword "<keyword>"');
    if (step === 'internal-link') console.log('              → provide --slug <slug>');
    skipped++;
    continue;
  }

  if (!force && output && existsSync(join(__dirname, output))) {
    console.log(`  ✓  ${step.padEnd(12)} — already done (${output})`);
    skipped++;
    continue;
  }

  console.log(`  ▶  ${step.padEnd(12)} — ${cmd}`);

  if (dryRun) {
    ran++;
    continue;
  }

  // Block publish/verify if editorial gate was triggered by a prior edit step
  if (publishBlocked && (step === 'publish' || step === 'verify')) {
    console.log(`  ⛔ ${step.padEnd(12)} — blocked by editorial gate (post needs fixes before publishing)`);
    skipped++;
    continue;
  }

  try {
    execSync(cmd, { stdio: 'inherit', cwd: __dirname });
    console.log(`  ✓  ${step.padEnd(12)} — done\n`);
    ran++;
    // After edit step, check if the editorial verdict blocks publishing
    if (step === 'edit') {
      publishBlocked = checkEditorialGate();
    }
  } catch (e) {
    console.error(`  ✗  ${step.padEnd(12)} — FAILED (exit ${e.status})`);
    failed++;
    // Continue to next step unless it's a critical dependency
    const criticalSteps = ['index', 'blog-list', 'research'];
    if (criticalSteps.includes(step)) {
      console.error('  Aborting pipeline — upstream step failed.');
      break;
    }
  }
}

// ── summary ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`  Done: ${ran} ran, ${skipped} skipped, ${failed} failed`);
console.log('══════════════════════════════════════════════════════════════════\n');

if (failed > 0) process.exit(1);
