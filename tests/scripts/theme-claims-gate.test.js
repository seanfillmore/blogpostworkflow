// The gate must never grow a write mode. update-theme-asset.mjs can CREATE an asset
// now, so a --apply branch here would be a nightly unattended rewrite of live
// customer-facing copy — on a surface where the correct fix is a judgement about
// what the product actually does, not something a cron can decide.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'scripts', 'check-theme-claims-drift.mjs'), 'utf8');
const CRON = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');

test('the gate spawns no child process', () => {
  // A source scan, because importing the script runs it against live Shopify.
  assert.doesNotMatch(SRC, /child_process|execFile|spawn\(|execSync/);
});

test('the gate contains no theme write', () => {
  assert.doesNotMatch(SRC, /updateThemeAsset|method:\s*['"]PUT['"]|assets\.json['"`],\s*\{/);
  assert.doesNotMatch(SRC, /writeFileSync/);
});

test('write flags are refused with exit 64', () => {
  assert.match(SRC, /--apply/);
  assert.match(SRC, /exit\(64\)/);
});

test('it notifies deferred, never immediate, and never pages anyone', () => {
  assert.doesNotMatch(SRC, /immediate:\s*true/);
  assert.match(SRC, /notify\(/);
});

test('the cron line carries no TZ= prefix — one schedules nothing on this host', () => {
  const line = CRON.split('\n').find((l) => l.startsWith('DAILY_THEME_CLAIMS_GATE='));
  assert.ok(line, 'DAILY_THEME_CLAIMS_GATE is not defined in setup-cron.sh');
  assert.doesNotMatch(line, /TZ=/);
  assert.match(line, /^DAILY_THEME_CLAIMS_GATE="45 12 \* \* \*/, 'must run at 12:45 UTC');
});

test('the gate is actually installed into NEW_CRONTAB, not just defined', () => {
  // A variable nobody references is a job that never runs — the failure the
  // setup-cron mirror check exists to catch.
  assert.match(CRON, /^\$DAILY_THEME_CLAIMS_GATE$/m);
});

test('12:45 collides with no other job in setup-cron.sh', () => {
  const mins = [...CRON.matchAll(/^[A-Z_]+="(\d+) 12 \* \* \*/gm)].map((m) => m[1]);
  const dupes = mins.filter((m, i) => mins.indexOf(m) !== i);
  assert.deepEqual(dupes, [], `two jobs share a minute in hour 12: ${dupes.join(', ')}`);
});
