// tests/agents/commercial-dead-schema.test.js
//
// PR #662 stopped `agents/schema-injector` emitting FAQPage on BLOG posts. This
// pins the same removal on the COMMERCIAL surfaces — `agents/collection-creator`,
// `agents/collection-content-optimizer` and `agents/product-optimizer` — which
// were deliberately left out of that change because they are published product
// and collection pages with their own blast radius.
//
// THE EVIDENCE, RE-VERIFIED 2026-08-24 rather than carried over:
//
//   FAQPage  Google REMOVED the FAQ rich result from Search.
//            `developers.google.com/search/docs/appearance/structured-data/faqpage`
//            → 301 → `/search/updates#removing-faq-rich-result`. The doc is gone.
//   HowTo    `.../structured-data/how-to` → 301 → `/search/updates#how-to-deprecation`.
//            Removed September 2023.
//   Control  `.../structured-data/article` → 200. So the 301s are the feature
//            being retired, not a docs-site reshuffle.
//
// WHAT STAYS, AND WHY IT IS NOT THE SAME CALL AS `Article` ON A BLOG POST.
// PR #662 dropped the injector's `Article` because the THEME already published
// one on 182 of 182 blog pages. On the commercial surfaces the theme publishes
// far less, measured off the rendered pages on 2026-08-24:
//
//   all 5 published collections  →  Organization, and NOTHING else.
//                                   No CollectionPage. No BreadcrumbList.
//   all 11 sitemap PDPs          →  Organization + ProductGroup (Product inside).
//
// So `CollectionPage` and `BreadcrumbList` on a collection body are the ONLY
// copies that exist and must survive this change. Deleting them would be the
// over-correction — the same mistake as keeping FAQPage, wearing the other sign.
//
// The agents cannot be imported (they reach `lib/shopify.js`, which throws at
// import without OAuth credentials), so the decision is tested through the pure
// `lib/schema-builders.js` plus a comment-stripped source scan — the same shape
// as `tests/agents/schema-injector-dead-types.test.js` and
// `tests/agents/seo-copy-writers-gated.test.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as builders from '../../lib/schema-builders.js';
import { validateCollectionSpec } from '../../lib/collection-validation.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A source file with comments removed.
 *
 * The scans assert "no CODE builds this any more". They must not fire on the
 * comments explaining WHY it was removed — that reasoning is the point of the
 * change, and a scan that forbids naming the retired type forces its own
 * justification to be deleted.
 */
function codeOnly(path) {
  return stripComments(readFileSync(join(ROOT, path), 'utf8'));
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // A trailing `//` comment needs whitespace before it, so `'https://x'`
    // inside a string literal is not mistaken for one.
    .replace(/[ \t]+\/\/.*$/gm, '');
}

const CREATOR = 'agents/collection-creator/index.js';
const OPTIMIZER = 'agents/collection-content-optimizer/index.js';
const PRODUCT = 'agents/product-optimizer/index.js';

const COMMERCIAL_AGENTS = [CREATOR, OPTIMIZER, PRODUCT];

// ── the builder ──────────────────────────────────────────────────────────────

test('lib/schema-builders.js exports no FAQ builder at all', () => {
  // Deleted rather than left unused, for the same reason `buildArticleSchema`
  // was: an unused builder sitting in this file is how somebody re-adds the
  // dead type without ever reading why it went.
  assert.equal('buildFaqSchema' in builders, false);
  assert.equal(
    Object.keys(builders).sort().join(','),
    'buildBreadcrumb,buildCollectionPageSchema,buildItemListSchema,buildPostSchemas',
  );
});

