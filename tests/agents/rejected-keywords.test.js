// ONE matching rule for data/rejected-keywords.json.
//
// This file used to PIN THE DIVERGENCE — it asserted that content-strategist's
// `exact` did NOT slug-normalize while pipeline-scheduler's did, as a record that
// nine hand-rolled copies existed and disagreed. They now all delegate to
// `lib/rejected-keywords.js`, so the assertions that described the disagreement
// are gone and the ones that describe the RULE are kept and extended.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRejected } from '../../lib/rejected-keywords.js';
import { isRejected as schedulerIsRejected } from '../../agents/pipeline-scheduler/index.js';
import { isRejected as strategistIsRejected, buildRejectionSection } from '../../agents/content-strategist/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const exactR = [{ keyword: 'sls', matchType: 'exact' }];
const phraseR = [{ keyword: 'sls', matchType: 'phrase' }];
const broadR = [{ keyword: 'sls', matchType: 'broad' }];

test('exact matches the same keyword, case-insensitively', () => {
  assert.equal(isRejected('sls', exactR), true);
  assert.equal(isRejected('SLS', exactR), true);
});

test('exact does NOT match a longer keyword containing the term', () => {
  assert.equal(isRejected('best sls free toothpaste', exactR), false);
});

test('exact normalizes punctuation — "sls free" and "sls-free" are one keyword', () => {
  // Calendar markdown and the dashboard reject-form disagree about which spelling
  // they hand us. content-strategist used to say false here and the scheduler
  // true; that split is what this file previously existed to record.
  assert.equal(isRejected('sls free', [{ keyword: 'sls-free', matchType: 'exact' }]), true);
  assert.equal(strategistIsRejected('sls free', [{ keyword: 'sls-free', matchType: 'exact' }]), true);
  assert.equal(schedulerIsRejected('sls free', [{ keyword: 'sls-free', matchType: 'exact' }]), true);
});

test('anything that is not exact is a SUBSTRING match', () => {
  // 37 of the 39 live entries are `broad` or carry no matchType at all, and
  // substring is what content-strategist — the agent that WRITES most of them —
  // has always meant by that.
  assert.equal(isRejected('best sls free toothpaste', phraseR), true);
  assert.equal(isRejected('sls toothpaste', broadR), true);
  assert.equal(isRejected('unrelated keyword', phraseR), false);
  assert.equal(isRejected('anything', [{ keyword: 'sls' }]), false, 'no matchType still needs the substring to be present');
  assert.equal(isRejected('sls anything', [{ keyword: 'sls' }]), true);
});

test('a BARE STRING is accepted as an entry', () => {
  // scripts/triage-orphan-briefs.mjs flattened the list this way for its whole
  // life. A shared rule that rejected its input would just be a tenth dialect.
  assert.equal(isRejected('sls toothpaste', ['sls']), true);
  assert.equal(isRejected('sls toothpaste', ['unrelated']), false);
});

test('an empty list, an empty keyword and a junk entry never block', () => {
  assert.equal(isRejected('anything', []), false);
  assert.equal(isRejected('', exactR), false);
  assert.equal(isRejected('sls', [{ keyword: '' }, null, undefined, { }]), false);
});

test('all three former dialects now agree, on the cases that used to split them', () => {
  const cases = [
    ['sls free', [{ keyword: 'sls-free', matchType: 'exact' }]],
    ['SLS', exactR],
    ['best sls toothpaste', exactR],
    ['best sls toothpaste', phraseR],
  ];
  for (const [kw, rs] of cases) {
    assert.equal(strategistIsRejected(kw, rs), isRejected(kw, rs), `strategist diverged on "${kw}"`);
    assert.equal(schedulerIsRejected(kw, rs), isRejected(kw, rs), `scheduler diverged on "${kw}"`);
  }
});

// ── the rule that keeps it one rule ─────────────────────────────────────────

test('nothing hand-rolls the match any more', () => {
  // A source scan, because importing an agent runs it. Nine copies existed; the
  // tenth is what this test is for. `matchType` also names Google Ads match types
  // (EXACT/PHRASE/BROAD) in the ads agents — an unrelated concept, excluded.
  const walk = (d, out = []) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n.startsWith('.')) continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(js|mjs)$/.test(n)) out.push(p);
    }
    return out;
  };
  const offenders = ['agents', 'lib', 'scripts']
    .flatMap((d) => walk(join(ROOT, d)))
    .map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, 'utf8') }))
    .filter(({ rel }) => rel !== 'lib/rejected-keywords.js')
    .filter(({ rel }) => !/ads|campaign/i.test(rel))
    .filter(({ text }) => /matchType\s*===\s*'exact'/.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, [], `import isRejected from lib/rejected-keywords.js instead:\n  ${offenders.join('\n  ')}`);
});

test('triage-orphan-briefs passes ENTRIES, not flattened keywords', () => {
  // Flattening to strings is what discarded matchType and made the destructive
  // path — the one that archives paid briefs — silently under-match.
  const src = readFileSync(join(ROOT, 'scripts', 'triage-orphan-briefs.mjs'), 'utf8');
  assert.doesNotMatch(src, /\.map\(\(r\) => r\.keyword\)/, 'the entries must reach brief-triage intact');
});

test('the live list carries no entry whose substring reach exceeds its intent', () => {
  // "sodium lauryl sulfate" was rejected as a standalone ingredient-EXPLAINER
  // topic ("no product mapping"), but with no matchType it matched as a substring
  // and blocked "toothpaste without sodium lauryl sulfate" — a phrase this site
  // holds a LOCKED WINNER for (toothpaste-without-sls, the biggest page on the
  // blog). It is `exact` now. This asserts the fix, not a general rule.
  const live = JSON.parse(readFileSync(join(ROOT, 'data', 'rejected-keywords.json'), 'utf8'));
  const sls = live.find((r) => r.keyword === 'sodium lauryl sulfate');
  assert.ok(sls, 'fixture assumption: the entry is still on the list');
  assert.equal(sls.matchType, 'exact', 'narrowing this entry is what makes unification behaviourally inert');
  assert.equal(isRejected('toothpaste without sodium lauryl sulfate', live), false, 'a locked winner must stay writable');
  assert.equal(isRejected('sodium lauryl sulfate', live), true, 'the explainer topic it was rejected for stays blocked');
});

// ── unchanged ───────────────────────────────────────────────────────────────

test('buildRejectionSection still renders', () => {
  assert.equal(buildRejectionSection([]), '');
  const section = buildRejectionSection([
    { keyword: 'sls', matchType: 'broad', reason: 'too broad' },
    { keyword: 'itchy armpits', matchType: 'exact', reason: null },
  ]);
  assert.ok(section.includes('"itchy armpits" (exact match)'), 'exact entry present');
});
