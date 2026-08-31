// lib/klaviyo-flow-templates.js
//
// "Which template does this flow email ACTUALLY send right now?"
//
// KLAVIYO ROTATES THE TEMPLATE ID EVERY TIME A FLOW EMAIL IS SAVED. That is not a
// quirk to note in passing — it silently kills anything keyed on the old id.
// Measured 2026-08-31, one day after five emails were pasted in the UI:
//
//   Post-Purchase 05   RiMM8C -> YysDcs
//   Replenishment 02   ThCS7T -> Tyigfs
//   Welcome 03         Ra3L8A -> XtF4DY
//   Product Review 01  TA5Wi4 -> ThdZ8y
//   Winback 01         SHb8Df -> StwFGY
//
// All five OLD ids now 404. `data/brand/email-rebuild/specs.js` is keyed by those
// ids, and `scripts/verify-email-rebuild.mjs` fetched live by the same key — so its
// drift check returned null, printed "(could not fetch)" and still reported PASS.
// A check that stops checking and keeps saying "safe to paste" is the exact failure
// shape the digest-severity rule exists to prevent; this module is what stops it.
//
// THE STABLE KEY IS THE EMAIL'S NAME, not its template id. `specs.js` already carries
// `name` for every entry and those names match the live flow-message names exactly.
//
// Read-only. Flow email content is NOT writable through the API — re-verified
// 2026-08-31 on revision 2026-07-15, the newest available, not just the pinned
// 2025-07-15: `PATCH /templates/{id}` -> 404 (Klaviyo's way of saying "not in the
// writable set" — GET on the same id returns 200), `PATCH /flow-messages/{id}` -> 405.
// So this resolves ids for READING; a content change is still built here and pasted
// there.

import { klaviyoRequest } from './klaviyo.js';

/**
 * Map every live flow email's NAME to the template it currently sends.
 *
 * @param {{ statuses?: string[] }} [opts]
 * @returns {Promise<Map<string, { templateId: string, flowId: string, flowName: string, messageId: string }>>}
 */
export async function liveFlowTemplates({ statuses = ['live'] } = {}) {
  const out = new Map();
  const flows = await klaviyoRequest('GET', '/flows/?fields[flow]=name,status&page[size]=50');
  for (const flow of flows.data || []) {
    if (statuses.length && !statuses.includes(flow.attributes?.status)) continue;
    const actions = await klaviyoRequest('GET', `/flows/${flow.id}/flow-actions/`);
    for (const action of actions.data || []) {
      if (action.attributes?.action_type !== 'SEND_EMAIL') continue;
      const messages = await klaviyoRequest('GET', `/flow-actions/${action.id}/flow-messages/`);
      for (const m of messages.data || []) {
        const templateId = m.relationships?.template?.data?.id;
        if (!templateId) continue;
        out.set(m.attributes.name, {
          templateId,
          flowId: flow.id,
          flowName: flow.attributes.name,
          messageId: m.id,
        });
      }
    }
  }
  return out;
}

/**
 * Resolve one spec to the template it currently sends.
 *
 * Returns `{ templateId, rotated }` where `rotated` is true when the live id differs
 * from the id the spec is filed under — the caller should SAY SO rather than quietly
 * following the new one, because a rotation means somebody saved that email in the UI
 * and whatever is in `.before.html` is now stale.
 *
 * `templateId` is null when the name matches no live flow email. That is a real
 * finding (the email was renamed, or its flow was turned off), never something to
 * paper over with the spec key.
 *
 * @param {{ specId: string, name: string, index?: Map }} args
 */
export async function resolveLiveTemplate({ specId, name, index }) {
  const map = index ?? (await liveFlowTemplates());
  const hit = map.get(name);
  if (!hit) return { templateId: null, rotated: false, reason: `no live flow email named "${name}"` };
  return {
    templateId: hit.templateId,
    rotated: hit.templateId !== specId,
    flowName: hit.flowName,
    messageId: hit.messageId,
  };
}