test('the builders that DO survive still build the nodes the commercial pages need', () => {
  // Guard against over-deletion. The theme gives a collection page only
  // `Organization`, so these two are the sole copies of their type.
  const page = builders.buildCollectionPageSchema({
    name: 'Natural Deodorant',
    description: 'desc',
    url: 'https://www.realskincare.com/collections/natural-deodorant',
  });
  assert.equal(page['@type'], 'CollectionPage');

  const crumb = builders.buildBreadcrumb([
    { name: 'Home', url: 'https://www.realskincare.com' },
    { name: 'Collections', url: 'https://www.realskincare.com/collections' },
    { name: 'Natural Deodorant', url: 'https://www.realskincare.com/collections/natural-deodorant' },
  ]);
  assert.equal(crumb['@type'], 'BreadcrumbList');
  assert.deepEqual(crumb.itemListElement.map((i) => i.name), ['Home', 'Collections', 'Natural Deodorant']);
});

// ── the three agents ─────────────────────────────────────────────────────────

test('no commercial agent names a retired structured-data type in code', () => {
  for (const path of COMMERCIAL_AGENTS) {
    const src = codeOnly(path);
    for (const dead of ['FAQPage', 'HowTo', 'buildFaqSchema', 'faq_schema']) {
      assert.ok(
        !new RegExp(`\\b${dead}\\b`).test(src),
        `${dead} must not survive in ${path} code`,
      );
    }
  }
});

test('the heuristics that fed the FAQ schema are gone, not left dead', () => {
  // `extractFaqPairs` existed for exactly one caller — `buildFaqSchema`. Left
  // behind it is an unreferenced regex that reads like a live feature.
  for (const path of [CREATOR, OPTIMIZER]) {
    assert.ok(!codeOnly(path).includes('extractFaqPairs'), `extractFaqPairs must be gone from ${path}`);
  }
});

test('both collection agents still emit CollectionPage AND BreadcrumbList', () => {
  for (const path of [CREATOR, OPTIMIZER]) {
    const src = codeOnly(path);
    assert.match(src, /buildCollectionPageSchema/, `${path} must still build CollectionPage`);
    assert.match(src, /buildBreadcrumb/, `${path} must still build BreadcrumbList`);
  }
});

test('the collection agents still WRITE the FAQ prose — only the markup went', () => {
  // The Q&A section is the visible copy a shopper reads and the reason these
  // pages answer a question at all. Google retiring a rich result is a
  // statement about MARKUP, never about content, and removing the prose would
  // be a content regression dressed up as a schema fix.
  for (const path of [CREATOR, OPTIMIZER]) {
    const src = readFileSync(join(ROOT, path), 'utf8');
    assert.match(src, /FAQ section/i, `${path} must still ask for an FAQ section`);
  }
});

test('collection-content-optimizer still strips existing JSON-LD before re-injecting', () => {
  // This is the attrition mechanism: a collection that passes through this
  // agent again sheds whatever dead schema its body carried, as a side effect
  // of work already happening on it. Losing it would turn "leave the existing
  // blocks" into "leave them forever".
  const src = codeOnly(OPTIMIZER);
  assert.match(src, /stripExistingSchemas/);
  assert.match(src, /application\\\/ld\\\+json/);
});

test('collection-creator has no strip step, because it only ever creates', () => {
  // Stated so nobody "fixes" the asymmetry: this agent builds a body from
  // scratch for a collection that does not exist yet, so there is nothing to
  // strip. See the CLAUDE.md note on why that makes attrition partial.
  const src = codeOnly(CREATOR);
  assert.ok(!src.includes('stripExistingSchemas'));
  assert.match(src, /createCustomCollection|createSmartCollection/);
});

// ── product-optimizer: the field nothing ever read ───────────────────────────

