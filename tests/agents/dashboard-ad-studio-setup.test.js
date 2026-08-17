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
//
// Extended for Task 6 (ad-brief-generator plan)'s Briefs view: the id-parity check
// (2) is scoped to the whole Ad Studio JS section already, with no per-function
// allowlist, so it covers the Briefs code (appended to the same section) without any
// change here — the sanity assertions below just pin that down explicitly rather than
// leaving it to be true by construction alone. The function-reference check (3) DID
// need a code change: its name filter was `/adstudio/i`, and none of loadBriefs,
// renderBriefs, briefDecide, briefGenerate, briefRender etc. contain "adstudio" —
// widening it to also match "brief" is what makes test 3 look at them at all.
//
// Extended again for the coordinator's render/format-persistence fix (2026-08-17):
// adStudioRenderJob was refactored to accept opts.statusId/bodyId/cancelBtnId/
// judgeLinkId (defaulting to its original hardcoded #as-* ids) so briefRenderProgress
// could reuse it for the Briefs panel's own #ab-progress* elements instead of
// re-deriving the same rendering logic. That refactor moved four ids OUT of literal
// `getElementById('...')` calls and into string-literal DEFAULTS, which check (2)'s
// regex cannot see — check 2b below closes exactly that gap, extracted the same
// verbatim-source way check 1 extracts adStudioEstimate's arithmetic.

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

  // Pin the Briefs view specifically into this check, so a future edit that narrowed
  // the section boundary (or moved the Briefs code outside it) fails loudly here
  // instead of relying on the generic scan alone to have caught it.
  const briefIds = ['ab-product', 'ab-generate-btn', 'ab-generate-error', 'ab-progress',
    'ab-progress-status', 'ab-progress-body', 'ab-summary', 'ab-list', 'adstudio-briefs', 'as-view-briefs-btn'];
  const missingBriefIds = briefIds.filter((id) => !idsReferenced.has(id) || !idsInHtml.has(id));
  assert.deepEqual(
    missingBriefIds, [],
    `Briefs view ids must be both referenced by the Ad Studio JS and present in index.html; missing: ${missingBriefIds.join(', ')}`
  );

  console.log(`✓ all ${idsReferenced.size} Ad Studio getElementById ids exist in index.html`);
}

// ── 2b. adStudioRenderJob's target ids, on BOTH sides of the opts refactor ─────────
//
// adStudioRenderJob(job, opts) now resolves its four element ids from `opts.*` with
// string-literal DEFAULTS rather than four hardcoded getElementById('...') calls, so
// check 2 above (which only scans for literal getElementById calls) no longer sees
// '#as-progress-status' / '#as-progress-body' / '#as-cancel-btn' / '#as-judge-link' at
// all — extracted the same verbatim-source way check 1 extracts adStudioEstimate's
// arithmetic, so a typo'd default fails here instead of silently ceasing to be checked.
// briefRenderProgress's own override object is checked the same way, on the OTHER side
// of the same call.
{
  const idsInHtml = new Set([...indexHtml.matchAll(/\bid=["']([^"']+)["']/g)].map((m) => m[1]));

  const renderJobSrc = extractFunctionSource(dashboardSrc, 'adStudioRenderJob');
  const defaults = {
    statusId: renderJobSrc.match(/opts\.statusId\s*\|\|\s*'([^']+)'/),
    bodyId: renderJobSrc.match(/opts\.bodyId\s*\|\|\s*'([^']+)'/),
    cancelBtnId: renderJobSrc.match(/opts\.cancelBtnId\s*===\s*undefined\s*\?\s*'([^']+)'/),
    judgeLinkId: renderJobSrc.match(/opts\.judgeLinkId\s*===\s*undefined\s*\?\s*'([^']+)'/),
  };
  for (const [opt, m] of Object.entries(defaults)) {
    assert.ok(m, `adStudioRenderJob must default opts.${opt} from a string literal`);
    assert.ok(idsInHtml.has(m[1]), `adStudioRenderJob's default opts.${opt} "${m[1]}" must exist as id="..." in index.html`);
  }
  // These four must stay the New-run panel's OWN ids — the whole point of the refactor
  // was letting a second caller override them, not changing what "no override" means.
  assert.equal(defaults.statusId[1], 'as-progress-status');
  assert.equal(defaults.bodyId[1], 'as-progress-body');
  assert.equal(defaults.cancelBtnId[1], 'as-cancel-btn');
  assert.equal(defaults.judgeLinkId[1], 'as-judge-link');

  const briefRenderProgressSrc = extractFunctionSource(dashboardSrc, 'briefRenderProgress');
  const overrideStatus = briefRenderProgressSrc.match(/statusId:\s*'([^']+)'/);
  const overrideBody = briefRenderProgressSrc.match(/bodyId:\s*'([^']+)'/);
  assert.ok(overrideStatus, 'briefRenderProgress must pass a literal statusId override');
  assert.ok(overrideBody, 'briefRenderProgress must pass a literal bodyId override');
  assert.ok(idsInHtml.has(overrideStatus[1]), `briefRenderProgress's statusId override "${overrideStatus[1]}" must exist in index.html`);
  assert.ok(idsInHtml.has(overrideBody[1]), `briefRenderProgress's bodyId override "${overrideBody[1]}" must exist in index.html`);
  // Explicitly null, not left at the New-run panel's defaults — a Briefs render must
  // never toggle #as-cancel-btn or #as-judge-link, the OTHER view's own controls.
  assert.match(briefRenderProgressSrc, /cancelBtnId:\s*null/, 'briefRenderProgress must pass cancelBtnId: null, not default to #as-cancel-btn');
  assert.match(briefRenderProgressSrc, /judgeLinkId:\s*null/, 'briefRenderProgress must pass judgeLinkId: null, not default to #as-judge-link');

  console.log('✓ adStudioRenderJob\'s default ids and briefRenderProgress\'s override ids both resolve in index.html');
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

  // "brief" added for Task 6's Briefs view: loadBriefs, renderBriefs, briefDecide,
  // briefGenerate, briefRenderCommand and friends carry no "adstudio" substring at
  // all, so the original pattern would have silently skipped every one of them —
  // exactly the class of bug this test exists to catch (see the module comment).
  // Safe to widen: verified by direct search that neither #adstudio-panel's markup
  // nor the Ad Studio JS section (from `var adStudioState` onward) contained any
  // pre-existing "brief" identifier before this task, so nothing already in scope
  // gets newly (and wrongly) swept in.
  const AD_STUDIO_NAME = /adstudio|brief/i;

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

  // Pin the Briefs functions specifically, so a rename that keeps everything internally
  // consistent (call site and definition renamed together) but drifts from what this
  // task actually shipped still shows up as a coverage gap rather than passing quietly.
  const briefFns = ['switchAdStudioView', 'loadBriefs', 'renderBriefs', 'briefDecide', 'briefGenerate',
    'briefRender', 'briefFormatChanged'];
  const missingBriefFns = briefFns.filter((name) => !allCalled.has(name) || !definedFunctions.has(name));
  assert.deepEqual(
    missingBriefFns, [],
    `Briefs view functions must be both referenced and defined; missing: ${missingBriefFns.join(', ')}`
  );

  console.log(`✓ all ${allCalled.size} Ad Studio function references resolve to a real definition in dashboard.js`);
}
