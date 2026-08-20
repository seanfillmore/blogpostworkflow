/**
 * Klaviyo lists and profiles.
 *
 * Separate from lib/klaviyo.js, which owns templates and flows. Reuses that
 * module's klaviyoRequest so 429 backoff and error formatting stay in one place.
 *
 * IMPORTANT: double opt-in is a LIST SETTING that only the Klaviyo UI can
 * CHANGE (List Settings -> Opt-in Process -> Double opt-in). Creating a list
 * here does not make it double opt-in. Until it is flipped, subscribeToList
 * marks profiles SUBSCRIBED immediately and the +2 confirmation rung becomes
 * meaningless.
 *
 * It IS however READABLE: `GET /api/lists/{id}/` returns
 * `attributes.opt_in_process` ('double_opt_in' | 'single_opt_in'). Verified live
 * 2026-08-11 — list Y2ukbE is `double_opt_in`, while `S6hKFq "Email List"` is
 * `single_opt_in`, so the account is NOT uniform and a re-created list can
 * silently land single. getListOptInProcess below reads it and
 * scripts/giveaway/verify-launch.mjs asserts it in Gate A.
 */
import { klaviyoRequest } from './klaviyo.js';
import { normalizeEmail } from './giveaway/entries.js';

// Compared trimmed and case-folded so a stray space, a case change, or an
// em-dash/hyphen edit to the list name does not silently create a duplicate
// list instead of reusing the existing one.
const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export async function findListByName(name) {
  let url = '/lists/?fields%5Blist%5D=name';
  while (url) {
    const d = await klaviyoRequest('GET', url);
    const hit = (d.data || []).find((l) => sameName(l.attributes?.name, name));
    if (hit) return { id: hit.id, name: hit.attributes.name };
    url = d.links?.next || null;
  }
  return null;
}

/**
 * A list's opt-in process: 'double_opt_in' | 'single_opt_in' (or null if the
 * field is missing from the response, which must never read as a pass).
 *
 * The value cannot be SET through the API — only read. That asymmetry is the
 * whole reason this exists: the setting is a manual UI step, so the only
 * protection against it being missed (or silently reverted on a re-created
 * list) is asserting the read value in Gate A.
 */
export async function getListOptInProcess(listId) {
  const d = await klaviyoRequest('GET', `/lists/${listId}/?fields%5Blist%5D=opt_in_process`);
  return d.data?.attributes?.opt_in_process ?? null;
}

export async function createList(name) {
  const d = await klaviyoRequest('POST', '/lists/', {
    data: { type: 'list', attributes: { name } },
  });
  return { id: d.data.id, name: d.data.attributes.name };
}

/**
 * Add someone to a list, carrying their name and custom properties.
 *
 * TWO calls, and they cannot be collapsed into one. The bulk-subscribe job
 * accepts ONLY `email`, `phone_number`, `subscriptions` and
 * `age_gated_date_of_birth` on its nested profile. Sending `first_name` or
 * `properties` there is a hard 400:
 *
 *   'first_name' is not a valid field for the resource 'profile'.
 *     @ /data/attributes/profiles/data/0/attributes/first_name
 *
 * That was this function's original shape, and it meant POST /api/giveaway/enter
 * returned 502 for every single entrant from the day it shipped — the giveaway
 * list sat at zero members and nothing surfaced it, because the unit test
 * stubbed a 202 and asserted the rejected payload.
 *
 * Order matters: the upsert runs FIRST. The subscribe is what triggers Klaviyo's
 * double-opt-in email, and that email must not go out before the profile has the
 * name and properties it greets the entrant with.
 */
export async function subscribeToList(listId, { email, firstName = null, properties = {} }) {
  const normalized = normalizeEmail(email);

  // 1. Upsert the profile data. profile-import creates or updates in one call,
  //    which is what a resubmit needs.
  const attributes = { email: normalized };
  // Never send a null first_name: on a resubmit it would overwrite a real one.
  if (firstName) attributes.first_name = firstName;
  if (properties && Object.keys(properties).length) attributes.properties = properties;
  await klaviyoRequest('POST', '/profile-import', { data: { type: 'profile', attributes } });

  // 2. Request consent. Email only — see the 400 above.
  await klaviyoRequest('POST', '/profile-subscription-bulk-create-jobs/', {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: 'Soap Giveaway 2026-09',
        profiles: {
          data: [{
            type: 'profile',
            attributes: {
              email: normalized,
              subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } },
            },
          }],
        },
      },
      relationships: { list: { data: { type: 'list', id: listId } } },
    },
  });
  return { ok: true };
}

export async function getProfileByEmail(email) {
  const normalized = normalizeEmail(email);
  const filter = encodeURIComponent(`equals(email,"${normalized}")`);
  const d = await klaviyoRequest('GET', `/profiles/?filter=${filter}`);
  const p = (d.data || [])[0];
  if (!p) return null;
  return { id: p.id, email: p.attributes.email, properties: p.attributes.properties || {} };
}