test('nothing anywhere in the repo reads a queue item faq_schema', () => {
  // `--expand-faq` asked Claude for a FAQPage block and stored it on the queue
  // item; the publish path (`updatePage` with `body_html` only) never looked at
  // it. Audited before removal, and pinned here so its removal cannot break a
  // consumer that appears later.
  const hits = [];
  const skip = new Set(['node_modules', '.git', 'data', 'backup', 'theme']);
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(js|mjs|cjs)$/.test(name)) continue;
      if (p.endsWith(join('tests', 'agents', 'commercial-dead-schema.test.js'))) continue;
      // Comments stripped: the removal's own justification names the field, and
      // a scan that forbids naming it forces the reasoning to be deleted. A real
      // reader would be `item.faq_schema` in code, which this still catches.
      if (/\bfaq_schema\b/.test(stripComments(readFileSync(p, 'utf8')))) hits.push(p.slice(ROOT.length + 1));
    }
  })(ROOT);
  assert.deepEqual(hits, [], `faq_schema must exist nowhere: ${hits.join(', ')}`);
});

test('product-optimizer still gates and still expands the FAQ page itself', () => {
  // Removing the dead schema must not remove the mode. `--expand-faq` writes
  // real FAQ prose onto a live page, behind the health-claim gate.
  const src = codeOnly(PRODUCT);
  assert.match(src, /faq-expansion/);
  assert.match(src, /gateGeneratedCopy/);
});

// ── consumers that must stay uninvolved ──────────────────────────────────────

test('the queue-apply collection path never emitted schema and still does not', () => {
  // The SECOND way a collection body reaches Shopify (dashboard Approve and
  // `queue-autoapply`). It writes `proposed_collection.body_html` verbatim, so
  // it never carried FAQPage — removing it elsewhere makes the two paths agree
  // rather than diverge.
  const src = codeOnly('lib/queue-apply.js');
  assert.ok(!/buildFaqSchema|FAQPage|buildSchemaBlock/.test(src));
});

test('lib/collection-validation.js has no opinion about structured data', () => {
  const src = codeOnly('lib/collection-validation.js');
  assert.ok(!/ld\+json|FAQPage|schema\.org/.test(src));
});

test('the 300-word collection floor is counted on PROSE, never on an assembled body', () => {
  // The one consumer that could have degraded, and the reason it does not.
  // `validateCollectionSpec`'s word count is `replace(/<[^>]+>/g, ' ')` — that
  // strips the <script> TAGS but keeps the JSON between them, so an assembled
  // body's word count is inflated by whatever schema it carries. Removing
  // FAQPage would then have quietly LOWERED a body's measured length and could
  // have flipped a collection below the floor.
  //
  // It is safe only because every call site passes the model's prose-only spec.
  // Both halves are pinned: the inflation is real, and nothing feeds it.
  const schemaText = ' words'.repeat(400);
  const withSchema = `<p>short</p><script type="application/ld+json">{"a":"${schemaText}"}</script>`;
  assert.ok(
    wordsCountedBy(withSchema) > 300,
    'precondition: JSON-LD text IS counted — so an assembled body must never be validated',
  );

  for (const path of [CREATOR, OPTIMIZER]) {
    const src = codeOnly(path);
    assert.ok(
      !/validateCollectionSpec\(\s*(buildBodyWithSchema|buildSchemaBlock)/.test(src),
      `${path} must validate the prose spec, not the schema-assembled body`,
    );
  }
});

/** The exact word count `lib/collection-validation.js` applies, via its own floor. */
function wordsCountedBy(html) {
  const spec = { title: 'T', handle: 'h', seo_title: 's', meta_description: 'm'.repeat(50), body_html: html };
  const { errors } = validateCollectionSpec(spec, { existingHandles: new Set() });
  const thin = errors.find((e) => e.startsWith('body_html too thin'));
  return thin ? Number(thin.match(/\((\d+) words/)[1]) : Infinity;
}

test('the blog-side predicates stay blog-side', () => {
  // `hasInjectedSchema` routes a PAID rebuild off `data/posts/<slug>/content.html`.
  // It never reads a collection or product body, so nothing on these surfaces
  // can enrol a page into unattended spend the way stopping FAQPage on posts
  // nearly did.
  const src = codeOnly('agents/legacy-rebuilder/index.js');
  assert.match(src, /hasInjectedSchema/);
  assert.ok(!/getCustomCollections|getSmartCollections|getProducts\b/.test(src));
});
