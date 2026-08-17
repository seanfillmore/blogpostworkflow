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

// ── 3. Function-reference parity ───────────────────────────────────────────────────
// Review finding (2026-08-16): switchAdStudioView('judge') called loadAdStudioRuns(),
// which is referenced exactly once in the whole repo and defined nowhere — the real
// function is refreshAdStudioRuns(). Neither test 1 nor test 2 above can see this class
// of bug: it is not an arithmetic mismatch and not a missing element id, it is a
// function reference with no matching definition. This closes that gap: every function
// name invoked from an inline handler (onclick/onchange/oninput) inside #adstudio-panel,
// and every Ad-Studio-named function called from within the Ad Studio JS itself, must
// resolve to a real `function <name>(...)` in dashboard.js.
{
  /**
   * Bound the `<div id="...">...</div>` subtree by DIV DEPTH, not by a naive regex to
   * the next `</div>` (which would stop at the first nested close and miss almost
   * everything) or by slicing to end-of-file (which was tried and liberally over-matched
   * — it pulled in Ad Builder, template-modal and mobile-tab-switch onclick handlers
   * that have nothing to do with Ad Studio and would have hidden a real gap behind a
   * mountain of unrelated, already-passing names).
   */
  function extractDivById(html, id) {
    const marker = `<div id="${id}"`;
    const start = html.indexOf(marker);
    assert.ok(start !== -1, `#${id} must exist in ${INDEX_HTML_PATH}`);
    const openTagEnd = html.indexOf('>', start) + 1;
    assert.ok(openTagEnd > 0, `#${id}'s opening tag must be closed`);
    let depth = 1;
    let i = openTagEnd;
    while (depth > 0) {
      const nextOpen = html.indexOf('<div', i);
      const nextClose = html.indexOf('</div>', i);
      assert.ok(nextClose !== -1, `#${id}'s <div> must have a matching </div>`);
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth++;
        i = nextOpen + 4;
      } else {
        depth--;
        i = nextClose + 6;
      }
    }
    return html.slice(start, i);
  }

  /** Every `<identifier>(` in `text` whose name matches `pattern`. */
  function callNamesMatching(text, pattern) {
    const names = new Set();
    for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (pattern.test(m[1])) names.add(m[1]);
    }
    return names;
  }

  const AD_STUDIO_NAME = /adstudio/i;

  const panelHtml = extractDivById(indexHtml, 'adstudio-panel');
  const handlerAttrs = [...panelHtml.matchAll(/\b(?:onclick|onchange|oninput)="([^"]*)"/g)].map((m) => m[1]);
  assert.ok(handlerAttrs.length > 0, 'sanity: #adstudio-panel must carry inline handler attributes to scan');

  const markupCalls = new Set();
  for (const attr of handlerAttrs) {
    for (const name of callNamesMatching(attr, AD_STUDIO_NAME)) markupCalls.add(name);
  }
  assert.ok(markupCalls.size > 0, 'sanity: #adstudio-panel must reference at least one Ad Studio function by name');

  // The Ad Studio JS section — same boundary test 2 uses, and for the same reason: it is
  // everything from `var adStudioState` to end of file, which is also where dynamically
  // built onclick attributes (e.g. renderAdStudioRun's per-target buttons) live as string
  // literals in the SOURCE — scanning this text (not executing it) still finds those
  // names, which is exactly what is wanted: they become real onclick attributes at
  // runtime even though index.html never contains them literally.
  const jsSectionStart = dashboardSrc.indexOf('var adStudioState');
  assert.ok(jsSectionStart !== -1, 'adStudioState must exist in dashboard.js');
  const adStudioJs = dashboardSrc.slice(jsSectionStart);
  const jsCalls = callNamesMatching(adStudioJs, AD_STUDIO_NAME);
  assert.ok(jsCalls.size > 0, 'sanity: the Ad Studio JS section must call at least one Ad Studio function by name');

  const definedFunctions = new Set(
    [...dashboardSrc.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
  );
  assert.ok(definedFunctions.size > 50, 'sanity: dashboard.js must define plenty of functions');

  const allCalled = new Set([...markupCalls, ...jsCalls]);
  const undefinedCalls = [...allCalled].filter((name) => !definedFunctions.has(name));
  assert.deepEqual(
    undefinedCalls, [],
    'every Ad Studio function referenced from #adstudio-panel markup or the Ad Studio JS ' +
    `must be defined in dashboard.js; missing: ${undefinedCalls.join(', ')}`
  );

  console.log(`✓ all ${allCalled.size} Ad Studio function references resolve to a real definition in dashboard.js`);
}