export async function updateProfileProperties(email, properties) {
  const profile = await getProfileByEmail(email);
  if (!profile) throw new Error(`no Klaviyo profile for ${email}`);
  await klaviyoRequest('PATCH', `/profiles/${profile.id}/`, {
    data: { type: 'profile', id: profile.id, attributes: { properties } },
  });
  return { id: profile.id };
}

/**
 * EVERY profile on the list, each tagged with `subscribed` — whether its email
 * marketing consent is currently SUBSCRIBED.
 *
 * Consent is a POINT-IN-TIME fact and a confirmation click is a HISTORICAL one.
 * Reading only the SUBSCRIBED set conflates them: someone who confirms at 14:00
 * and unsubscribes at 16:00 disappears before the 08:30 reconciler ever sees
 * them, so their +2 is never credited and nobody they referred credits anyone —
 * which contradicts official rules §12 ("independent of ongoing email
 * subscription status"). Callers that need the durable fact read this and
 * combine `subscribed` with the stored gv_confirmed_at stamp.
 */
export async function listProfilesWithConsent(listId) {
  // The list-profiles endpoint does NOT support filtering on
  // subscriptions.email.marketing.consent. Verified live 2026-08-11:
  //   400: "'subscriptions.email.marketing.consent' is not a filterable field
  //   for this resource. The filterable fields on this resource are: _kx,
  //   email, joined_group_at, phone_number, push_token"
  // So request the subscriptions block and read consent client-side.
  let url = `/lists/${listId}/profiles/?additional-fields%5Bprofile%5D=subscriptions&page%5Bsize%5D=100`;
  const out = [];
  while (url) {
    const d = await klaviyoRequest('GET', url);
    for (const p of d.data || []) {
      out.push({
        id: p.id,
        email: p.attributes.email,
        properties: p.attributes.properties || {},
        subscribed: p.attributes?.subscriptions?.email?.marketing?.consent === 'SUBSCRIBED',
      });
    }
    url = d.links?.next || null;
  }
  return out;
}

/**
 * Only the currently-SUBSCRIBED members. Membership of this set is what proves
 * a double-opt-in click HAPPENED, so it decides who is NEWLY confirmed — but it
 * is not the set of everyone who ever confirmed (see listProfilesWithConsent).
 */
export async function listSubscribedProfiles(listId) {
  return (await listProfilesWithConsent(listId)).filter((p) => p.subscribed);
}

/**
 * Everyone who SUBMITTED the entry form, confirmed or not.
 *
 * THE DISTINCTION THIS EXISTS FOR. The giveaway list is `double_opt_in`, so a submission
 * creates the profile and writes every `gv_` property, but the profile does NOT join the
 * list until the entrant clicks the confirmation email. Every count in the daily report
 * read list membership, so it reported confirmations while calling them entrants — and on
 * 2026-08-20, day one of the paid campaign, that showed "3 entrants" when 11 people had
 * entered. It made cost per entry look like $6.86 when acquisition was costing $1.87.
 *
 * Both numbers are real and they answer different questions. Submissions measure what the
 * ADS bought. Confirmations measure who can actually be emailed, credited as a referrer,
 * or nurtured toward a purchase. Reporting only the second as "entrants" hid a 27%
 * confirmation rate behind what looked like an expensive campaign.
 *
 * It also matters for the DRAW: Official Rules §5 grants a base entry for "submitting the
 * entry form", so an unconfirmed submitter is a legitimate entrant holding one entry.
 * Drawing from the list alone would exclude them.
 *
 * WHY IT PAGES ON `updated` RATHER THAN FILTERING ON THE PROPERTY. Custom properties are
 * not filterable — verified live 2026-08-20: "'properties.gv_entrant' is not a filterable
 * field for this resource." `created` would miss an entrant who already had a profile
 * (a past customer entering), whereas writing gv_entered_at necessarily bumps `updated`,
 * so an `updated` floor at the entry-period open is COMPLETE. The result is filtered
 * client-side on gv_entered_at, which is the authoritative stamp.
 *
 * @param {string} since ISO8601 floor — use the giveaway's entryOpensAt
 * @returns {Promise<Array<{id,email,properties,confirmedAt,enteredAt}>>}
 */
export async function listEntrantProfiles(since) {
  if (!since) throw new Error('listEntrantProfiles: `since` is required — pass entryOpensAt');
  const filter = encodeURIComponent(`greater-than(updated,${new Date(since).toISOString()})`);
  let url = `/profiles/?filter=${filter}&page%5Bsize%5D=100`;
  const out = [];
  while (url) {
    const d = await klaviyoRequest('GET', url);
    for (const p of d.data || []) {
      const props = p.attributes?.properties || {};
      if (!props.gv_entered_at) continue;
      out.push({
        id: p.id,
        email: p.attributes.email,
        properties: props,
        enteredAt: props.gv_entered_at,
        confirmedAt: props.gv_confirmed_at || null,
      });
    }
    url = d.links?.next || null;
  }
  return out;
}
