import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

test('priority-tuner --dry-run runs and writes neither config nor report', () => {
  const cfgBefore = readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8');
  const reportP = join(ROOT, 'data', 'reports', 'priority-tuner', 'latest.json');
  const reportBefore = existsSync(reportP) ? readFileSync(reportP, 'utf8') : null;

  const out = execFileSync('node', ['agents/priority-tuner/index.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Priority Tuner \(dry-run\)/);
  assert.match(out, /no changes written/);

  assert.equal(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8'), cfgBefore); // config untouched
  const reportAfter = existsSync(reportP) ? readFileSync(reportP, 'utf8') : null;
  assert.equal(reportAfter, reportBefore); // dry-run writes no report
});
