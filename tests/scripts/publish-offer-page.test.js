// tests/scripts/publish-offer-page.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishDecision, PAGE_HANDLE } from '../../scripts/giveaway/publish-offer-page.mjs';
import { OPENS_AT, CLOSES_AT } from '../../lib/giveaway/consolation-offer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('REFUSES to publish before the draw', () => {
  // The page opens "We drew the winner. It wasn't you." Published during an open
  // Entry Period that sentence is false, visible to people still entering, and
  // indexable. This is the whole reason the window lives in code.
  const d = publishDecision('2026-08-24T12:00:00Z');
  assert.equal(d.ok, false);
  assert.match(d.reason, /still entering/);
});

test('publishes inside the offer window', () => {
  assert.equal(publishDecision(OPENS_AT).ok, true);
  assert.equal(publishDecision('2026-09-20T12:00:00Z').ok, true);
  assert.equal(publishDecision(CLOSES_AT).ok, true);
});

test('REFUSES after the offer closes, which is what makes the annual cron re-fire a no-op', () => {
  // `30 19 16 9 *` has no year field, so it fires again in 2027. Without this
  // the offer page would quietly come back to life a year later.
  const d = publishDecision('2027-09-16T20:00:00Z');
  assert.equal(d.ok, false);
  assert.match(d.reason, /closed/);
});

test('--force overrides only the EARLY refusal, never the closed one', () => {
  assert.equal(publishDecision('2026-08-24T12:00:00Z', { force: true }).ok, true, 'force allows a rehearsal');
  assert.equal(publishDecision('2027-09-16T20:00:00Z', { force: true }).ok, false,
    'force must not resurrect a closed offer');
});

test('the boundary is inclusive at both ends', () => {
  assert.equal(publishDecision(Date.parse(OPENS_AT) - 1).ok, false);
  assert.equal(publishDecision(Date.parse(CLOSES_AT) + 1).ok, false);
});

test('the cron entry fires between the draw and the first send', () => {
  // The draw is OPENS_AT (2026-09-16 19:00 UTC); the first consolation send is
  // 22:00 UTC the same day. The page must be live in that gap — publishing after
  // the send means every email in it links to a 404.
  const cron = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');
  const line = cron.split('\n').find((l) => l.includes('publish-offer-page.mjs'));
  assert.ok(line, 'setup-cron.sh must carry the publish job');

  // Strip the shell variable prefix: the line is NAME="<cron fields> cd ...".
  const fields = line.replace(/^[A-Z_]+="/, '').trim().split(/\s+/);
  const [minute, hour, dom, month] = fields;
  const fires = Date.parse(`2026-${String(month).padStart(2, '0')}-${String(dom).padStart(2, '0')}`
    + `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  assert.ok(fires >= Date.parse(OPENS_AT), 'must not fire before the draw');
  assert.ok(fires < Date.parse('2026-09-16T22:00:00Z'), 'must fire before the first consolation send');
});

test('the cron entry carries no TZ prefix', () => {
  // Cron on this host has no timezone variable at all; a TZ= prefix schedules
  // nothing and only misleads the next reader.
  const cron = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');
  const line = cron.split('\n').find((l) => l.includes('publish-offer-page.mjs'));
  assert.ok(!/TZ=/.test(line), 'a TZ= prefix is inert on this host');
});

test('the job passes --apply and never --force', () => {
  // --force exists for a hand-run rehearsal. On a timer it would defeat the
  // early-publish refusal, which is the only thing standing between a live
  // "we drew the winner" page and an open Entry Period.
  const cron = readFileSync(join(ROOT, 'scripts', 'setup-cron.sh'), 'utf8');
  const line = cron.split('\n').find((l) => l.includes('publish-offer-page.mjs'));
  assert.match(line, /--apply/);
  assert.ok(!line.includes('--force'), 'the scheduled job must never force');
});

test('the handle matches what the emails and the page template use', () => {
  assert.equal(PAGE_HANDLE, 'giveaway-offer');
  const section = readFileSync(join(ROOT, 'theme', 'sections', 'giveaway-offer.liquid'), 'utf8');
  assert.ok(section.length > 0, 'the section the page renders must exist');
});
