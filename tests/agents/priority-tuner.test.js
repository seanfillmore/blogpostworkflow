import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

// The agent takes a different exit path depending on whether the cron-written
// `data/reports/seo-impact` feed is fresh, and that feed is gitignored — so it is
// present on the server and absent in a fresh checkout. These assertions must
// hold on BOTH paths, which is the point: a dry run has one contract regardless
// of which branch it takes. The stale path used to write a report, and this test
// only failed on the earlier assertion, which hid it.
test('priority-tuner --dry-run runs and writes neither config nor report', () => {
  const cfgBefore = readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8');
  const reportDir = join(ROOT, 'data', 'reports', 'priority-tuner');
  const reportP = join(reportDir, 'latest.json');
  const dirBefore = existsSync(reportDir);
  const reportBefore = existsSync(reportP) ? readFileSync(reportP, 'utf8') : null;

  const out = execFileSync('node', ['agents/priority-tuner/index.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Priority Tuner \(dry-run\)/);
  assert.match(out, /no changes written/, 'every dry-run exit path must say so, including the stale-feed skip');

  assert.equal(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8'), cfgBefore); // config untouched
  const reportAfter = existsSync(reportP) ? readFileSync(reportP, 'utf8') : null;
  assert.equal(reportAfter, reportBefore); // dry-run writes no report
  assert.equal(existsSync(reportDir), dirBefore, 'dry-run must not even create the report directory');
});
