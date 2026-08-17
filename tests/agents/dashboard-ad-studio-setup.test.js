import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateRenders, countTargetKinds } from '../../lib/ad-studio-cost.js';
import { selectTargets } from '../../agents/ad-studio/packaging.js';

// Task 6 (Ad Studio setup screen): two things nobody can eyeball in this test suite —
// a browser is not available here — but both are cheap to prove without one.
//
//   1. adStudioEstimate() in dashboard.js duplicates lib/ad-studio-cost.js's arithmetic
//      on purpose (the estimate has to move on every checkbox click, and a round trip
//      per click over a slow ngrok tunnel would not do that). Duplication drifts
//      silently, so this test extracts the ACTUAL arithmetic out of the shipped source
//      and runs it, rather than re-typing the formula by hand and testing itself.
//   2. Every element id the Ad Studio browser code calls document.getElementById() on
//      must exist in index.html. A missed wrap or a typo'd id is otherwise a silent
//      blank-panel failure with nothing in the console.

const DASHBOARD_JS_PATH = join('agents', 'dashboard', 'public', 'js', 'dashboard.js');
const INDEX_HTML_PATH = join('agents', 'dashboard', 'public', 'index.html');
const dashboardSrc = readFileSync(DASHBOARD_JS_PATH, 'utf8');
const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');

/**
 * Extract the full source text of `function <name>(...) { ... }` by brace-depth
 * balancing from the opening `{`. Good enough for this file: the Ad Studio functions
 * contain no braces inside string or regex literals, only in real nested blocks.
 */
function extractFunctionSource(src, name) {
  const marker = `function ${name}(`;
  const start = src.indexOf(marker);
  assert.ok(start !== -1, `${name} must be defined in ${DASHBOARD_JS_PATH}`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  assert.ok(depth === 0, `could not find a balanced closing brace for ${name}`);
  return src.slice(start, i + 1);
}

// ── 1. Cost-formula parity ─────────────────────────────────────────────────────────
{
  const estimateSrc = extractFunctionSource(dashboardSrc, 'adStudioEstimate');

  // Pull the two arithmetic lines out VERBATIM — this is the drift surface. If a future
  // edit renames `set.meta`/`set.demandGen` or changes the shape without updating this
  // regex, the test fails loudly (via the assert.ok below) rather than silently
  // comparing stale text.
  const expectedLine = estimateSrc.match(/var expected = ([^;]+);/);
  const worstLine = estimateSrc.match(/var worst = ([^;]+);/);
  assert.ok(expectedLine, 'adStudioEstimate() must compute "var expected = ...;"');
  assert.ok(worstLine, 'adStudioEstimate() must compute "var worst = ...;"');

  // Run the EXTRACTED expression text as real code (not a hand-copied re-implementation)
  // against `concepts` and `set` — the exact two inputs adStudioEstimate derives them
  // from (formats.length * variations, and the target-set row from /api/ad-studio/options).
  const calc = new Function('concepts', 'set', `
    var expected = ${expectedLine[1]};
    var worst = ${worstLine[1]};
    return { expected: expected, worstCase: worst };
  `);

  const cases = [
    { label: '1 format / 1 variation / meta', formats: 1, variations: 1, targetKey: 'meta' },
    { label: '1 format / 1 variation / all', formats: 1, variations: 1, targetKey: 'all' },
    { label: '2 formats / 1 variation / meta', formats: 2, variations: 1, targetKey: 'meta' },
    { label: '3 formats / 3 variations / all', formats: 3, variations: 3, targetKey: 'all' },
  ];

  for (const c of cases) {
    const targets = selectTargets(c.targetKey);
    const { meta, demandGen } = countTargetKinds(targets);
    const concepts = c.formats * c.variations;

    const browser = calc(concepts, { meta, demandGen });
    const server = estimateRenders({
      formats: Array.from({ length: c.formats }, (_, n) => `fmt-${n}`),
      variations: c.variations,
      targets,
    });

    assert.equal(
      browser.expected, server.expected,
      `${c.label}: browser expected (${browser.expected}) must match lib/ad-studio-cost.js's estimateRenders (${server.expected})`
    );
    assert.equal(
      browser.worstCase, server.worstCase,
      `${c.label}: browser worstCase (${browser.worstCase}) must match lib/ad-studio-cost.js's estimateRenders (${server.worstCase})`
    );
  }

  // Pin the brief's own worked examples so a future edit that keeps both formulas in
  // sync with EACH OTHER but drifts them both away from the intended numbers still fails.
  const metaOne = calc(1, countTargetKinds(selectTargets('meta')));
  assert.equal(metaOne.expected, 6, '1 format/1 variation/meta must estimate 6 renders');
  assert.equal(metaOne.worstCase, 12, '1 format/1 variation/meta worst case must be 12 renders');
  const allOne = calc(1, countTargetKinds(selectTargets('all')));
  assert.equal(allOne.expected, 9, '1 format/1 variation/all must estimate 9 renders');
  assert.equal(allOne.worstCase, 21, '1 format/1 variation/all worst case must be 21 renders');

  console.log('✓ adStudioEstimate() arithmetic matches lib/ad-studio-cost.js across 4 combinations');
}

// ── 2. Element-id parity ───────────────────────────────────────────────────────────
{
  // Scope to the Ad Studio section of dashboard.js: everything from `var adStudioState`
  // to end of file is Ad Studio browser code (verified against the current file layout
  // below), so this does not need a per-function allowlist that would silently stop
  // covering a newly added function.
  const sectionStart = dashboardSrc.indexOf('var adStudioState');
  assert.ok(sectionStart !== -1, 'adStudioState must exist in dashboard.js');
  const adStudioSection = dashboardSrc.slice(sectionStart);

  const idsReferenced = new Set(
    [...adStudioSection.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  );
  assert.ok(idsReferenced.size > 0, 'sanity: the Ad Studio section must call getElementById at least once');

  const idsInHtml = new Set([...indexHtml.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

  const missing = [...idsReferenced].filter((id) => !idsInHtml.has(id));
  assert.deepEqual(
    missing, [],
    `every getElementById id the Ad Studio JS calls must exist as id="..." in index.html; missing: ${missing.join(', ')}`
  );

  console.log(`✓ all ${idsReferenced.size} Ad Studio getElementById ids exist in index.html`);
}
