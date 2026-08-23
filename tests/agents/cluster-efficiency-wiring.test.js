// tests/agents/cluster-efficiency-wiring.test.js
//
// That each agent APPLIES the efficiency ranking, and applies it BEFORE its own
// per-run cap — the same order rule the hold already follows, and for the same
// reason: a budget of five spent on the five least efficient candidates is a
// budget spent on traffic that does not convert.
//
// The ranking itself is tested in tests/lib/cluster-efficiency.test.js. This
// file is about the WIRING, plus the two agents deliberately left out of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankClusters } from '../../lib/cluster-efficiency.js';
import { holdFor, heldScenario } from '../helpers/cluster-fixtures.js';
import { selectLegacyPosts } from '../../agents/legacy-rebuilder/index.js';
import { selectBlockedPostsWithHold } from '../../agents/blocked-post-resolver/index.js';
import { holdMetaCandidates } from '../../agents/meta-optimizer/lib/hold.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const raw = (rel) => readFileSync(join(ROOT, rel), 'utf8');
/**
 * Executable source only, matching tests/agents/cluster-hold-wiring.test.js.
 * These files carry long historical docstrings that legitimately name a cluster
 * — that is the documentation doing its job. The rules below are about the CODE.
 */
const code = (rel) => raw(rel)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const HOLD = holdFor();
const RANKING = rankClusters(HOLD);

// The real order on the 2026-08-23 production numbers, recomputed rather than
// typed: lotion > soap > lip balm > deodorant > toothpaste > coconut oil.
const TOOTH = 'no-fluoride-toothpaste';
const LOTION = (n) => `best-coconut-oil-body-lotion-${n}`;

// ── legacy-rebuilder: scheduler runs it at --limit 5 ─────────────────────────

test('legacy-rebuilder orders its pick list before --limit, not after', () => {
  const posts = [
    { slug: TOOTH, meta: {} },
    ...[1, 2, 3, 4, 5].map((n) => ({ slug: LOTION(n), meta: {} })),
  ];
  const { kept } = selectLegacyPosts(posts, { hold: HOLD, ranking: RANKING, limit: 5 });
  // Held after the cap, the toothpaste post would sit at index 0 and eat a slot
  // ahead of five lotion posts. Ordered before it, it lands in the reserved slot.
  assert.equal(kept.slice(0, 4).every((p) => p.slug.includes('lotion')), true);
  assert.equal(kept[4].slug, TOOTH);
});

test('legacy-rebuilder with no ranking returns exactly what it always did', () => {
  const posts = [{ slug: TOOTH, meta: {} }, { slug: LOTION(1), meta: {} }];
  const { kept, efficiency } = selectLegacyPosts(posts, { hold: HOLD });
  assert.equal(efficiency, null);
  assert.deepEqual(kept.map((p) => p.slug), [TOOTH, LOTION(1)]);
});

// ── blocked-post-resolver: --limit 5, each candidate a chain of paid LLM calls ─

// Same shape tests/agents/cluster-hold-wiring.test.js uses — classifyBlockedReport
// needs a real editor report and a live-looking meta before it yields a verdict.
const NEEDS_WORK = '## OVERALL QUALITY\nVERDICT: Needs Work\n\n## BLOCKERS\n1. Factual concerns: an uncited statistic.\n';
const NOW = Date.parse('2026-08-22T12:00:00Z');
const entry = (slug) => ({
  slug,
  meta: { shopify_blog_id: 1, shopify_article_id: 2, shopify_publish_at: '2025-06-25T11:00:07-06:00' },
  report: NEEDS_WORK,
  reportAgeDays: 2,
});

test('blocked-post-resolver spends its budget on the efficient clusters first', () => {
  const entries = [entry(TOOTH), entry(LOTION(1)), entry('best-soap-for-tattoos')];
  const { kept } = selectBlockedPostsWithHold(entries, { now: NOW, hold: HOLD, ranking: RANKING, limit: 3 });
  assert.deepEqual(kept.map((e) => e.slug), [LOTION(1), 'best-soap-for-tattoos', TOOTH]);
});

test('blocked-post-resolver never reorders a hand-typed --slug run', () => {
  const entries = [entry(TOOTH), entry(LOTION(1))];
  const { kept, efficiency } = selectBlockedPostsWithHold(entries, {
    now: NOW, hold: HOLD, ranking: RANKING, limit: 5, slug: TOOTH,
  });
  assert.equal(efficiency, null);
  assert.deepEqual(kept.map((e) => e.slug), [TOOTH]);
});

