// A redirect this agent created had never fired. Shopify serves a URL redirect
// only when the path does not already resolve, and the loser stayed PUBLISHED —
// so the 301 sat inert, both pages kept competing, and the run reported
// "1 redirects created" while nothing had changed. Verified on production
// 2026-09-09: /blogs/news/best-toothpaste-without-sls-2025 returned 200,
// cache-busted, with its redirect present in the table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decideHeldMergeRedirect, decideLoserDisposition,
} from '../../agents/cannibalization-resolver/redirect-decision.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents/cannibalization-resolver/index.js'), 'utf8');

test('a redirect we create is always made to fire', () => {
  const d = decideLoserDisposition({ createRedirect: true, reason: 'not_held' });
  assert.equal(d.unpublish, true);
  assert.equal(d.reason, 'redirect_created_must_fire');
});

test('no redirect means the page is left exactly as it is', () => {
  for (const reason of ['held_loser_has_traffic', 'held_no_traffic_data']) {
    const d = decideLoserDisposition({ createRedirect: false, reason });
    assert.equal(d.unpublish, false, `${reason} must never unpublish`);
    assert.match(d.reason, new RegExp(reason), 'the redirect verdict is carried through');
  }
  assert.equal(decideLoserDisposition({}).unpublish, false, 'absent input never unpublishes');
});

test('disposition FOLLOWS the redirect verdict — there is no second traffic test', () => {
  // Two independent traffic rules would drift, and the second is the one nobody
  // re-derives. Every case decideHeldMergeRedirect can produce is walked here.
  const cases = [
    { consolidateHeld: false, loserClicks: 999 },   // published merge, trafficked loser
    { consolidateHeld: false, loserClicks: 0 },
    { consolidateHeld: true, loserClicks: 0 },      // held, nobody there
    { consolidateHeld: true, loserClicks: 140 },    // held, real traffic
    { consolidateHeld: true, loserClicks: null },   // held, unknown
  ];
  for (const c of cases) {
    const r = decideHeldMergeRedirect(c);
    const d = decideLoserDisposition({ createRedirect: r.createRedirect, reason: r.reason });
    assert.equal(d.unpublish, r.createRedirect,
      `disposition must track the redirect verdict for ${JSON.stringify(c)}`);
  }
});

test('a HELD merge with a trafficked loser neither redirects nor unpublishes', () => {
  // The case that protects a page whose content the live winner does not yet
  // show. Both halves must decline together or the loser's content vanishes.
  const r = decideHeldMergeRedirect({ consolidateHeld: true, loserClicks: 140 });
  assert.equal(r.createRedirect, false);
  assert.equal(decideLoserDisposition({ createRedirect: r.createRedirect, reason: r.reason }).unpublish, false);
});

test('the agent UNPUBLISHES and never deletes', () => {
  assert.match(SRC, /updateArticle\([^)]*\{ published: false \}\)/,
    'unpublish is a published:false update');
  assert.doesNotMatch(SRC, /deleteArticle/,
    'deletion is a one-way door and is not required for a 301');
});

test('the unpublish is wired to the disposition, immediately after the redirect', () => {
  const redirectAt = SRC.indexOf('await createRedirect(loserPath, winnerPath)');
  const dispositionAt = SRC.indexOf('decideLoserDisposition({ createRedirect: allowRedirect');
  assert.ok(redirectAt > 0 && dispositionAt > redirectAt,
    'disposition is decided after the redirect exists, from the same verdict');
});

test('a failed unpublish is reported LOUDLY, not swallowed', () => {
  // The redirect exists and is inert at that point. A run that reads as a
  // completed consolidation while both pages still compete is the exact defect
  // this change fixes, wearing a different hat.
  assert.match(SRC, /STILL LIVE/);
  assert.match(SRC, /status: 'unpublish_error'/);
});
