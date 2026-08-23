// tests/agents/llms-txt-generator-import-safety.test.js
//
// agents/llms-txt-generator/index.js used to call main() unconditionally at
// module scope — no `process.argv[1]` guard — so merely importing it made
// live Shopify calls (getBlogs/getArticles/getProducts/...), a live GSC
// call, a paid DataForSEO call, and — unless --dry-run happened to be on the
// argv it inherited — a write to the LIVE theme's public /llms.txt. That
// made the selection/rendering logic inside main() untestable without
// accepting real network, billing, and publish risk on every test run. This
// file pins the fix: importing the module must be inert. Modeled on
// tests/agents/seo-opportunity-analyzer-import-safety.test.js.
//
// If the guard regresses, this test is the tripwire — a real run does not
// resolve in well under the timeout below (network I/O to Shopify/GSC/
// DataForSEO), and on failure the agent's own catch handler calls
// process.exit(1), which would kill the whole `node --test` process rather
// than just fail this assertion.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(ROOT, 'data', 'reports', 'llms-txt');
const LOCAL_COPY = join(OUTPUT_DIR, 'llms.txt.liquid');

test('importing the module does not run the agent', async () => {
  const before = existsSync(LOCAL_COPY) ? statSync(LOCAL_COPY).mtimeMs : null;

  const start = Date.now();
  const mod = await import('../../agents/llms-txt-generator/index.js');
  const elapsed = Date.now() - start;

  // Module evaluation (function/const declarations, the config/site.json
  // read) is synchronous local work — it should complete in single-digit
  // milliseconds. main() would await a live Shopify fetch first, which
  // cannot return in well under a second even on a fast network, so a
  // generous ceiling still catches a regression without being flaky on a
  // slow CI box.
  assert.ok(elapsed < 2000, `import took ${elapsed}ms — main() may have run (a live Shopify call was attempted)`);

  // The module has no named exports of its own (the selection/rendering
  // logic now lives in ./selection.js) — importing it for its side effects
  // is exactly the case this guard must make inert.
  assert.equal(typeof mod, 'object');

  const after = existsSync(LOCAL_COPY) ? statSync(LOCAL_COPY).mtimeMs : null;
  assert.equal(after, before, 'importing must not write data/reports/llms-txt/llms.txt.liquid');
});
