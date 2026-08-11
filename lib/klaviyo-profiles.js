/**
 * Klaviyo lists and profiles.
 *
 * Separate from lib/klaviyo.js, which owns templates and flows. Reuses that
 * module's klaviyoRequest so 429 backoff and error formatting stay in one place.
 *
 * IMPORTANT: double opt-in is a LIST SETTING, not an API field. Creating a list
 * here does not make it double opt-in — that is a one-time manual step in the
 * Klaviyo UI (List Settings -> Opt-in Process -> Double opt-in). Until it is
 * flipped, subscribeToList marks profiles SUBSCRIBED immediately and the +2
 * confirmation rung becomes meaningless. scripts/giveaway/verify-launch.mjs
 * prints a reminder; it cannot assert the setting, which the API does not expose.
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

export async function listSubscribedProfiles(listId) {
  // The list-profiles endpoint does NOT support filtering on
  // subscriptions.email.marketing.consent. Verified live 2026-08-11:
  //   400: "'subscriptions.email.marketing.consent' is not a filterable field
  //   for this resource. The filterable fields on this resource are: _kx,
  //   email, joined_group_at, phone_number, push_token"
  // So request the subscriptions block and filter client-side. Membership of
  // the SUBSCRIBED set is what later tasks treat as double-opt-in confirmation,
  // so this filter must not be dropped.
  let url = `/lists/${listId}/profiles/?additional-fields%5Bprofile%5D=subscriptions&page%5Bsize%5D=100`;
  const out = [];
  while (url) {
    const d = await klaviyoRequest('GET', url);
    for (const p of d.data || []) {
      if (p.attributes?.subscriptions?.email?.marketing?.consent !== 'SUBSCRIBED') continue;
      out.push({ id: p.id, email: p.attributes.email, properties: p.attributes.properties || {} });
    }
    url = d.links?.next || null;
  }
  return out;
}
