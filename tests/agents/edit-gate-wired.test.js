// Source scan: every writer of a LIVE blog article asks lib/post-edit-gate.js
// before it writes, or is on a reviewed allowlist naming the edit kind it
// makes. A source scan rather than a behavioural test because importing
// agents/*/index.js RUNS the agent (live Shopify writes, paid calls).
//
// Why this exists: one page (the SLS toothpaste article, the blog's biggest)
// was edited 9 times in 3 weeks by 6 writers and fell #5 -> #10. The rule
// "one material change, then measure 28 days" existed and nothing called it.
// The fourth test below is what keeps it that way: a NEW writer of a live
// article that is in neither list fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/**
 * Gated writers. `kind` is the literal edit kind the file asks for; null where
 * the kind is derived per item from data (stated in `why`). `records` = the
 * file must call recordMaterialEdit after its live write (serp/rewrite only).
 */
const GATED = [
  { file: 'agents/cannibalization-resolver/index.js', kind: 'rewrite', records: true },
  { file: 'agents/meta-optimizer/index.js', kind: 'serp', records: true },
  { file: 'agents/internal-linker/index.js', kind: 'enhance', records: false },
  { file: 'lib/queue-apply.js', kind: 'rewrite', records: true },
  { file: 'agents/queue-autoapply/index.js', kind: null, records: false, why: 'kind from lib/queue-autoapply.js editKindForItem; the write (and the record) happen in lib/queue-apply.js' },
  { file: 'agents/blocked-post-resolver/index.js', kind: 'rewrite', records: true },
  { file: 'scripts/remediate-live-post.js', kind: 'rewrite', records: true },
  { file: 'agents/answer-first-rewriter/index.js', kind: 'rewrite', records: true },
  { file: 'agents/refresh-runner/index.js', kind: 'rewrite', records: true },
  { file: 'agents/content-refresher/index.js', kind: 'rewrite', records: true },
  { file: 'agents/legacy-rebuilder/index.js', kind: 'rewrite', records: true },
  { file: 'agents/featured-product-injector/index.js', kind: 'enhance', records: false },
  { file: 'agents/schema-injector/index.js', kind: 'enhance', records: false },
  { file: 'agents/faq-rewriter/index.js', kind: 'rewrite', records: true },
  { file: 'scripts/remediate-long-titles.mjs', kind: 'serp', records: true },
  { file: 'agents/collection-linker/index.js', kind: 'enhance', records: false },
  { file: 'agents/cro-cta-injector/index.js', kind: 'enhance', records: false },
  { file: 'agents/change-queue-processor/index.js', kind: null, records: true, why: 'kind per change_type via EDIT_KIND_FOR_CHANGE' },
  { file: 'agents/publisher/index.js', kind: 'rewrite', records: true, why: 'publishApprovedQueueItems; its update branch is transport, gated by callers' },
  { file: 'agents/technical-seo/index.js', kind: 'serp', records: true, why: 'fix-meta + fix-titles on articles; link/tag fixes are repair' },
  { file: 'scripts/create-meta-ab.js', kind: 'serp', records: true },
];

/** Writers that need no gate call: compliance and repair are always allowed. */
const ALLOWLIST = [
  { file: 'agents/blog-content/index.js', kind: 'repair', why: 'fix-links strips broken links; `update` is a hand-run operator push' },
  { file: 'agents/calendar-runner/index.js', kind: 'repair', why: 'flips its own NEW scheduled draft live; no ranked page changes' },
  { file: 'agents/change-verdict/index.js', kind: 'repair', why: 'restores the BEFORE value of a change that lost its verdict' },
  { file: 'agents/editor/index.js', kind: 'repair', why: 'stale-year bump and --push-shopify sync of mechanical auto-fixes' },
  { file: 'agents/meta-ab-checker/index.js', kind: 'repair', why: 'auto-reverts a losing title/meta variant' },
  { file: 'agents/meta-ab-tracker/index.js', kind: 'repair', why: 'reverts a losing legacy variant to A' },
  { file: 'agents/publish-drift/index.js', kind: 'repair', why: 're-publishes a page that silently reverted to draft' },
  { file: 'scripts/fix-redirect-links.mjs', kind: 'repair', why: 'repoints links off redirected URLs' },
  { file: 'scripts/backfill-buyer-intent-tags.mjs', kind: 'repair', why: 'article tags only; no title, meta or body' },
  { file: 'scripts/clear-invalid-article-template-suffix.mjs', kind: 'repair', why: 'clears a template_suffix the live theme lacks' },
  { file: 'scripts/remediate-body-dump-meta-descriptions.mjs', kind: 'repair', why: 'replaces a description that is a raw body dump' },
  { file: 'scripts/apply-authored-titles.mjs', kind: 'repair', why: 'hand-authored, operator-reviewed titles; the human chose the timing' },
  { file: 'scripts/republish-boka-alternatives-2026-08-22.mjs', kind: 'repair', why: 'dated one-off: republish a silently-drafted page' },
  { file: 'scripts/restore-toothpaste-product-links-2026-10-03.mjs', kind: 'repair', why: 'dated one-off: restore buy-box product links' },
  { file: 'scripts/revert-sls-page-2026-10-03.mjs', kind: 'repair', why: 'dated one-off: revert the over-edited SLS page' },
  { file: 'scripts/retire-tattoo-duplicate-2026-09-19.mjs', kind: 'repair', why: 'dated one-off: unpublish a cannibalizing duplicate' },
  { file: 'scripts/consolidate-tattoo-soap-2026-08-22.mjs', kind: 'repair', why: 'dated one-off: unpublish a merge loser, repoint one link' },
  { file: 'scripts/unpublish-hair-duplicate-2026-08-22.mjs', kind: 'repair', why: 'dated one-off: unpublish an off-catalogue duplicate' },
  { file: 'scripts/unpublish-hair-posts-2026-08-22.mjs', kind: 'repair', why: 'dated one-off: unpublish off-catalogue posts' },
  { file: 'scripts/remediate-antiperspirant-product-copy.js', kind: 'compliance', why: 'removes the antiperspirant product-category claim' },
  { file: 'scripts/remediate-ingredient-benefit-headings.js', kind: 'compliance', why: 'tones down health-claim headings' },
  { file: 'scripts/remediate-live-health-claims.js', kind: 'compliance', why: 'removes blocking health claims' },
  { file: 'scripts/remediate-tea-tree-11-benefits-post.js', kind: 'compliance', why: 'removes health claims from one post' },
  { file: 'scripts/remediate-toothpaste-safety-claims.mjs', kind: 'compliance', why: 'removes oral drug claims' },
];

