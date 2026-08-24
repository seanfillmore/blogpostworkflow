import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indexLinkResults, isLiveReachable, partitionInternalLinkIssues,
} from '../../lib/internal-link-validation.js';

const DEAD = 'https://www.realskincare.com/collections/natural-bar-soap';   // 301 -> a live product
const GONE = 'https://www.realskincare.com/collections/never-existed';      // 404

const cand = (href) => ({ type: 'internal_not_in_sitemap', link: { href, text: 'Shop Now' } });

test('indexLinkResults keys on the nested link.href', () => {
  const m = indexLinkResults([{ link: { href: DEAD }, check: {}, ok: true }]);
  assert.equal(m.size, 1);
  assert.ok(m.has(DEAD));
});

test('indexLinkResults also accepts a flat href', () => {
  assert.ok(indexLinkResults([{ href: DEAD, ok: true }]).has(DEAD));
});

test('indexLinkResults tolerates junk', () => {
  assert.equal(indexLinkResults(null).size, 0);
  assert.equal(indexLinkResults([null, {}, { link: {} }]).size, 0);
});

// ── isLiveReachable ───────────────────────────────────────────────────────────

test('a 301 that lands on 200 is reachable (the whole point)', () => {
  assert.equal(isLiveReachable({ ok: true, status: 200 }), true);
});

test('a 404 is not reachable', () => {
  assert.equal(isLiveReachable({ ok: false, status: 404 }), false);
});

test('an UNPUBLISHED-post allowance is not evidence the URL resolves today', () => {
  // checkLink returns ok:true for a scheduled post so it does not block the
  // pipeline — but that is a scheduling judgement, not a live 200.
  assert.equal(isLiveReachable({ ok: true, unpublished: true, status: 404 }), false);
});

test('a missing result is not reachable', () => {
  assert.equal(isLiveReachable(undefined), false);
  assert.equal(isLiveReachable(null), false);
});

// ── partition ─────────────────────────────────────────────────────────────────

test('a redirect-resolving link becomes ADVISORY, not a blocking issue', () => {
  const byHref = indexLinkResults([{ link: { href: DEAD }, ok: true, status: 200 }]);
  const { issues, advisories } = partitionInternalLinkIssues({ candidates: [cand(DEAD)], byHref });
  assert.equal(issues.length, 0);
  assert.equal(advisories.length, 1);
  assert.match(advisories[0].reason, /redirect/);
});

test('a genuinely dead link still BLOCKS', () => {
  const byHref = indexLinkResults([{ link: { href: GONE }, ok: false, status: 404 }]);
  const { issues, advisories } = partitionInternalLinkIssues({ candidates: [cand(GONE)], byHref });
  assert.equal(issues.length, 1);
  assert.equal(advisories.length, 0);
});

test('a link with NO live result still blocks — absence of evidence is not evidence', () => {
  const { issues } = partitionInternalLinkIssues({ candidates: [cand(GONE)], byHref: new Map() });
  assert.equal(issues.length, 1);
});

test('mixed set splits correctly and preserves the original entries', () => {
  const byHref = indexLinkResults([
    { link: { href: DEAD }, ok: true, status: 200 },
    { link: { href: GONE }, ok: false, status: 404 },
  ]);
  const { issues, advisories } = partitionInternalLinkIssues({
    candidates: [cand(DEAD), cand(GONE)], byHref,
  });
  assert.equal(advisories[0].link.href, DEAD);
  assert.equal(issues[0].link.href, GONE);
  assert.equal(issues[0].type, 'internal_not_in_sitemap');   // untouched
});

test('empty input is clean', () => {
  const r = partitionInternalLinkIssues({ candidates: [], byHref: new Map() });
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.advisories, []);
});
