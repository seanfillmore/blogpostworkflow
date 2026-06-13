import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

test('pipeline-prioritizer --dry-run runs and writes nothing new', () => {
  const p = join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json');
  const before = existsSync(p) ? readFileSync(p, 'utf8') : null;

  const out = execFileSync('node', ['agents/pipeline-prioritizer/index.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Pipeline Prioritizer \(dry-run\)/);
  assert.match(out, /no changes written/);

  const after = existsSync(p) ? readFileSync(p, 'utf8') : null;
  assert.equal(after, before); // dry-run must not change the report
});
