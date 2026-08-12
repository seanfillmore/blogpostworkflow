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

export async function subscribeToList(listId, { email, firstName = null, properties = {} }) {
  const normalized = normalizeEmail(email);
  const attributes = { email: normalized, properties };
  if (firstName) attributes.first_name = firstName;
  attributes.subscriptions = { email: { marketing: { consent: 'SUBSCRIBED' } } };

  await klaviyoRequest('POST', '/profile-subscription-bulk-create-jobs/', {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        custom_source: 'Soap Giveaway 2026-09',
        profiles: { data: [{ type: 'profile', attributes }] },
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
