// tests/agents/schema-injector-dead-types.test.js
//
// WHAT THIS PINS, AND THE EVIDENCE BEHIND IT (verified 2026-08-24)
//
//   FAQPage  Google REMOVED the FAQ rich result from Search. Not the 2023
//            narrowing — outright removal. `https://developers.google.com/
//            search/docs/appearance/structured-data/faqpage` returns 301 →
//            `/search/updates#removing-faq-rich-result`; the doc no longer
//            exists and FAQ is absent from the rich results gallery.
//   HowTo    Removed the same way in September 2023. `.../structured-data/
//            howto` returns 404.
//   Article  DUPLICATE. The live theme already publishes Article +
//            BreadcrumbList + Organization + WebPage + Person on 182 of 182
//            blog article pages (measured off the rendered pages, not the
//            repo's partial `theme/` mirror). The injector's Article node was a
//            second copy layered on top of the theme's.
//
// Only BreadcrumbList survives, and it survives on its own merits: breadcrumbs
// are a live, supported rich result, and the theme's own BreadcrumbList is a
// degenerate ONE-ITEM stub carrying nothing but "Home". The injector's is the
// real Home › News › Title trail.
//
// The agent itself cannot be imported — it calls `process.exit(1)` at module
// scope on a missing argument, and pulls in `lib/shopify.js`, which throws at
// import without OAuth credentials. So the decision lives in the pure
// `buildPostSchemas` and is tested directly here; the agent is checked by source
// scan, the same pattern `tests/agents/seo-copy-writers-gated.test.js` uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPostSchemas } from '../../lib/schema-builders.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A source file with its comments removed.
 *
 * The scans below assert "no CODE builds this any more". They must not fire on
 * the comments that explain WHY it was removed — those are the whole point of
 * the change and a scan that forbids naming the retired types is a scan that
 * forces the reasoning to be deleted.
 */
