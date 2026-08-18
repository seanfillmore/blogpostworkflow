import { strict as assert } from 'node:assert';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadGiveaway, buildGiveawaySource, isGiveawayLive, calendarDate, rulesSections, stripHtml,
} from '../../lib/giveaway-claim-source.js';
import { buildSourceIndex, validateClaims } from '../../agents/ad-studio/claims.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The real, shipped pair of files. Everything below that talks about "the live giveaway"
// means these — not a fixture — because the whole point of this module is that the two
// authoritative documents agree with each other, and a fixture cannot prove that.
const LIVE = new Date('2026-08-20T12:00:00Z');

// ── the window ───────────────────────────────────────────────────────────────────────

test('isGiveawayLive is inclusive of both endpoints and false outside them', () => {
  const config = { entryOpensAt: '2026-08-18T00:00:00-06:00', entryClosesAt: '2026-09-14T23:59:59-06:00' };
  assert.equal(isGiveawayLive(config, new Date('2026-08-18T06:00:00Z')), true, 'the opening instant is in');
  assert.equal(isGiveawayLive(config, new Date('2026-09-15T05:59:59Z')), true, 'the closing instant is in');
  assert.equal(isGiveawayLive(config, new Date('2026-08-18T05:59:59Z')), false, 'one second early is out');
  assert.equal(isGiveawayLive(config, new Date('2026-09-15T06:00:00Z')), false, 'one second late is out');
});

// "There is no giveaway" and "the giveaway config is broken" are different facts. Reporting
// the first for the second is how a campaign runs a month of ads with no giveaway angle.
test('a malformed or inverted window throws rather than quietly answering false', () => {
  assert.throws(() => isGiveawayLive({ entryClosesAt: '2026-09-14T23:59:59-06:00' }, LIVE), /entryOpensAt/);
  assert.throws(() => isGiveawayLive({ entryOpensAt: '2026-08-18T00:00:00-06:00' }, LIVE), /entryClosesAt/);
  assert.throws(
    () => isGiveawayLive({ entryOpensAt: '2026-09-14T00:00:00-06:00', entryClosesAt: '2026-08-18T00:00:00-06:00' }, LIVE),
    /empty or inverted/,
  );
});

// Read the LITERAL date component, never through a Date. The offsets in the config are
// store-local, so converting would return the RUNNER's month — which on a UTC cron box turns
// an 11:59 PM close into the following day and starts rejecting a correct pair of files.
test('calendarDate reads the literal date, not the runner-local one', () => {
  assert.equal(calendarDate('2026-09-14T23:59:59-06:00'), 'September 14, 2026');
  assert.equal(calendarDate('2026-08-18T00:00:00-06:00'), 'August 18, 2026');
  assert.equal(calendarDate('2026-01-05T00:00:00-06:00'), 'January 5, 2026', 'no zero padding on the day');
  assert.throws(() => calendarDate('not a date'), /calendar date/);
});

// ── the two authorities, and what happens when they disagree ─────────────────────────

const RULES_SKELETON = `
<div class="gv-rules">
<h1>Official Rules — "Win 36 Free Bars" Giveaway</h1>
<h2>2. Entry Period</h2>
<p>The Promotion begins at 12:00 AM CT on August 18, 2026 and ends at 11:59 PM CT on September 14, 2026.</p>
<h2>3. Eligibility</h2>
<p>Open to legal residents of the fifty (50) United States who are eighteen (18) years of age or older.</p>
<h2>4. How to Enter — No Purchase Necessary</h2>
<p>No purchase necessary. To enter, submit your email address and first name.</p>
<h2>7. Prizes</h2>
<p>Thirty-six (36) bars of Pure Unscented Moisturizing Coconut Soap, shipped over three (3) years.</p>
</div>`;

const GOOD_CONFIG = { entryOpensAt: '2026-08-18T00:00:00-06:00', entryClosesAt: '2026-09-14T23:59:59-06:00' };

test('a config date the published rules do not carry STOPS the build — it never picks one', () => {
  // The dangerous version of this bug is subtle: fold the config's dates into the searchable
  // body and a writer can quote "September 21, 2026" as *sourced* evidence for a deadline
  // the published rules contradict — defeating the claim gate through its own front door.
  const drifted = { ...GOOD_CONFIG, entryClosesAt: '2026-09-21T23:59:59-06:00' };
  assert.throws(
    () => buildGiveawaySource({ config: drifted, rulesHtml: RULES_SKELETON }),
    (err) => {
      assert.match(err.message, /September 21, 2026/, 'names the config value');
      assert.match(err.message, /official-rules\.html/, 'names the file it disagrees with');
      assert.match(err.message, /Reconcile them by hand/, 'tells the operator to decide, rather than deciding');
      return true;
    },
  );
  // ...and the same for the OPEN date, which is the one nobody thinks to check.
  assert.throws(
    () => buildGiveawaySource({ config: { ...GOOD_CONFIG, entryOpensAt: '2026-08-15T00:00:00-06:00' }, rulesHtml: RULES_SKELETON }),
    /August 15, 2026/,
  );
});