const KINDS = new Set(['compliance', 'repair', 'enhance', 'serp', 'rewrite']);

function callsGateWithKind(src, kind) {
  // `(deps.mayEditLivePost || mayEditLivePost)(t, 'kind')` counts: an injected
  // seam for tests, with the real gate as the default.
  const direct = new RegExp(`mayEditLivePost\\)?\\([^;]*?'${kind}'`);
  const injected = new RegExp(`kind:\\s*'${kind}'[\\s\\S]{0,200}mayEdit:|mayEdit:[\\s\\S]{0,200}kind:\\s*'${kind}'`);
  return direct.test(src) || (injected.test(src) && /mayEdit:\s*(apply \? )?mayEditLivePost/.test(src));
}

test('every gated writer imports lib/post-edit-gate.js and asks it with its declared kind', () => {
  for (const { file, kind } of GATED) {
    const src = read(file);
    assert.match(src, /from '(\.\.\/)+lib\/post-edit-gate\.js'|from '\.\/post-edit-gate\.js'/, `${file} must import lib/post-edit-gate.js`);
    assert.match(src, /mayEditLivePost/, `${file} must use mayEditLivePost`);
    if (kind) assert.ok(callsGateWithKind(src, kind), `${file} must ask the gate for a '${kind}' edit`);
  }
});

test('serp/rewrite writers record the material edit after the live write', () => {
  for (const { file, records } of GATED) {
    const src = read(file);
    if (records) assert.match(src, /recordMaterialEdit\)?\(/, `${file} must call recordMaterialEdit after a successful write`);
  }
});

test('every allowlisted writer names a kind that is always allowed, and a reason', () => {
  for (const { file, kind, why } of ALLOWLIST) {
    assert.ok(existsSync(join(ROOT, file)), `${file} is allowlisted but no longer exists — remove it`);
    assert.ok(KINDS.has(kind), `${file}: unknown kind ${kind}`);
    assert.ok(kind === 'repair' || kind === 'compliance', `${file}: only repair/compliance may skip the gate (got ${kind})`);
    assert.ok(why && why.length > 10, `${file}: give a reason`);
  }
  for (const { file } of GATED) assert.ok(existsSync(join(ROOT, file)), `${file} is listed as gated but no longer exists`);
});

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Does this source write a live article's body/title/summary or its SERP metafields? */
export function writesLiveArticle(src) {
  if (/\bupdateArticle\s*\(/.test(src)) return true;
  const upserts = /upsertMetafield\s*\(/.test(src);
  const onArticles = /['"]articles['"]/.test(src);
  const serpKeys = /title_tag|description_tag|TITLE_TAG|DESCRIPTION_TAG/.test(src);
  return upserts && onArticles && serpKeys;
}

test('the detector itself: catches both write shapes and ignores a reader', () => {
  assert.equal(writesLiveArticle("await deps.updateArticle(b, a, { body_html })"), true);
  assert.equal(writesLiveArticle("await upsertMetafield('articles', id, 'global', 'title_tag', t)"), true);
  assert.equal(writesLiveArticle("await upsertMetafield('products', id, 'global', 'title_tag', t)"), false);
  assert.equal(writesLiveArticle("const a = await getArticle(b, a)"), false);
});

test('every file in agents/ and scripts/ that writes a live article is either gated or allowlisted', () => {
  const known = new Set([...GATED, ...ALLOWLIST].map((e) => e.file));
  const unclassified = [];
  for (const abs of [...walk(join(ROOT, 'agents')), ...walk(join(ROOT, 'scripts'))]) {
    const rel = relative(ROOT, abs).split('\\').join('/');
    if (!writesLiveArticle(readFileSync(abs, 'utf8'))) continue;
    if (!known.has(rel)) unclassified.push(rel);
  }
  assert.deepEqual(unclassified, [],
    `New writer(s) of a live blog article: ${unclassified.join(', ')}. `
    + 'Ask lib/post-edit-gate.js mayEditLivePost(target, kind) before the write (and recordMaterialEdit after a serp/rewrite), '
    + 'then add the file to GATED — or, if it only repairs or removes a compliance problem, add it to ALLOWLIST with its kind and reason.');
});