function codeOnly(path) {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const AGENT = codeOnly('agents/schema-injector/index.js');

const CONFIG = { url: 'https://www.realskincare.com', name: 'Real Skin Care', author: { name: 'A', slug: 'a' } };
const META = { title: 'Best Natural Deodorant', meta_description: 'desc', target_keyword: 'natural deodorant' };
const URL = 'https://www.realskincare.com/blogs/news/best-natural-deodorant';

const typesOf = (schemas) => schemas.map((s) => s['@type']);

// ── the decision ─────────────────────────────────────────────────────────────

test('a blog post gets BreadcrumbList and nothing else', () => {
  assert.deepEqual(typesOf(buildPostSchemas(META, URL, CONFIG)), ['BreadcrumbList']);
});

test('no FAQPage, however many question headings the body carries', () => {
  // The old agent emitted FAQPage at 2+ question headings. Nothing about the
  // body may bring it back, so the builder takes no HTML at all.
  assert.equal(buildPostSchemas.length <= 3, true, 'the builder must not take the post body');
  assert.ok(!typesOf(buildPostSchemas(META, URL, CONFIG)).includes('FAQPage'));
});

test('no HowTo, and no Article duplicating the theme', () => {
  const types = typesOf(buildPostSchemas(META, URL, CONFIG));
  assert.ok(!types.includes('HowTo'));
  assert.ok(!types.includes('Article'));
});

test('the breadcrumb is the full Home › News › Title trail the theme does not publish', () => {
  const [crumb] = buildPostSchemas(META, URL, CONFIG);
  assert.equal(crumb['@type'], 'BreadcrumbList');
  assert.deepEqual(crumb.itemListElement.map((i) => i.name), ['Home', 'News', 'Best Natural Deodorant']);
  assert.deepEqual(crumb.itemListElement.map((i) => i.position), [1, 2, 3]);
  assert.equal(crumb.itemListElement[2].item, URL);
});

test('a long title is truncated the way it always was', () => {
  const [crumb] = buildPostSchemas({ title: 'x'.repeat(200) }, URL, CONFIG);
  assert.equal(crumb.itemListElement[2].name.length, 110);
});

test('a post with no title still yields a valid breadcrumb', () => {
  const [crumb] = buildPostSchemas({}, URL, CONFIG);
  assert.equal(crumb.itemListElement.length, 3);
  assert.equal(crumb.itemListElement[2].name, '');
});

test('the result is always JSON-serializable — it is written straight into a <script>', () => {
  assert.doesNotThrow(() => JSON.stringify(buildPostSchemas(META, URL, CONFIG)));
});

// ── the agent no longer knows how to build the dead types ────────────────────

test('the agent source mentions none of the three retired types', () => {
  for (const dead of ['FAQPage', 'HowTo', 'buildArticleSchema', 'buildFaqSchema']) {
    assert.ok(
      !new RegExp(`\\b${dead}\\b`).test(AGENT),
      `${dead} must not survive in agents/schema-injector code`,
    );
  }
});

test('the agent no longer carries the detection heuristics that fed them', () => {
  for (const fn of ['extractFAQs', 'extractHowToSteps', 'buildHowToSchema']) {
    assert.ok(!AGENT.includes(fn), `${fn} must be gone, not left dead`);
  }
});

test('the agent still strips whatever JSON-LD it finds before writing its own', () => {
  // This is what makes "stop emitting, leave the existing blocks" a gradual
  // drain rather than a permanent corpus of dead schema: any post that passes
  // through the injector again loses its FAQPage/HowTo/Article as a side effect
  // of work already happening on it. No mass body_html rewrite is needed.
  assert.match(AGENT, /stripExistingSchemas/);
  assert.match(AGENT, /application\\\/ld\\\+json/);
});

test('the agent builds its schema list through the shared pure builder', () => {
  assert.match(AGENT, /buildPostSchemas/);
});

// ── the interaction that had to be fixed in the same change ──────────────────

test('legacy-rebuilder no longer keys a paid rebuild on the retired FAQPage string', () => {
  const src = codeOnly('agents/legacy-rebuilder/index.js');
  assert.ok(!/includes\(['"]FAQPage['"]\)/.test(src), 'the FAQPage substring test must be gone');
  assert.match(src, /hasInjectedSchema/, 'it must read the shared predicate');
});

test('the mirror reconciler keys its rollback on the same predicate', () => {
  const src = codeOnly('lib/content-reconcile.js');
  assert.ok(!/export function (hasFaqPage|faqRegression)/.test(src), 'the FAQ-keyed exports must be gone');
  assert.match(src, /schemaRegression/);
});

test('the editor reads FAQ Q&As from the prose, not from the retired schema', () => {
  const src = codeOnly('agents/editor/index.js');
  assert.ok(!/'@type'\]\s*===\s*'FAQPage'/.test(src), 'the JSON-LD FAQ parse must be gone');
  assert.match(src, /from '\.\.\/\.\.\/lib\/faq-blocks\.js'/);
});

test('scripts/reconcile-content-mirrors.mjs imports only names lib/content-reconcile.js exports', async () => {
  // Renaming `hasFaqPage` broke this script's import and NOTHING caught it: the
  // script is never imported by a test, so `npm test` stayed green while
  // `npm run reconcile-content-mirrors` would have died at module load. It is
  // the one consumer of that module outside the tests, and a paid-rebuild
  // guard is the last thing that should fail closed by accident.
  const src = readFileSync(join(ROOT, 'scripts', 'reconcile-content-mirrors.mjs'), 'utf8');
  // `[^}]*` rather than a lazy `[\s\S]*?`: the latter matches from the FIRST
  // `import {` in the file and swallows every import above this one.
  const block = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/lib\/content-reconcile\.js'/);
  assert.ok(block, 'the script must still import from lib/content-reconcile.js');

  const wanted = block[1].split(',').map((n) => n.trim()).filter(Boolean);
  const mod = await import('../../lib/content-reconcile.js');
  for (const name of wanted) {
    assert.ok(name in mod, `lib/content-reconcile.js must export ${name}`);
  }
});

test('faq-rewriter and the editor share ONE extractor', () => {
  const rewriter = codeOnly('agents/faq-rewriter/index.js');
  assert.match(rewriter, /from '\.\.\/\.\.\/lib\/faq-blocks\.js'/);
  assert.ok(!/^function extractFaqBlocks/m.test(rewriter), 'the local copy must be gone, not shadowed');
});