test('a rules document this cannot read stops the build loudly, not silently', () => {
  const noPrize = RULES_SKELETON.replace('<h2>7. Prizes</h2>', '<h2>7. What You Get</h2>');
  assert.throws(() => buildGiveawaySource({ config: GOOD_CONFIG, rulesHtml: noPrize }), /exactly one "Prizes" section/);
});

test('rulesSections splits on h2 and carries each section prose', () => {
  const sections = rulesSections(RULES_SKELETON);
  assert.deepEqual(sections.map(s => s.heading), [
    '2. Entry Period', '3. Eligibility', '4. How to Enter — No Purchase Necessary', '7. Prizes',
  ]);
  assert.match(sections[3].prose, /^Thirty-six \(36\) bars/);
  assert.equal(stripHtml('<style>.a{}</style><p>hi &amp; bye</p>'), 'hi & bye');
});

// ── the real files ───────────────────────────────────────────────────────────────────

test('the SHIPPED config and rules agree, and produce a usable source', () => {
  const g = loadGiveaway({ root: REPO, now: LIVE });
  assert.ok(g, 'a giveaway must be live on 2026-08-20');
  assert.equal(g.closesOn, 'September 14, 2026');
  assert.equal(g.opensOn, 'August 18, 2026');
  assert.match(g.name, /36 Free Bars/);
  // The strong hook: the prize is a three-year run of shipments, not one free bar.
  assert.match(g.prizes, /Thirty-six \(36\) bars/);
  assert.match(g.prizes, /three \(3\) years/);
  assert.match(g.eligibility, /eighteen \(18\) years of age/);
  assert.match(g.howToEnter, /No purchase necessary/i);
  assert.match(g.entryPeriod, /September 14, 2026/);
});

test('outside the Entry Period there is no giveaway at all', () => {
  assert.equal(loadGiveaway({ root: REPO, now: new Date('2026-08-17T12:00:00Z') }), null, 'the day before entries open');
  assert.equal(loadGiveaway({ root: REPO, now: new Date('2026-09-20T12:00:00Z') }), null, 'after entries close');
});

