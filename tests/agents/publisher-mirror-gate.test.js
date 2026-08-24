// tests/agents/publisher-mirror-gate.test.js
//
// A SOURCE SCAN, for the reason CLAUDE.md gives for every other one in this
// tree: importing `agents/*/index.js` runs the agent. `agents/publisher` also
// calls `process.exit(1)` at module scope on a missing argument and imports
// `lib/shopify.js`, which throws at import time without OAuth credentials — so
// there is no way to exercise `main()` from a test at all.
//
// What is pinned here is the WIRING, not the logic. The logic lives in
// `lib/content-mirror.js` and is unit-tested directly in
// `tests/lib/content-mirror.test.js`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(ROOT, 'agents', 'publisher', 'index.js'), 'utf8');

test('publisher imports the shared gate rather than re-deriving a threshold', () => {
  assert.match(src, /import \{ assessRepublish \} from '\.\.\/\.\.\/lib\/content-mirror\.js'/);
  // A second copy of the threshold is a second copy that drifts — the same rule
  // that makes lib/demand-questions.js import AWARENESS_LEVELS.
  assert.ok(!/0\.25|DIFFERENT_ARTICLE_MAX\s*=/.test(src), 'publisher must not spell its own threshold');
});

test('the gate reads the live body before the update, and only on the update path', () => {
  const updateAt = src.indexOf('await updateArticle(blogId, meta.shopify_article_id, articleFields)');
  const gateAt = src.indexOf('assessRepublish({');
  const readAt = src.indexOf('await getArticle(blogId, meta.shopify_article_id)');
  assert.ok(readAt > 0 && gateAt > 0 && updateAt > 0, 'all three call sites must exist');
  assert.ok(readAt < gateAt, 'the live body must be read before it is assessed');
  assert.ok(gateAt < updateAt, 'the assessment must happen before the write');
  // createArticle has nothing to overwrite and must not pay for a live read.
  const createAt = src.indexOf('await createArticle(');
  assert.ok(updateAt < createAt, 'fixture assumption: the update branch precedes the create branch');
});

test('a refused republish exits non-zero and never reaches updateArticle', () => {
  const block = src.slice(src.indexOf('if (!verdict.allow)'), src.indexOf('process.stdout.write(`  Updating existing article'));
  assert.match(block, /process\.exit\(1\)/);
  assert.ok(!/updateArticle/.test(block), 'the refusal branch must not write to Shopify');
});

test('--force does NOT disarm the mirror gate; --allow-divergent-mirror is its own flag', () => {
  assert.match(src, /const allowDivergentMirror = args\.includes\('--allow-divergent-mirror'\)/);
  const call = src.slice(src.indexOf('assessRepublish({'), src.indexOf('if (!verdict.allow)'));
  assert.match(call, /allowDivergentMirror,/);
  // `force` is passed through for the record, but lib/content-mirror.js ignores
  // it on purpose: scheduler.js:121 republishes with --force on every post
  // already on Shopify, which is the exact unattended path that fires the
  // hazard. Honouring --force here would leave that path ungated.
  assert.match(call, /force: forcePublish,/);
});

test('an unreadable live article is refused, not shrugged past', () => {
  const block = src.slice(src.indexOf('let liveReadable = true;'), src.indexOf('const verdict ='));
  assert.match(block, /liveReadable = false/);
  assert.ok(!/liveReadable = true;\s*\/\/ fall/.test(block));
});

test('the scheduler still passes --force and is therefore still covered by the gate', () => {
  // If someone ever adds --allow-divergent-mirror to this line, the unattended
  // daily republish is ungated again and this test is the thing that says so.
  const scheduler = readFileSync(join(ROOT, 'scheduler.js'), 'utf8');
  const line = scheduler.split('\n').find((l) => l.includes('agents/publisher/index.js') && l.includes('--force'));
  assert.ok(line, 'fixture assumption: scheduler.js republishes via publisher --force');
  assert.ok(!line.includes('--allow-divergent-mirror'), 'the unattended republish must never carry the override');
});
