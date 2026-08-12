/**
 * The five test identities used to verify every entry-earning method.
 *
 * Chosen so each NEGATIVE case is provable rather than merely absent:
 *   A  referrer; also does survey, Instagram and upload. Confirms.
 *   B  enters naming A and confirms  -> A earns +5
 *   C  enters naming A, never confirms -> A must earn nothing more
 *   D  names itself                  -> self-referral void
 *   E  names an address that never entered -> credits nobody
 *
 * Addresses are plus-aliases on one real inbox so all five confirmation
 * emails land in a single mailbox and a human can click two of them.
 *
 * Every identity carries gv_test. These profiles are created on the PRODUCTION
 * list, so the marker is what keeps them out of the report and out of the draw,
 * and what lets Gate A refuse launch while any remain. A profile without it is
 * indistinguishable from a real entrant and could win a $536.40 prize.
 *
 * The marker CANNOT be set through the public endpoint, by design: POST
 * /answers passes its body through answerProperties(), which whitelists the
 * survey enums and drops everything else. The harness therefore writes it
 * straight to Klaviyo with updateProfileProperties(). That asymmetry is
 * deliberate — a request that could mark itself `gv_test` could also un-mark a
 * real entrant out of the draw.
 */
import { ENTRY_VALUES } from './entries.js';

export const TEST_MARKER = 'gv_test';

const alias = (baseEmail, runId, key) => {
  const [local, domain] = String(baseEmail).split('@');
  return `${local}+gvtest-${runId}-${key}@${domain}`;
};

export function buildIdentities(runId, baseEmail) {
  const e = (key) => alias(baseEmail, runId, key);
  const props = { [TEST_MARKER]: true, gv_test_run: runId };
  const { base, confirm, survey, referral, instagram, upload } = ENTRY_VALUES;

  const emails = { a: e('a'), b: e('b'), c: e('c'), d: e('d'), e: e('e') };

  return {
    a: {
      key: 'a', email: emails.a, firstName: 'Test A', referredBy: null, confirms: true,
      expected: base + confirm + survey + instagram + upload + referral,
      properties: { ...props },
    },
    b: {
      key: 'b', email: emails.b, firstName: 'Test B', referredBy: emails.a, confirms: true,
      expected: base + confirm,
      properties: { ...props },
    },
    c: {
      key: 'c', email: emails.c, firstName: 'Test C', referredBy: emails.a, confirms: false,
      expected: base,
      properties: { ...props },
    },
    d: {
      key: 'd', email: emails.d, firstName: 'Test D', referredBy: emails.d, confirms: false,
      expected: base,
      properties: { ...props },
    },
    e: {
      key: 'e', email: emails.e, firstName: 'Test E',
      referredBy: alias(baseEmail, runId, 'never-entered'), confirms: false,
      expected: base,
      properties: { ...props },
    },
  };
}

export function isTestProfile(properties) {
  return (properties || {})[TEST_MARKER] === true;
}
