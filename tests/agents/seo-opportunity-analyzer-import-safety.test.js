// tests/agents/seo-opportunity-analyzer-import-safety.test.js
//
// agents/seo-opportunity-analyzer/index.js used to call main() unconditionally at
// module scope — no `process.argv[1]` guard — so merely importing it made a live
// GSC call (lib/gsc.js's getAllQueryPageRows) and, on success, a paid DataForSEO
// search-volume call. That made the shaping logic inside main() untestable without
// either stubbing two live APIs or accepting the network/billing risk on every test
// run. This file pins the fix: importing the module must be inert.
//
// If the guard regresses, this test is the tripwire — a real run does not resolve
// in well under the timeout below (network I/O), and on failure the agent's own
// catch handler calls process.exit(1), which would kill the whole `node --test`
// process rather than just fail this assertion.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'seo-opportunities');
const LATEST_JSON = join(REPORTS_DIR, 'latest.json');

test('importing the module does not run the agent', async () => {
  const before = existsSync(LATEST_JSON) ? statSync(LATEST_JSON).mtimeMs : null;
  const before404 = existsSync(join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10)}.json`));

  const start = Date.now();
  const mod = await import('../../agents/seo-opportunity-analyzer/index.js');
  const elapsed = Date.now() - start;

  // Module evaluation (function/const declarations only) is synchronous local
  // work — it should complete in single-digit milliseconds. main() would await a
  // live GSC fetch first, which cannot return in well under a second even on a
  // fast network, so a generous ceiling still catches a regression without being
  // flaky on a slow CI box.
  assert.ok(elapsed < 2000, `import took ${elapsed}ms — main() may have run (a live GSC call was attempted)`);

  // The module has no named exports of its own (the shaping logic now lives in
  // ./queue-item.js) — importing it for its side effects is exactly the case this
  // guard must make inert.
  assert.equal(typeof mod, 'object');

  const after = existsSync(LATEST_JSON) ? statSync(LATEST_JSON).mtimeMs : null;
  assert.equal(after, before, 'importing must not write data/reports/seo-opportunities/latest.json');

  const after404 = existsSync(join(REPORTS_DIR, `${new Date().toISOString().slice(0, 10)}.json`));
  assert.equal(after404, before404, 'importing must not write today\'s dated report either');
});
