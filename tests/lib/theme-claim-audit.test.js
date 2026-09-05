// Every case here is a real thing that was live on 2026-09-05.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseDurationClaim, auditClaim, findMissingTemplates, summarize, branchForHandle, stripLiquidComments } from '../../lib/theme-claim-audit.js';

test('parses the shapes the real templates actually use', () => {
  assert.deepEqual(parseDurationClaim('A jar lasts about 12 weeks of nightly use — roughly $0.30 per day.'),
    { days: 84, perDay: 0.30, text: 'A jar lasts about 12 weeks of nightly use — roughly $0.30 per day.' });
  assert.equal(parseDurationClaim('An 8oz bottle lasts about a month of daily use — about $1 a day.').days, 30);
  assert.equal(parseDurationClaim('Each tube lasts about 6 weeks of twice-daily use — roughly $0.31 per day.').days, 42);
  assert.equal(parseDurationClaim('A tube lasts about 3 months of daily use.').days, 90);
});

test('copy with no duration claim is not a finding', () => {
  assert.equal(parseDurationClaim('Made by hand in small batches, right here in the USA.'), null);
  assert.equal(parseDurationClaim('30-day money-back guarantee.'), null, 'a guarantee window is not a supply claim');
  assert.equal(parseDurationClaim(null), null);
});

test('catches the four overstatements that were live', () => {
  // cream and the sensitive-skin set: 84 d claimed, 30 d measured
  assert.equal(auditClaim({ claim: { days: 84 }, rateDays: 30 }).verdict, 'overstates');
  // lotion before #772: 56 d claimed, 30 d measured
  assert.equal(auditClaim({ claim: { days: 56 }, rateDays: 30 }).verdict, 'overstates');
  // toothpaste before #780: 56 d claimed, 45 d measured
  const t = auditClaim({ claim: { days: 56 }, rateDays: 45 });
  assert.equal(t.verdict, 'overstates');
  assert.equal(t.ratio, 1.24);
});

test('claiming SHORT is always fine — the error is asymmetric', () => {
  // toothpaste after #780: 42 d claimed against a measured 45. Deliberately under.
  assert.equal(auditClaim({ claim: { days: 42 }, rateDays: 45 }).verdict, 'ok');
  assert.equal(auditClaim({ claim: { days: 10 }, rateDays: 90 }).verdict, 'ok');
});

test('"about a month" against a 30-day rate must not fire', () => {
  // Rounding allowance exists so the corrected copy does not trip its own gate.
  assert.equal(auditClaim({ claim: { days: 30 }, rateDays: 30 }).verdict, 'ok');
  assert.equal(auditClaim({ claim: { days: 30 }, rateDays: 28 }).verdict, 'ok');
});

test('catches a claim whose TWO numbers disagree — the original lotion defect', () => {
  // "8 weeks" but "$0.40 per day" on a $30 product implies 75 days.
  const r = auditClaim({ claim: { days: 56, perDay: 0.40 }, rateDays: 60, price: 30 });
  assert.equal(r.verdict, 'incoherent');
  assert.equal(r.impliedDays, 75);
});

test('coherent two-number claims pass', () => {
  // lotion after #772: 30 d, $1/day, $30 product.
  assert.equal(auditClaim({ claim: { days: 30, perDay: 1 }, rateDays: 30, price: 30 }).verdict, 'ok');
  // toothpaste after #780: 42 d, $0.31/day, $13 product -> 41.9 d implied.
  assert.equal(auditClaim({ claim: { days: 42, perDay: 0.31 }, rateDays: 45, price: 13 }).verdict, 'ok');
});

test('a product with no rate is unevidenced, not silently ok', () => {
  // lip balm and liquid soap were exactly this until 2026-09-05.
  const r = auditClaim({ claim: { days: 90 }, rateDays: null });
  assert.equal(r.verdict, 'unevidenced');
});

test('catches the coconut-soap case: templateSuffix naming an absent asset', () => {
  const missing = findMissingTemplates(
    [{ handle: 'coconut-soap', templateSuffix: 'landing-page-bar-soap', status: 'ACTIVE' },
     { handle: 'coconut-lotion', templateSuffix: 'landing-page-lotion', status: 'ACTIVE' }],
    ['templates/product.landing-page-lotion.json'],
  );
  assert.equal(missing.length, 1);
  assert.equal(missing[0].handle, 'coconut-soap');
  assert.equal(missing[0].expected, 'templates/product.landing-page-bar-soap.json');
});

