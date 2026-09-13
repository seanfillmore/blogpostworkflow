// tests/scripts/giveaway-pre-close-reconcile-cron.test.js
//
// The draw snapshot counts a confirmation only if its gv_confirmed_at stamp is
// at or before the close, and that stamp is written by the reconciler, which
// stamps the time IT RUNS. The daily reconcile is 08:30 UTC, and the snapshot is
// 08:05 UTC on Sep 15 — so without an extra run every confirmation clicked after
// 01:30 PT on Sep 14 enters the draw as unconfirmed (1 entry instead of 3+, and
// its referral credit zeroed). Running the reconciler after the close does not
// help: it would stamp those confirmations with a post-close time.
//
// So one extra run has to land shortly BEFORE the close, leaving enough margin
// for the run itself (~1 minute measured on 2026-09-12) to finish inside the
// Entry Period.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cron = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');
const config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));

const line = cron.split('\n').find((l) => /^GIVEAWAY_PRE_CLOSE_RECONCILE="/.test(l));

function firesAt(cronLine, year = 2026) {
  const [minute, hour, dom, month] = cronLine.replace(/^[A-Z_]+="/, '').trim().split(/\s+/);
  return Date.parse(`${year}-${month.padStart(2, '0')}-${dom.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:00Z`);
}

test('the pre-close reconcile is defined and installed', () => {
  assert.ok(line, 'setup-cron.sh must define GIVEAWAY_PRE_CLOSE_RECONCILE');
  assert.ok(cron.includes('\n$GIVEAWAY_PRE_CLOSE_RECONCILE\n'), 'it must be part of the installed crontab');
  assert.match(line, /reconcile-referrals\.mjs --apply/);
});

test('it fires before the close, with at least four minutes for the run to finish', () => {
  const closes = Date.parse(config.entryClosesAt);
  const fires = firesAt(line);
  assert.ok(fires < closes, 'must stamp confirmations inside the Entry Period');
  assert.ok(closes - fires >= 4 * 60 * 1000, 'the run needs margin to finish before the close');
  assert.ok(closes - fires <= 15 * 60 * 1000, 'the later it runs, the fewer confirmations it misses');
});

test('it fires before the close job takes the snapshot', () => {
  const close = cron.split('\n').find((l) => /^GIVEAWAY_CLOSE_ENTRY_PERIOD="/.test(l));
  assert.ok(firesAt(line) < firesAt(close));
});

test('the line carries no TZ prefix', () => {
  assert.ok(!/TZ=/.test(line), 'a TZ= prefix schedules nothing on this host');
});
