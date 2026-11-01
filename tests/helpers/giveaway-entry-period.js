// Skip a suite that can only pass while a giveaway's Entry Period is OPEN.
//
// WHY THIS EXISTS (2026-09-21)
//
// Eighteen tests across three files failed every run once the soap giveaway
// closed on 2026-09-14, and all eighteen had ONE cause: the entry period is
// over, so the code under test correctly reports that.
//
//   - tests/dashboard/giveaway-rate-limit-routes.test.js asserts a malformed
//     body reaches validation (400). `routes/giveaway.js` returns 410 Gone
//     BEFORE validation once closed, so every budget assertion reads 410.
//   - tests/theme/giveaway-entered-confirmed.test.js and
//     giveaway-survey-shift.test.js drive the real theme in a real browser and
//     assert the entrant-facing copy. Closed, the page renders "Entries are
//     closed — thank you for entering." instead.
//
// RETIRED, NOT DELETED, and the distinction is the point. The routes are still
// live and public — `/api/giveaway/enter` still takes requests, and its rate
// limits are the abuse protection that the 2,948-entry bot wave made real. The
// theme sections still ship. None of that is dead code; it is code in its
// closed state. Deleting the tests would throw away coverage of a live public
// endpoint to silence a calendar.
//
// So the suites skip themselves while the period is closed, naming why, and
// REVIVE AUTOMATICALLY when `config/giveaway.json`'s entryOpensAt/entryClosesAt
// next bracket the current date. A future giveaway gets its tests back without
// anyone remembering they existed — which is the failure mode that would
// otherwise follow a delete.
//
// A permanently-failing test is worse than no test: it trains everyone to read
// a non-zero failure count as normal, which is how a real regression hides.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** `{ open, reason }` — `open` false when the Entry Period is not current. */
export function giveawayEntryPeriod(now = new Date()) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(ROOT, 'config', 'giveaway.json'), 'utf8'));
  } catch (err) {
    // Unreadable config is NOT "closed": that would silently disable the suites
    // for a reason that has nothing to do with the giveaway. Run them and let
    // them fail honestly — the same "unreadable is not absent" rule this repo
    // applies to a post lock and to a title_tag.
    return { open: true, reason: `giveaway config unreadable (${err.message}) — running anyway` };
  }
  const opens = Date.parse(config.entryOpensAt);
  const closes = Date.parse(config.entryClosesAt);
  if (!Number.isFinite(opens) || !Number.isFinite(closes)) {
    return { open: true, reason: 'giveaway entry dates unparseable — running anyway' };
  }
  const t = now.getTime();
  if (t < opens) return { open: false, reason: `giveaway Entry Period has not opened (opens ${config.entryOpensAt})` };
  if (t > closes) return { open: false, reason: `giveaway Entry Period closed ${config.entryClosesAt} — these assert OPEN-period behaviour` };
  return { open: true, reason: '' };
}

/** The skip reason, or '' when the suite should run. */
export function entriesClosedSkip(now = new Date()) {
  const { open, reason } = giveawayEntryPeriod(now);
  return open ? '' : reason;
}

/**
 * Drop-in replacements for node:test's `test` / `before` / `after` that become
 * no-ops while the Entry Period is closed.
 *
 * The HOOKS matter as much as the tests: two of these suites launch a real
 * puppeteer browser in `before`, and node:test runs a file's hooks even when
 * every test in it is skipped. Left alone they would spend a browser launch to
 * report nothing.
 */
export function entryPeriodGate({ test, before, after } = {}, now = new Date()) {
  const skip = entriesClosedSkip(now);
  if (!skip) return { test, before, after, skip: '' };
  return {
    skip,
    test: (name) => test(name, { skip }, () => {}),
    before: () => {},
    after: () => {},
  };
}