test('a repo with no giveaway config is simply a repo with no giveaway', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-'));
  try {
    assert.equal(loadGiveaway({ root: dir, now: LIVE }), null);
    // But a LIVE giveaway whose published rules are missing is an error, not a null: a
    // running promotion must never quietly produce ads that cite rules nobody can read.
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(join(dir, 'config', 'giveaway.json'), JSON.stringify(GOOD_CONFIG));
    assert.throws(() => loadGiveaway({ root: dir, now: LIVE }), /ENOENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the claim gate, which is the whole point ─────────────────────────────────────────

test('a giveaway claim quoted from the rules passes; an invented one is still rejected', () => {
  const g = loadGiveaway({ root: REPO, now: LIVE });
  const index = buildSourceIndex({ pdpBody: 'Made with saponified coconut oil.', giveaway: g.text });
  assert.ok(index.giveaway, 'the giveaway source is in the index');

  const good = validateClaims([
    { zone: 'headline', text: 'WIN 36 BARS OF SOAP', factual: true, sourceId: 'giveaway', evidence: 'Thirty-six (36) bars' },
    { zone: 'subhead', text: 'SHIPPED OVER 3 YEARS', factual: true, sourceId: 'giveaway', evidence: 'three (3) years' },
    { zone: 'bottomBar', text: 'ENTRIES CLOSE SEPTEMBER 14', factual: true, sourceId: 'giveaway', evidence: 'September 14, 2026' },
    { zone: 'bottomBar', text: 'NO PURCHASE NECESSARY', factual: true, sourceId: 'giveaway', evidence: 'NO PURCHASE NECESSARY' },
    { zone: 'offerBadge', text: 'ENTER TO WIN', factual: false },
  ], index);
  assert.equal(good.ok, true, JSON.stringify(good.violations));

  // NOTHING WAS RELAXED. A prize and a date the published rules do not carry are rejected
  // exactly as they were before this source existed.
  const bad = validateClaims([
    { zone: 'headline', text: 'WIN A YEAR OF FREE SOAP', factual: true, sourceId: 'giveaway', evidence: 'fifty (50) bars' },
    { zone: 'bottomBar', text: 'ENTRIES CLOSE OCTOBER 1', factual: true, sourceId: 'giveaway', evidence: 'October 1, 2026' },
    { zone: 'subhead', text: 'PLUS A $500 GIFT CARD', factual: true, sourceId: 'giveaway', evidence: '$500 gift card' },
  ], index);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations.length, 3, 'all three inventions rejected');
  for (const v of bad.violations) assert.match(v.reason, /evidence not found in source giveaway/);
});

test('with no giveaway running, a giveaway claim fails as an UNKNOWN SOURCE', () => {
  const index = buildSourceIndex({ pdpBody: 'Made with saponified coconut oil.' });
  assert.equal(index.giveaway, undefined, 'no key at all — same shape as reviews on a product with none');
  const { ok, violations } = validateClaims(
    [{ zone: 'headline', text: 'WIN 36 BARS', factual: true, sourceId: 'giveaway', evidence: 'Thirty-six (36) bars' }],
    index,
  );
  assert.equal(ok, false);
  assert.match(violations[0].reason, /unknown source: giveaway/);
});

test('a giveaway source cannot launder a claim about the PRODUCT', () => {
  // Sourcing is per-source, and adding a fifth one must not widen any of the other four.
  const g = loadGiveaway({ root: REPO, now: LIVE });
  const index = buildSourceIndex({ pdpBody: 'Made with saponified coconut oil.', giveaway: g.text });
  const { ok, violations } = validateClaims(
    [{ zone: 'subhead', text: 'CLINICALLY PROVEN', factual: true, sourceId: 'giveaway', evidence: 'clinically proven' }],
    index,
  );
  assert.equal(ok, false);
  assert.match(violations[0].reason, /evidence not found in source giveaway/);
});

// ── the end-to-end question: CAN giveaway copy actually pass? ─────────────────────────
//
// Everything above proves the gate still rejects. This proves the feature is not merely a
// stricter way to fail: a realistic set of `giveaway-entry` zones, quoted out of the real
// published rules, clears BOTH gates in the order buildConcept runs them — health first,
// then sourcing. Without this the whole change could ship as a source nothing can use.
test('realistic giveaway-entry copy clears both gates, in buildConcept order', async () => {
  const { assertNoHealthClaims } = await import('../../agents/ad-studio/health-claims.js');
  const { assertClaimsSourced } = await import('../../agents/ad-studio/claims.js');
  const { formatByKey } = await import('../../agents/ad-studio/formats.js');
  const { expectedStrings } = await import('../../agents/ad-studio/copy.js');

  const g = loadGiveaway({ root: REPO, now: LIVE });
  const index = buildSourceIndex({
    pdpBody: 'Saponified coconut oil. Nothing else.',
    catalogEntry: { title: 'Moisturizing Coconut Soap', priceLabel: '$12' },
    giveaway: g.text,
  });

  const zones = {
    headline: '36 BARS OF SOAP. THREE YEARS.',
    subhead: 'One winner. Free to enter.',
    offerBadge: 'ENTER TO WIN',
    bottomBar: 'ENTRIES CLOSE SEPTEMBER 14, 2026 — NO PURCHASE NECESSARY',
  };
  assert.deepEqual(Object.keys(zones), formatByKey('giveaway-entry').zones, 'the fixture fills the real zone list');

  const claims = [
    { zone: 'headline', text: '36 BARS OF SOAP.', factual: true, sourceId: 'giveaway', evidence: 'Thirty-six (36) bars' },
    { zone: 'headline', text: 'THREE YEARS.', factual: true, sourceId: 'giveaway', evidence: 'three (3) years' },
    { zone: 'subhead', text: 'One winner.', factual: true, sourceId: 'giveaway', evidence: 'the randomly drawn winning entrant' },
    { zone: 'subhead', text: 'Free to enter.', factual: false },
    { zone: 'offerBadge', text: 'ENTER TO WIN', factual: false },
    { zone: 'bottomBar', text: 'ENTRIES CLOSE SEPTEMBER 14, 2026', factual: true, sourceId: 'giveaway', evidence: 'September 14, 2026' },
    { zone: 'bottomBar', text: 'NO PURCHASE NECESSARY', factual: true, sourceId: 'giveaway', evidence: 'NO PURCHASE NECESSARY' },
  ];

  assert.doesNotThrow(() => assertNoHealthClaims(zones), 'a giveaway ad has no reason to name a disease');
  assert.doesNotThrow(() => assertClaimsSourced(claims, index), 'and every fact traces to the published rules');
  assert.equal(expectedStrings(zones).length, 4);
});
