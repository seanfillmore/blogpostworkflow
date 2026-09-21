import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every trigger performance-engine queues runs content-refresher, a BODY
// rewrite, which a locked winner refuses. A locked post that reaches a picker's
// cap can never succeed and comes back tomorrow for the same slot — on
// 2026-09-21 that held 3 of 6 daily slots. Source scan, because importing the
// agent runs it.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../agents/performance-engine/index.js'), 'utf8');
const body = (name) => src.slice(src.indexOf(`function ${name}(`), src.indexOf('\n}\n', src.indexOf(`function ${name}(`)));

for (const picker of ['pickQuickWins', 'pickMetaRewrites', 'pickLegacyFlops']) {
  test(`${picker} drops locked winners before its cap`, () => {
    const fn = body(picker);
    assert.match(fn, /unlocked\(/);
    assert.ok(fn.indexOf('unlocked(') < fn.indexOf('.slice(0,') || !fn.includes('.slice(0,'), 'lock filter must precede the cap');
  });
}

test('pickFlops goes through the shared refreshable filter, which checks the lock', () => {
  assert.match(body('pickFlops'), /refreshableFlops\([\s\S]*mayRewriteBody/);
});

test('locked skips reach the digest', () => {
  assert.match(src, /lockedSkips\.length[\s\S]*flopSkipLines\.push/);
});