// ── meta-optimizer: weekly --apply --limit 5, spent in sortByValidation order ──

test('meta-optimizer reorders the low-CTR candidate list before the weekly cap', () => {
  const candidates = [
    { keyword: 'sls free toothpaste' },
    { keyword: 'best coconut oil body lotion' },
    { keyword: 'best soap for tattoos' },
  ];
  const { kept } = holdMetaCandidates(candidates, HOLD, { ranking: RANKING, limit: 3 });
  assert.deepEqual(kept.map((c) => c.keyword), [
    'best coconut oil body lotion', 'best soap for tattoos', 'sls free toothpaste',
  ]);
});

test('meta-optimizer with no ranking keeps sortByValidation order untouched', () => {
  const candidates = [{ keyword: 'sls free toothpaste' }, { keyword: 'best coconut oil body lotion' }];
  const { kept, efficiency } = holdMetaCandidates(candidates, HOLD);
  assert.equal(efficiency, null);
  assert.deepEqual(kept.map((c) => c.keyword), candidates.map((c) => c.keyword));
});

// ── the hold still wins, everywhere ──────────────────────────────────────────

test('a held cluster is EXCLUDED, never merely demoted — ranking does not soften the hold', () => {
  const held = holdFor({ ...heldScenario('toothpaste'), generatedAt: '2026-08-23T10:00:00Z' });
  const ranking = rankClusters(held);
  const posts = [{ slug: TOOTH, meta: {} }, { slug: LOTION(1), meta: {} }];
  const out = selectLegacyPosts(posts, { hold: held, ranking, limit: 5 });
  assert.deepEqual(out.kept.map((p) => p.slug), [LOTION(1)]);
  assert.equal(out.held.length, 1);
});

// ── the two deliberate omissions ─────────────────────────────────────────────

test('indexing-fixer is deliberately NOT ranked — its refresh list has no per-run cap', () => {
  const src = raw('agents/indexing-fixer/index.js');
  assert.equal(/cluster-efficiency/.test(src), false,
    'indexing-fixer must not import the ranking: it refreshes every actionable post, '
    + 'so an order would change nothing and would be dead code');
  // The premise of that omission, pinned: no cap is applied to the list.
  assert.equal(/contentQuality[\s\S]{0,40}\.slice\(/.test(src), false,
    'if a cap is ever added to the content-quality list, this agent has to be ranked too');
});

test('queue-autoapply is deliberately NOT ranked — oldest-first IS its anti-starvation rule', () => {
  assert.equal(/cluster-efficiency/.test(raw('lib/queue-autoapply.js')), false);
  assert.equal(/cluster-efficiency/.test(raw('agents/queue-autoapply/index.js')), false);
});

// ── source-level invariants ──────────────────────────────────────────────────

test('every ranked agent ranks BEFORE its cap, and names no cluster in code', () => {
  const files = [
    'agents/performance-engine/index.js',
    'agents/legacy-rebuilder/index.js',
    'agents/blocked-post-resolver/index.js',
    'agents/refresh-runner/index.js',
    'agents/meta-optimizer/lib/hold.js',
  ];
  for (const rel of files) {
    assert.ok(/cluster-efficiency\.js/.test(raw(rel)), `${rel} must consult the shared ranking`);
    const src = code(rel);
    assert.ok(!/toothpaste/i.test(src), `${rel} must not hardcode a cluster name`);
    assert.ok(!/\blip balm\b/i.test(src), `${rel} must not hardcode a cluster name`);
  }
});

test('nothing in the ranking path can kill, unpublish or redirect a deprioritised page', () => {
  // The whole point of a ranking rather than a block: it changes ORDER and
  // nothing else. Same invariant the hold path carries.
  const src = code('lib/cluster-efficiency.js');
  for (const pattern of [/post-kill/, /unpublish/, /createRedirect/, /unlinkSync/, /published:\s*false/]) {
    assert.ok(!pattern.test(src), `lib/cluster-efficiency.js must not ${pattern}`);
  }
});

test('the ranking is derived from the shared constant, not re-declared per agent', () => {
  for (const rel of ['agents/performance-engine/index.js', 'agents/meta-optimizer/lib/hold.js',
    'agents/refresh-runner/index.js', 'agents/legacy-rebuilder/index.js',
    'agents/blocked-post-resolver/index.js']) {
    assert.equal(/MIN_CLICKS\s*=/.test(code(rel)), false, `${rel} must not re-declare the prior weight`);
  }
});