test('a DRAFT product with a missing template is not a finding — it serves nobody', () => {
  assert.deepEqual(findMissingTemplates(
    [{ handle: 'x', templateSuffix: 'gone', status: 'DRAFT' }], []), []);
});

test('a product on the default template is never a finding', () => {
  assert.deepEqual(findMissingTemplates([{ handle: 'x', templateSuffix: null, status: 'ACTIVE' }], []), []);
});

test('exit codes rank by how badly the page is lying', () => {
  assert.equal(summarize({}).code, 0);
  assert.equal(summarize({ claims: [{ verdict: 'overstates' }] }).code, 1);
  // A missing template outranks a bad claim: the whole page is wrong, not one line.
  assert.equal(summarize({ missing: [{}], claims: [{ verdict: 'overstates' }] }).code, 2);
  // Could-not-read outranks everything — an unchecked page is worse than a known-bad one.
  assert.equal(summarize({ unreadable: [{}], missing: [{}] }).code, 3);
  assert.equal(summarize({ claims: [{ verdict: 'ok' }, { verdict: 'no-claim' }] }).code, 0);
});

// ── added after the gate's first live run reported 2 false positives ─────────

test('branchForHandle picks the branch that renders for THIS product', () => {
  const liquid = "{%- if product.handle == 'foam-soap-refill-32oz' -%}A 32oz refill lasts about four months.{%- else -%}An 8oz bottle lasts about a month.{%- endif -%}";
  assert.match(branchForHandle(liquid, 'foam-soap-refill-32oz'), /32oz refill lasts about four months/);
  assert.doesNotMatch(branchForHandle(liquid, 'foam-soap-refill-32oz'), /8oz bottle/);
  assert.match(branchForHandle(liquid, 'organic-foaming-hand-soap'), /8oz bottle lasts about a month/);
  assert.doesNotMatch(branchForHandle(liquid, 'organic-foaming-hand-soap'), /four months/);
});

test('the whole reason branchForHandle exists: one template, two products, one line', () => {
  // Live on 2026-09-05: the gate read BOTH branches and reported the 32oz copy
  // (120 d) as the 8oz product's claim (30 d rate) — a 4.00x false positive.
  const liquid = "{%- if product.handle == 'foam-soap-refill-32oz' -%}lasts about four months{%- else -%}lasts about a month{%- endif -%}";
  const asBottle = parseDurationClaim(branchForHandle(liquid, 'organic-foaming-hand-soap'));
  assert.equal(auditClaim({ claim: asBottle, rateDays: 30 }).verdict, 'ok');
  const asRefill = parseDurationClaim(branchForHandle(liquid, 'foam-soap-refill-32oz'));
  assert.equal(auditClaim({ claim: asRefill, rateDays: 120 }).verdict, 'ok');
});

test('text with no product.handle conditional is returned untouched', () => {
  const plain = 'A jar lasts about a month of nightly use.';
  assert.equal(branchForHandle(plain, 'anything'), plain);
  // An unrelated Liquid tag must not be mangled.
  const other = '{{ product.price | money }} lasts about a month';
  assert.equal(branchForHandle(other, 'x'), other);
});

test('a per-day figure inside a Liquid comment is documentation, not a claim', () => {
  // Live 2026-09-05: the bar-soap template documents its own arithmetic in a
  // {% comment %}, including $0.16 from an older price. The gate mixed that with
  // the rendered "3 weeks" and reported a defect that did not exist.
  const raw = "{%- comment -%} 25 days is the merchant figure; $0.16 per day at the old price {%- endcomment -%}<p>A bar lasts about 3 weeks of daily use.</p>";
  const clean = stripLiquidComments(raw);
  assert.doesNotMatch(clean, /0\.16/);
  const c = parseDurationClaim(clean);
  assert.equal(c.days, 21);
  assert.equal(c.perDay, null, 'no per-day survives, so no coherence check fires');
  assert.equal(auditClaim({ claim: c, rateDays: 25, price: 11 }).verdict, 'ok');
});
