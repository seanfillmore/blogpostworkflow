/**
 * The plan in scripts/giveaway/fix-mistyped-entrant-emails.mjs rewrites the
 * identity of real people holding entries in a $536.40 prize draw, so its
 * invariants are asserted here rather than trusted to review.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PLAN } from '../../scripts/giveaway/fix-mistyped-entrant-emails.mjs';
import { suggestDomainTypo, KNOWN_DOMAINS } from '../../lib/giveaway/referrer-suggest.js';

const local = (e) => e.slice(0, e.lastIndexOf('@'));
const domain = (e) => e.slice(e.lastIndexOf('@') + 1);

test('every correction changes the DOMAIN only, never the local part', () => {
  // The local part is the half we cannot possibly infer. Touching it would be
  // inventing a different person, not correcting a slip.
  for (const { from, to } of PLAN) {
    assert.equal(local(to), local(from), `${from} -> ${to} altered the local part`);
    assert.notEqual(domain(to), domain(from), `${from} -> ${to} is not a correction at all`);
  }
});

test('every correction is exactly what suggestDomainTypo would have proposed', () => {
  // This is the whole justification for the plan: it reproduces the suggestion
  // the entry form would have shown, after the fact. If the shared module and
  // this table ever disagree, the table is the thing that is wrong — and the
  // script itself throws before writing anything, so this test and the runtime
  // guard fail together rather than one covering for the other.
  for (const { from, to } of PLAN) {
    assert.equal(suggestDomainTypo(from), to, `suggestDomainTypo disagrees about ${from}`);
  }
});

test('every target domain is a known real provider', () => {
  for (const { to } of PLAN) {
    assert.ok(KNOWN_DOMAINS.includes(domain(to)), `${domain(to)} is not a known provider`);
  }
});

test('no source domain is a real provider', () => {
  // The direction that would do damage: "correcting" someone off a domain that
  // works. ymail.com, cs.com, me.com and aim.com all trip a naive distance scan
  // and all deliver — confirmed entrants hold addresses at them.
  for (const { from } of PLAN) {
    assert.ok(!KNOWN_DOMAINS.includes(domain(from)),
      `${domain(from)} is a REAL provider and must never be "corrected"`);
  }
});

test('the plan has no duplicate sources and no target that is also a source', () => {
  // A target that is also somebody's source would chain two rewrites in one run,
  // and the outcome would depend on plan order.
  const froms = PLAN.map((r) => r.from);
  const tos = PLAN.map((r) => r.to);
  assert.equal(new Set(froms).size, froms.length, 'duplicate source address in the plan');
  assert.equal(new Set(tos).size, tos.length, 'two sources correct to the same address');
  for (const t of tos) assert.ok(!froms.includes(t), `${t} is both a target and a source`);
});

test('every address in the plan is lowercase and trimmed', () => {
  // The script matches profiles on a normalized email; a plan entry that is not
  // already normalized would silently never match and report "no entrant holds
  // this address any more", which reads like the problem fixed itself.
  for (const { from, to } of PLAN) {
    for (const e of [from, to]) assert.equal(e, e.trim().toLowerCase(), `${e} is not normalized`);
  }
});
