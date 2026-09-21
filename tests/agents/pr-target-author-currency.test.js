import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A SOURCE SCAN, not a behavioural test: `agents/pr-target-finder/index.js`
// exports nothing and parses config at module scope, so it cannot be imported
// to be asserted against. Same reasoning as
// tests/agents/seo-copy-writers-gated.test.js and
// tests/agents/link-injectors-guarded.test.js.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents', 'pr-target-finder', 'index.js'), 'utf8');

test('the agent imports the shared author-currency library', () => {
  // A hand-rolled second copy of this rule is a second copy that drifts —
  // the same reason lib/demand-questions.js imports AWARENESS_LEVELS.
  assert.match(SRC, /from '\.\.\/\.\.\/lib\/author-currency\.js'/);
  assert.match(SRC, /extractAuthorUrl/);
  assert.match(SRC, /classifyAuthorCurrency/);
});

test('a departed author DEMOTES and is never filtered out', () => {
  assert.match(SRC, /isDemoted[\s\S]{0,300}author_currency === 'departed'/);
  // Nothing anywhere may drop a row on this field. A gate may decide a target
  // is unpitchable; it may not decide the work is worthless — that answer is
  // what permanently destroyed three paid-for briefs on 2026-08-19.
  assert.ok(
    !/\.filter\([^)]*author_currency\s*!==\s*'departed'/.test(SRC),
    'a departed target must be demoted, never filtered out of pitch_targets[]',
  );
});

test('the check is capped, and a skipped row is counted rather than assumed fine', () => {
  assert.match(SRC, /AUTHOR_CHECKS/);
  assert.match(SRC, /author-check-budget-spent/);
});

test('author pages are fetched at most once each per run', () => {
  // Several ranked rows can name the same author archive page, and one request
  // answers all of them. The dedupe used to be an in-loop cache; since the
  // fetches became concurrent (2026-09-21) it is the grouping inside
  // `planAuthorChecks`, which is tested BEHAVIOURALLY in
  // tests/lib/pr-target-enrich.test.js rather than by scanning for a literal.
  // All this scan has to establish is that the agent uses it.
  assert.match(SRC, /from '\.\.\/\.\.\/lib\/pr-target-enrich\.js'/);
  assert.match(SRC, /planAuthorChecks/);
  // One pool pass over the funded GROUPS, never one per row.
  assert.match(SRC, /runPool\(funded/);
});

test('the author budget is spent in RANK order, not in arrival order', () => {
  // Racing the article fetches would otherwise make "which bylines did we
  // verify" depend on which publisher answered first, so two runs over
  // identical inputs could disagree. The plan is computed before any author
  // page is fetched — the same "decide before the cap" rule the $0-cluster
  // hold follows.
  assert.match(SRC, /planAuthorChecks\(top, \{ budget: AUTHOR_CHECKS \}\)/);
  const planAt = SRC.indexOf('planAuthorChecks(top');
  const poolAt = SRC.indexOf('runPool(funded');
  assert.ok(planAt > -1 && poolAt > planAt, 'the budget must be planned before the fetching starts');
});

test('the counts reach the console, the summary block AND the notify body', () => {
  assert.match(SRC, /Author currency:/);              // console
  assert.match(SRC, /authors_moved_outlet:/);          // summary{}
  assert.match(SRC, /authors_still_there:/);
  assert.match(SRC, /author_currency_unknown:/);
  assert.match(SRC, /author_currency_unknown_reasons:/); // the fail-open record
  assert.match(SRC, /Author moved outlet: \$\{/);      // notify body
  assert.match(SRC, /AUTHOR MOVED/);                   // markdown flag
});

test('demoted bylines are NAMED in the markdown, not just counted', () => {
  // Demotion works against visibility: the pitch section renders only the top
  // 25, and a flagged row sorts below every unflagged one — measured live, a
  // departed byline lands at rank 257 of 285, so its inline ⚠ is never seen.
  assert.match(SRC, /MOVED OUTLET — do not pitch these people here/);
  assert.match(SRC, /pitch_targets \|\| \[\]\)\.filter\(\(t\) => t\.author_currency === 'departed'\)/);
});

test('a run that could not check anything SAYS SO rather than reading as clean', () => {
  // The same job hold.disarmed does for the $0-cluster gate: "0 moved" must
  // never be indistinguishable from "we checked nobody".
  assert.match(SRC, /could not check|could not be checked/);
  assert.match(SRC, /not a verified one|not verified/);
});

test('a demotion is reported as the policy working — never an error, never immediate', () => {
  // status: 'error' means the AGENT BROKE. A target whose author moved on is a
  // FINDING, and a Failures block full of findings is a Failures block nobody
  // reads. The only 'error' in this file is the crash handler.
  // Scoped to notify() calls on purpose: `status` is also the field name on
  // fetchPageResult's return, where 'error' means "the HTTP request failed"
  // and has nothing to do with digest severity.
  const notifyCalls = SRC.match(/notify\(\{[\s\S]*?\}\)/g) || [];
  assert.ok(notifyCalls.length >= 2, 'expected the success notify and the crash handler');
  const erroring = notifyCalls.filter((c) => /status: 'error'/.test(c));
  assert.equal(erroring.length, 1, "only main()'s catch may notify with status: 'error'");
  assert.match(SRC, /PR Target Finder failed[\s\S]{0,200}status: 'error'/);
  assert.ok(!/immediate:\s*true/.test(SRC), 'nothing here may bypass the 5 AM digest');
});

test('the second fetch can distinguish a 404 from an unreachable page', () => {
  // Both are UNKNOWN and neither demotes, but only one of them is worth
  // printing as a finding — so the fetch helper must not flatten them.
  // `legacyStatus` is the narrowing, and tests/lib/fetch-pool.test.js pins that
  // it preserves `not-found` while folding every other failure to `error`.
  assert.match(SRC, /legacyStatus/);
  assert.match(SRC, /fetchStatus: legacyStatus\(outcome\)/);
});

test('an ARTICLE we never received is not reported as a page with no author', () => {
  // Before 2026-09-21 a 403, a 429, a timeout and a DNS failure all produced
  // `html = null`, and the row shipped as `no-author-page-found` — which claims
  // we read the article and it named nobody. Measured over 240 live target
  // URLs, ~12% of these fetches never see a page.
  assert.match(SRC, /unreachableCurrencyReason/);
  assert.match(SRC, /row\.enrich_fetch/);
  // The outcome is carried into the reason, so the digest's histogram names the
  // real cause (`article-blocked`, `article-timeout`, …).
  assert.match(SRC, /unreachableCurrencyReason\(row\.enrich_fetch\)/);
});
