// tests/agents/schema-injector-preserves-publish-state.test.js
//
// THE SCHEMA INJECTOR UNPUBLISHED A LIVE PAGE EVERY TIME IT PUSHED ONE.
//
// `pushToShopify()` sent `published: false` on every `updateArticle` call, with
// no reference to what the article's state actually was. Its job is to splice a
// JSON-LD block into `body_html`; it has never had a reason to touch the
// publish flag at all. So every live, indexed article it pushed became a draft
// and served 404 until `agents/publish-drift --fix` healed it at the next
// 13:45 UTC run — up to ~24h later.
//
// MEASURED, not inferred (production `data/reports/scheduler/scheduler.log`,
// read read-only 2026-08-31). The agent's own success line —
// `✓ <slug> — updated in Shopify (draft)` — maps ONE-TO-ONE onto every drift
// event in two weeks of `data/reports/publish-drift/` reports:
//
//     log push                                    drift found
//     best-natural-hand-lotion-for-dry-skin        08-25
//     best-unscented-lotion                        08-25
//     coconut-oil-for-skin-ultimate-guide-...      08-25
//     all-natural-lotion                           08-26
//     coconut-oil-pulling-...                      08-26
//     best-coconut-oil-body-lotions-...            08-27
//     is-coconut-oil-good-for-stretch-marks        08-27
//     coconut-oil-as-moisturizer                   08-29
//     coconut-oil-body-lotion-that-actually-...    08-30
//     all-natural-lotion                           08-31
//     best-clean-body-lotion-2025                  08-31
//     coconut-based-cosmetics                      08-31
//
// Roughly 22 unpublish events per fortnight, drift on 12 of 14 days. The heal
// worked, which is exactly why nobody found the generator: `publish-drift` was
// masking it daily.
//
// WHY IT CONCENTRATED ON THE LOTION CLUSTER — 72% of revenue. The `--apply`
// caller on cron is `agents/legacy-rebuilder`'s `lightRefresh()` (rising tier,
// daily, `--limit 5`), and legacy-rebuilder orders its pick list through
// `lib/cluster-efficiency.js`, which ranks lotion FIRST. The gate designed to
// spend the daily budget on the highest-earning cluster was aiming this bug at
// the highest-earning pages. Earlier in the log the same lines land on the
// toothpaste posts, which is what the 08-18..08-22 drift rows are.
//
// THE FIX IS TO SEND NOTHING. Omitting `published` leaves Shopify's state
// exactly as it is — a live post stays live, a draft stays a draft — so the
// agent needs no notion of publish state and cannot get one wrong. That is
// strictly better than `published: !!article.published_at` (the shape
// `agents/content-refresher` uses at its own call site, where it already holds
// the article object): this agent reaches articles two ways, by stored id and
// by handle lookup, and only one of them has the live record in hand. A
// preserved-state fix would have to fetch it, and would then have to decide
// what to do when the fetch fails — reintroducing the same failure direction.
//
// Empirical proof that omission preserves state, from this same fleet:
// `agents/featured-product-injector` pushes `{ body_html }` and nothing else to
// live articles daily, and those articles do not drift.
//
// Same defect class as PR #285 (content-refresher's `published: false`), which
// `project_shopify_unpublish_drift.md` recorded as "the code-side cause, found
// and fixed". It was A cause, not THE cause. This was the second one.
//
// The agent cannot be imported — it calls `process.exit(1)` at module scope on
// a missing argument and pulls in `lib/shopify.js`, which throws at import
// without OAuth credentials. So this is a source scan, the same pattern
// `tests/agents/schema-injector-dead-types.test.js` and
// `tests/agents/seo-copy-writers-gated.test.js` use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * A source file with its comments removed.
 *
 * The scan asserts "no CODE sends a publish flag". It must not fire on the
 * comment that explains why — that reasoning is the point of the change, and a
 * scan that forbids naming the field forces the explanation to be deleted.
 */
function codeOnly(path) {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const AGENT = codeOnly('agents/schema-injector/index.js');

test('the schema injector never sends a publish flag to Shopify', () => {
  // The whole bug in one assertion. `published: false` here unpublished a live
  // indexed page on every push; `published: true` would be just as wrong in the
  // other direction, silently publishing a draft the pipeline is still working
  // on. The agent edits body_html and must leave publish state alone.
  assert.ok(
    !/\bpublished\b\s*:/.test(AGENT),
    'agents/schema-injector must not pass `published` to updateArticle — it edits body_html only, '
      + 'and sending the flag either unpublishes a live page or publishes an unfinished draft',
  );
});

test('the push still updates body_html', () => {
  // Guard against "fixing" this by deleting the push. The agent's whole reason
  // to touch Shopify is to get the injected JSON-LD onto the live article.
  assert.match(AGENT, /updateArticle\(\s*blogId,\s*articleId,\s*\{[\s\S]*?body_html/);
});

test('the success line no longer claims the article was drafted', () => {
  // The log line read `— updated in Shopify (draft)`. It was accurate, which is
  // the unsettling part: the agent announced the unpublish on every run, in the
  // scheduler log, daily, and it read as a routine status. Nothing may say
  // "draft" here again, because the push no longer decides that.
  const pushBlock = AGENT.slice(AGENT.indexOf('async function pushToShopify'));
  assert.ok(
    !/\(draft\)/.test(pushBlock),
    'the push must not describe its result as a draft — it no longer sets publish state',
  );
});
