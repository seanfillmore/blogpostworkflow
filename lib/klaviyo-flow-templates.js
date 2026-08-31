// lib/klaviyo-flow-templates.js
//
// "Which template does this flow email ACTUALLY send right now?"
//
// KLAVIYO ROTATES THE TEMPLATE ID EVERY TIME A FLOW EMAIL IS SAVED. That is not a
// quirk to note in passing — it silently kills anything keyed on the old id.
// Measured 2026-08-31, one day after five emails were repointed through the API
// (see "WHAT ROTATED THOSE FIVE IDS" below — this is not evidence of a UI paste):
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
// WHAT ROTATED THOSE FIVE IDS: an API push, not a paste. Those five emails were
// repointed by `scripts/klaviyo-push-flow-template.mjs` on 2026-08-30, and their old
// ids 404 because that tool's orphan sweep deleted the templates it had stranded.
// Nobody opened the Klaviyo UI. The rotation itself is real and this module is still
// the right fix — it just is not evidence of hand-editing.
//
// AND FLOW EMAIL CONTENT *IS* WRITABLE. The header used to say otherwise, citing
// `PATCH /templates/{id}` -> 404 and `PATCH /flow-messages/{id}` -> 405. Both results
// are real and both are the WRONG ENDPOINT. The writable one is
// `PATCH /api/flow-actions/{id}`, GA in revision 2025-10-15 ("Update flow actions
// within a flow, including associated message content") — measured 200 on revision
// 2026-07-15 against live and draft flows, and 404 "No valid revisions found for
// method" on 2025-07-15. See lib/flow-template-push.js.
//
// This module stays READ-ONLY, which is still the right shape for a drift check.
//
// ⚠ NAME IS NOT A UNIQUE KEY ON THIS ACCOUNT. Measured 2026-08-31: there are TWO
// flows called "Welcome Series (RSC v2)" — a draft (UUa3Qk) and a live one (V5fp5i) —
// carrying the same FIVE message names between them ("Welcome — 01 Welcome + Free
// Shipping" … "Welcome — 05 Last Chance Free Shipping"). With the default
// `statuses: ['live']` the live flow silently wins every one of those names, so a spec
// filed under a DRAFT-flow template id resolves to an unrelated live template and
// reports `rotated: true`. `data/brand/email-rebuild/` is keyed to the draft flow's
// ids, so all five of those specs are affected. Callers must treat a `rotated` verdict
// on a duplicated name as UNRESOLVED, not as a new id to follow —
// `liveFlowTemplates` now returns `duplicateNames` so that is checkable.

import { klaviyoRequest } from './klaviyo.js';

/**
 * Map every live flow email's NAME to the template it currently sends.
 *
 * @param {{ statuses?: string[] }} [opts]
 * @returns {Promise<Map<string, { templateId: string, flowId: string, flowName: string, messageId: string }>>}
 */
export async function liveFlowTemplates({ statuses = ['live'] } = {}) {
  const out = new Map();
  const duplicateNames = new Set();
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
        const name = m.attributes.name;
        // FIRST WRITER WINS, and a collision is recorded rather than overwritten.
        // Silently keeping the last flow walked would make the answer depend on
        // Klaviyo's pagination order — see the duplicate-name warning above.
        if (out.has(name)) duplicateNames.add(name);
        else out.set(name, { templateId, flowId: flow.id, flowName: flow.attributes.name, messageId: m.id });
      }
    }
  }
  out.duplicateNames = duplicateNames;
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
  // Ambiguous name -> UNRESOLVED. Following the winner would silently re-point a spec
  // at a different flow's email; see the duplicate-name warning in the header.
  if (map.duplicateNames?.has(name)) {
    return {
      templateId: null,
      rotated: false,
      ambiguous: true,
      reason: `"${name}" is served by more than one flow — cannot resolve by name`,
    };
  }
  return {
    templateId: hit.templateId,
    rotated: hit.templateId !== specId,
    flowName: hit.flowName,
    messageId: hit.messageId,
  };
}
