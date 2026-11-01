/**
 * Pure-logic tests for the paid-vs-organic CVR diagnosis.
 *
 * Every fixture below is taken from the real 2026-08-03 → 2026-09-01 production pull,
 * because the two guards being tested here exist only because production data broke
 * the first version of this script — a synthetic fixture would not have found either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnose, classifyBrand, aggregateAds, excelDate, attributeCampaignClicks,
  MIN_VISITS_FOR_VERDICT, MAX_PAID_SHARE_FOR_ORGANIC,
} from '../../scripts/amazon/paid-vs-organic-cvr.mjs';

const ad = (o) => ({
  asin: 'B0TEST', sku: 's', portfolio: 'p',
  clicks: 0, spend: 0, adOrders: 0, adUnits: 0, adUnitSales: 0, adTotalSales: 0, ...o,
});

test('brand split follows the title rule, never the SKU prefix', () => {
  assert.equal(classifyBrand('Culina Cast Iron Cleaning Soap'), 'culina');
  assert.equal(classifyBrand('Cast-Iron Cleaning Kit, A Cleanser'), 'culina', 'no "culina" token, but "cast iron"');
  assert.equal(classifyBrand('Real Skin Care Organic Body Lotion 8oz'), 'rsc');
  assert.equal(classifyBrand('REAL Deodorant'), 'rsc', 'the REAL sub-brand is RSC');
  // An absent title must NOT silently classify as a brand.
  assert.equal(classifyBrand(''), 'unknown');
  assert.equal(classifyBrand(undefined), 'unknown');
});

test('a real ad-problem ASIN: paid converts far below organic on the same listing', () => {
  // B09QJFBPJ1, the production row that motivated the whole diagnosis.
  const d = diagnose(ad({ clicks: 75, adUnits: 6, spend: 90.32, adTotalSales: 154 }),
    { sessions: 153, unitsOrdered: 28 });
  assert.equal(d.verdict, 'ad-problem');
  assert.ok(d.ratio < 0.5, `expected a large gap, got ${d.ratio}`);
  assert.ok(d.orgCvr > d.paidCvr);
});

test('both paths converting alike is listing-bound, not an ad problem', () => {
  const d = diagnose(ad({ clicks: 62, adUnits: 12 }), { sessions: 178, unitsOrdered: 37 });
  assert.equal(d.verdict, 'listing-bound');
});

test('PAID-DOMINANT: a mostly-ad-fed listing is never scored on its organic residual', () => {
  // B0B687583D — 76% of sessions are ad clicks. The residual is mostly the
  // click-is-not-a-session bias, so an organic rate must not be reported at all.
  const d = diagnose(ad({ clicks: 101, adUnits: 10 }), { sessions: 133, unitsOrdered: 13 });
  assert.equal(d.verdict, 'paid-dominant');
  assert.equal(d.orgCvr, null, 'an unreadable organic rate must be null, not a number');
  assert.equal(d.ratio, null);
  assert.ok(d.paidShare > MAX_PAID_SHARE_FOR_ORGANIC);
  // The raw value is retained for inspection but is not the reportable field.
  assert.ok(typeof d.orgCvrRaw === 'number');
});

test('clicks exceeding total sessions is not-measurable, and is never clamped to zero', () => {
  // B071SGF6GT — 1,109 ad clicks against 901 sessions. Proof that a click is not a
  // session. Clamping the negative residual would hide the one case that proves it.
  const d = diagnose(ad({ clicks: 1109, adUnits: 141 }), { sessions: 901, unitsOrdered: 226 });
  assert.equal(d.verdict, 'not-measurable');
  assert.equal(d.orgSessions, -208, 'the negative residual is the evidence; keep it');
  assert.equal(d.orgCvr, null);
});

test('a 100%-paid listing cannot produce a 1200% organic rate in the output', () => {
  // B08KHGYYKQ — 676 clicks against 678 sessions leaves a 2-session residual that
  // arithmetically yields 1200%. The first version of this script printed exactly that.
  const d = diagnose(ad({ clicks: 676, adUnits: 37 }), { sessions: 678, unitsOrdered: 61 });
  assert.equal(d.orgCvr, null);
  assert.notEqual(d.verdict, 'ad-problem');
});

test('a side below the visit floor is marked unreadable rather than scored', () => {
  const d = diagnose(ad({ clicks: MIN_VISITS_FOR_VERDICT - 1, adUnits: 0 }),
    { sessions: 200, unitsOrdered: 20 });
  assert.equal(d.paidReadable, false);
  assert.equal(d.verdict, 'organic-only');
});

test('window is read off the rows, and ragged per-campaign ranges still sum', () => {
  const rows = [
    { 'Start Date': 46237, 'End Date': 46250, 'Advertised ASIN': 'B01', 'Advertised SKU': 'x',
      'Portfolio name': 'p', Clicks: 10, Spend: 5, '7 Day Total Orders (#)': 1,
      '7 Day Advertised SKU Units (#)': 1, '7 Day Advertised SKU Sales': 20, '7 Day Total Sales': 20 },
    { 'Start Date': 46251, 'End Date': 46266, 'Advertised ASIN': 'B01', 'Advertised SKU': 'x',
      'Portfolio name': 'p', Clicks: 5, Spend: 3, '7 Day Total Orders (#)': 2,
      '7 Day Advertised SKU Units (#)': 2, '7 Day Advertised SKU Sales': 40, '7 Day Total Sales': 40 },
  ];
  const { asins, window } = aggregateAds(rows);
  assert.equal(asins.length, 1, 'time-sliced rows for one ASIN collapse to one row');
  assert.equal(asins[0].clicks, 15);
  assert.equal(asins[0].adUnits, 3);
  assert.equal(window.start, excelDate(46237));
  assert.equal(window.end, excelDate(46266));
});

test('excelDate handles the 1900 leap-year epoch', () => {
  assert.equal(excelDate(46237), '2026-08-03');
  assert.equal(excelDate(46266), '2026-09-01');
});

test('SB/SD clicks attribute to a brand via the ASIN in the campaign name', () => {
  const asinBrand = new Map([['B08BTVXLXN', 'culina'], ['B08GMCDMQ7', 'rsc']]);
  const rows = [
    { 'Campaign Name': 'SBV - PT - Scrub - B08BTVXLXN - EB', Clicks: 6 },
    { 'Campaign Name': 'SD - RM - VCPM - Body Lotions - B08GMCDMQ7 - EB', Clicks: 4 },
    { 'Campaign Name': 'SB - PC - Search Terms3 - Broad - EB', Clicks: 259 },
  ];
  const out = attributeCampaignClicks(rows, asinBrand);
  assert.equal(out.culina, 6);
  assert.equal(out.rsc, 4);
  assert.equal(out.unattributed, 259, 'a campaign naming no ASIN is reported, never assigned');
});

test('a campaign naming two brands is unattributed rather than guessed', () => {
  const asinBrand = new Map([['B08BTVXLXN', 'culina'], ['B08GMCDMQ7', 'rsc']]);
  const out = attributeCampaignClicks(
    [{ 'Campaign Name': 'Mixed - B08BTVXLXN/B08GMCDMQ7 - EB', Clicks: 12 }], asinBrand);
  assert.equal(out.unattributed, 12);
});
