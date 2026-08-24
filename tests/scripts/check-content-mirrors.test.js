// tests/scripts/check-content-mirrors.test.js
//
// The detector talks to live Shopify at module scope (top-level `await
// getBlogs()`), so it cannot be imported or executed in a test without network
// credentials and a real read. What IS testable without either is the argument
// contract and the guarantees the header promises — pinned here by source scan,
// the same shape as tests/scripts/post-meta-drift-gate.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-content-mirrors.mjs');
const src = readFileSync(SCRIPT, 'utf8');

test('--apply without --snapshot-live is refused with exit 64, before any network call', () => {
  // The refusal has to happen BEFORE `await getBlogs()`, or a mistyped --apply
  // pays for a full corpus read and then errors.
  const refuseAt = src.indexOf('process.exit(64)');
  const networkAt = src.indexOf('await getBlogs()');
  assert.ok(refuseAt > 0 && networkAt > 0);
  assert.ok(refuseAt < networkAt, 'the argument refusal must precede the first Shopify call');

  let status = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, '--apply'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    status = err.status;
    stderr = String(err.stderr);
  }
  assert.equal(status, 64);
  assert.match(stderr, /NO resync mode/);
});

test('the script never writes a content.html, in either direction', () => {
  // The whole decision of this change, expressed as a test. A resync mode added
  // later has to delete this assertion, which is the point. `content.html` is
  // read (that is the comparison) — what may never happen is it appearing as
  // the destination of a write, or any local post file being deleted.
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
  const mutations = code.match(/(?:writeFileSync|copyFileSync|renameSync|appendFileSync|rmSync|unlinkSync|truncateSync)\([^;]*/g) || [];
  assert.ok(mutations.length > 0, 'fixture assumption: the snapshot path does write something');
  for (const m of mutations) {
    assert.ok(!/content\.html|contentPath|POSTS_DIR/.test(m), `a filesystem mutation must never target a post file, got: ${m}`);
  }
  for (const w of mutations.filter((m) => m.startsWith('writeFileSync'))) {
    assert.match(w, /tmp/, `every write must go to a temp path first, got: ${w}`);
  }
});

test('snapshots land in data/reports, never inside a post directory', () => {
  // Everything under data/posts/<slug>/ is a pipeline input. A live body dropped
  // in there is the accidental resync this tool exists to prevent.
  assert.match(src, /const REPORT_DIR = join\(ROOT, 'data', 'reports', 'content-mirror'\)/);
  const snapshotBlock = src.slice(src.indexOf('if (snapshot)'), src.indexOf('// ── output'));
  assert.ok(!/POSTS_DIR/.test(snapshotBlock), 'the snapshot path must not be built from POSTS_DIR');
});

test('the snapshot write is atomic and backs up what it replaces', () => {
  const block = src.slice(src.indexOf('if (snapshot)'), src.indexOf('// ── output'));
  assert.match(block, /copyFileSync\(dest, `\$\{dest\}\.prev`\)/, 'an existing snapshot must be preserved');
  assert.match(block, /renameSync\(tmp, dest\)/, 'the write must be temp-then-rename');
});

test('Shopify is touched read-only — the script imports no mutating client function', () => {
  const imports = src.slice(src.indexOf("from '../lib/shopify.js'") - 200, src.indexOf("from '../lib/shopify.js'"));
  for (const mutator of ['updateArticle', 'createArticle', 'deleteArticle']) {
    assert.ok(!imports.includes(mutator), `${mutator} must not be imported`);
    assert.ok(!src.includes(`${mutator}(`), `${mutator} must not be called`);
  }
});

test('the exit-code vocabulary matches the drift gate it was modelled on', () => {
  assert.match(src, /process\.exitCode = unreadable\.length \? 3/);
  assert.match(src, /differentArticle\.length \? 2/);
  assert.match(src, /warnable\.length \? 1/);
});
