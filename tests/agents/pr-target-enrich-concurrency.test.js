import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A SOURCE SCAN, not a behavioural test: `agents/pr-target-finder/index.js`
// exports nothing and parses config at module scope, so it cannot be imported
// without running the agent. The scheduling and classification logic it wires
// together IS tested behaviourally, in tests/lib/fetch-pool.test.js and
// tests/lib/pr-target-enrich.test.js; what this file pins is the WIRING.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT = join(ROOT, 'agents', 'pr-target-finder', 'index.js');
const SRC = readFileSync(AGENT, 'utf8');
const SCHEDULER = readFileSync(join(ROOT, 'scheduler.js'), 'utf8');

test('enrichment goes through the bounded pool, never a bare Promise.all', () => {
  // An unbounded `Promise.all(rows.map(fetch))` over 400 publishers is the
  // shape this change exists to avoid — and it is the easy accidental edit.
  assert.match(SRC, /from '\.\.\/\.\.\/lib\/fetch-pool\.js'/);
  assert.match(SRC, /runPool\(/);
  assert.ok(
    !/Promise\.all\([\s\S]{0,120}\.map\([\s\S]{0,120}fetch/i.test(SRC),
    'fetches must be scheduled by runPool, not fanned out with Promise.all',
  );
});

test('the pool is bounded PER HOST, and on the registrable domain', () => {
  // A global width says nothing about how many of those requests land on one
  // publisher. CLAUDE.md's Ahrefs section records a hand crawl of one host at
  // ~6 concurrent earning a 429 on every subsequent request from that IP.
  assert.match(SRC, /perHost: PER_HOST/);
  assert.match(SRC, /keyOf: \(row\) => hostGroup\(/);
  assert.match(SRC, /keyOf: \(g\) => hostGroup\(g\.url\)/);
});

test('both limits are flags, so they can be turned down without a deploy', () => {
  assert.match(SRC, /argVal\('--concurrency'/);
  assert.match(SRC, /argVal\('--per-host'/);
  // Clamped at both ends: a typo must not become an unbounded sweep, and a 0
  // or a NaN must not stall the pass entirely.
  assert.match(SRC, /const CONCURRENCY = Math\.max\(1, Math\.min\(MAX_CONCURRENCY/);
  assert.match(SRC, /const PER_HOST = Math\.max\(1, Math\.min\(MAX_PER_HOST/);
});

test('every existing flag still works', () => {
  for (const flag of ['--no-enrich', '--enrich', '--author-checks', '--no-author-check', '--no-resolve', '--weeks']) {
    assert.ok(SRC.includes(flag), `${flag} must keep working`);
  }
});

test('the scheduler passes neither budget, so the agent owns both numbers', () => {
  const step = SCHEDULER.match(/runStep\('pr-target-finder'[^\n]*/)?.[0] || '';
  assert.ok(step, 'the scheduler must still dispatch this agent');
  assert.ok(!/--enrich|--concurrency|--per-host/.test(step),
    'a second copy of these numbers in scheduler.js is a second copy that drifts');
});

test('a fetch outcome is recorded on the ROW, not collapsed into a null body', () => {
  // The whole point: a 403, a 429, a timeout and a DNS failure used to be
  // indistinguishable from a page that genuinely names nobody.
  assert.match(SRC, /row\.enrich_fetch = outcome/);
  assert.match(SRC, /enrich_fetch_outcomes:/);
  assert.match(SRC, /author_page_fetch_outcomes:/);
});

test('a row past the budget is NOT-ATTEMPTED, a distinct finding from a failure', () => {
  // "We did not look" and "we looked and were refused" need different fixes.
  assert.match(SRC, /enrich_fetch = 'not-attempted'/);
  assert.match(SRC, /enrich_not_attempted:/);
  assert.match(SRC, /enrich_fetch_failed:/);
});

test('an unreachable page can never read as a FRESH article', () => {
  // isStaleArticle fails open, so a page with no dates is "not stale" — which
  // would silently certify exactly the dead targets the check exists to
  // demote. The date source has to say `unreachable` instead.
  assert.match(SRC, /articleDateSource\(\{ topUrl: row\.top_url, outcome \}\)/);
  assert.match(SRC, /const readable = row\.article_date_source === 'article'/);
  assert.match(SRC, /row\.stale_article = readable \?/);
  assert.match(SRC, /freshness_unknown_unreachable:/);
});

test('an unreachable row is DEMOTED BY NOTHING — unknown never demotes', () => {
  // Every demotion is evidence the work cannot land. "The publisher would not
  // serve our user agent" is evidence of nothing about the target.
  const demote = SRC.match(/function isDemoted\(row\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(demote, 'isDemoted must still exist');
  assert.ok(!/enrich_fetch/.test(demote), 'a page we could not read must keep its rank');
});

test('an under-enriched run SAYS SO, in the console AND in the digest body', () => {
  // This agent runs unattended as scheduler step 8d and nobody reads its
  // stdout, so the coverage has to reach the 5 AM digest. Same job
  // hold.disarmed does for the $0-cluster gate.
  assert.match(SRC, /degradedReason/);
  assert.match(SRC, /enrich_degraded:/);
  assert.match(SRC, /Enrichment is DEGRADED this run/);
  const notifyBody = SRC.match(/body: \([\s\S]{0,400}?\)\s*\+\s*coverage\s*\+\s*currency/);
  assert.ok(notifyBody, 'the coverage block must be in the notify body');
  assert.match(SRC, /const coverage = ENRICH > 0/);
  assert.match(SRC, /A fetch we never received is NOT a target with no byline/);
});

test('coverage stays a FINDING — never an error, never immediate', () => {
  // status: 'error' means the AGENT BROKE. A publisher refusing us is a
  // reading, and a Failures block full of readings is one nobody reads.
  const notifyCalls = SRC.match(/notify\(\{[\s\S]*?\}\)/g) || [];
  const erroring = notifyCalls.filter((c) => /status: 'error'/.test(c));
  assert.equal(erroring.length, 1, "only main()'s catch may notify with status: 'error'");
  assert.ok(!/immediate:\s*true/.test(SRC), 'nothing here may bypass the 5 AM digest');
});

test('the rate-limit retry budget is shared across the whole run', () => {
  // Per-call it would be 400 retries; shared it is at most MAX_RATE_LIMIT_RETRIES.
  assert.match(SRC, /const rateLimitBudget = \{ spent: 0 \}/);
  assert.match(SRC, /fetchWithOutcome\(url, \{ rateLimitBudget \}\)/);
});

test('the markdown tells a human that a target was never checked', () => {
  // A count in the JSON that never reaches the report is a count nobody reads.
  assert.match(SRC, /NOT CHECKED \(\$\{unreached\}\)/);
  assert.match(SRC, /we never received this page/);
  assert.match(SRC, /_Coverage: \*\*\$\{s\.enriched/);
});
