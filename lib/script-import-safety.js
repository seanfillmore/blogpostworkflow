/**
 * Would importing this script RUN it?
 *
 * ── Why this is scoped the way it is ────────────────────────────────────────
 * `reference_agents_run_on_import` is about modules a TEST imports: a script
 * nobody imports runs when you run it, which is the whole point of a script.
 * So the condition that matters is the CONJUNCTION —
 *
 *     imported by something   AND   makes a live call at module scope
 *
 * Measured 2026-09-06 over 61 scripts making a live call somewhere and 44
 * imported by something: exactly ONE satisfied both, `sync-subscription-copy.mjs`,
 * and it was found by its test suite taking 1.9 SECONDS instead of milliseconds
 * — it fired `listPlans()` and a `getPlan()` per plan against live Recurpay on
 * every import. Five more scripts would do the same IF anyone imported them
 * (`build-variant-value-stacks`, `check-content-mirrors`,
 * `fix-bar-soap-subscription` — which holds MUTATIONS — `reconcile-content-mirrors`,
 * `upload-post`), and this check is what turns writing the first test against
 * one of them into a failure rather than a surprise API call.
 *
 * MASS-GUARDING THE OTHER 58 WOULD BE THE WRONG FIX, and the asymmetry is the
 * reason: a guard that wrongly reads "imported" turns a script into a silent
 * no-op that still exits 0, which is strictly worse than the hazard. The same
 * argument `lib/is-direct-run.js` already makes.
 *
 * ── Depth, not a regex ──────────────────────────────────────────────────────
 * The first version matched `await fetch(` line-anchored and reported 61 files,
 * three of which it then had to retract — it could not tell module scope from a
 * function body, and all three imported in ~10ms. Brace depth can. A call at
 * depth 0 runs on import; inside any block it does not.
 */

/** Calls that reach the network or the filesystem of a live service. */
export const LIVE_CALL = /\bawait\s+(getPlan|listPlans|updatePlan|deletePlan|shopifyGraphQL|getAccessToken|fetch|getArticles|getBlogs|getProducts|getOrders)\s*\(/;

/**
 * Live calls sitting at BRACE DEPTH ZERO — the ones an import executes.
 *
 * Strings and line comments are blanked first, or a brace inside either skews
 * the depth for the rest of the file and the answer silently becomes noise.
 */
export function topLevelLiveCalls(src) {
  const hits = [];
  let depth = 0;
  let n = 0;
  for (const raw of String(src).split('\n')) {
    n += 1;
    const line = raw.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    if (depth === 0 && LIVE_CALL.test(line)) hits.push({ line: n, text: raw.trim().slice(0, 100) });
    depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    if (depth < 0) depth = 0;
  }
  return hits;
}

export const isGuarded = (src) => /isDirectRun\(import\.meta\.url\)/.test(String(src));

/**
 * `files` is `{ path: source }` for every module that could import a script.
 * Returns the script paths each one imports — a real `from '...'` specifier,
 * never a mention in a comment, which is what made the first count wrong.
 */
export function importedScripts(files) {
  const out = new Map();
  for (const [path, src] of Object.entries(files)) {
    for (const m of String(src).matchAll(/from\s+['"][^'"]*?(scripts\/[\w.-]+\.m?js)['"]/g)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(path);
    }
  }
  return out;
}

/** The conjunction. `scriptSources` is `{ 'scripts/x.mjs': source }`. */
export function unsafeImports(importMap, scriptSources) {
  const bad = [];
  for (const [script, importers] of importMap) {
    const src = scriptSources[script];
    if (src == null) continue;              // named but not present — not our finding
    if (isGuarded(src)) continue;
    const hits = topLevelLiveCalls(src);
    if (hits.length) bad.push({ script, importers, hits });
  }
  return bad;
}
