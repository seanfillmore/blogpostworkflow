/**
 * Pure logic for pushing a rebuilt email into a Klaviyo flow.
 *
 * Flow email content IS writable, but not the way you would guess, and the shape of
 * the API is what forces the shape of this module:
 *
 *   - `PATCH /api/templates/{id}` on a FLOW-OWNED template is 404. Always.
 *   - `PATCH /api/flow-actions/{id}` (revision 2025-10-15+) updates the message,
 *     but rejects raw HTML: `'body' is not a valid field for the resource 'FlowEmail'`.
 *   - What it DOES accept is `template_id`, and pointing it at a LIBRARY template
 *     (which is writable) makes Klaviyo SNAPSHOT that template into a brand-new
 *     flow-owned copy.
 *
 * So a content push is: create a library template, repoint the flow action at it,
 * then read back through the consumer. Nothing is ever updated in place, and every
 * push strands the previous flow-owned snapshot — which is why `findOrphans` exists.
 *
 * All I/O lives in scripts/klaviyo-push-flow-template.mjs. This file is pure so the
 * decisions can be tested without touching a live flow.
 */

import {
  linksIn,
  tagsIn,
  classifyLinks,
  postalFindings,
  unsubscribeFindings,
} from './email-rebuild-checks.js';

/** A flow action carries an email only when its definition says so. */
export function emailMessage(action) {
  const def = action?.attributes?.definition ?? action?.definition;
  if (def?.type !== 'send-email') return null;
  const message = def?.data?.message;
  if (!message?.id) return null;
  return message;
}

/**
 * templateId -> where it is used.
 *
 * Keyed on template id because that is what the repo names its rebuilds
 * (`data/brand/email-rebuild/<templateId>.after.html`). A template id appearing on
 * two flows is recorded rather than collapsed: repointing one flow would silently
 * change the other, so the caller must refuse instead of guessing.
 */
export function buildTemplateIndex(flows) {
  const index = new Map();
  for (const { flow, actions } of flows) {
    for (const action of actions) {
      const message = emailMessage(action);
      if (!message?.template_id) continue;
      const use = {
        flowId: flow.id,
        flowName: flow.name,
        flowStatus: flow.status,
        actionId: String(action.id),
        messageId: message.id,
        messageName: message.name ?? null,
      };
      const existing = index.get(message.template_id);
      if (existing) existing.push(use);
      else index.set(message.template_id, [use]);
    }
  }
  return index;
}

/**
 * Every template id any flow currently points at, plus the snapshots those messages
 * actually render. The two differ: `message.template_id` can name a library template
 * whose *content* the flow serves from a separate snapshot id.
 */
export function referencedTemplateIds(flows, snapshotIds = []) {
  const ids = new Set(snapshotIds.filter(Boolean));
  for (const [templateId] of buildTemplateIndex(flows)) ids.add(templateId);
  return ids;
}

/**
 * Has the live template moved since we captured `.before.html`?
 *
 * Compared on TAGS AND LINKS, never bytes. Klaviyo rewrites markup on save — it
 * pretty-prints CSS, normalises quotes, strips CSS comments and inserts `<head>` —
 * so a byte comparison reports drift on every template that has ever been saved and
 * the check gets ignored. What matters is whether someone changed the email's
 * bindings or destinations in the UI, because pasting over that silently reverts
 * their work.
 */
export function driftFindings(beforeHtml, liveHtml) {
  if (beforeHtml == null) return { problems: [], warnings: ['no .before.html on file — cannot check drift'] };
  const problems = [];
  const lostTags = tagsIn(beforeHtml).filter((t) => !tagsIn(liveHtml).includes(t));
  const newTags = tagsIn(liveHtml).filter((t) => !tagsIn(beforeHtml).includes(t));
  const lostLinks = linksIn(beforeHtml).filter((l) => !linksIn(liveHtml).includes(l));
  const newLinks = linksIn(liveHtml).filter((l) => !linksIn(beforeHtml).includes(l));
  for (const t of [...lostTags, ...newTags]) problems.push(`live template has drifted — tag differs: ${t}`);
  for (const l of [...lostLinks, ...newLinks]) problems.push(`live template has drifted — link differs: ${l}`);
  return { problems, warnings: [] };
}

/**
 * Did the push land? Asked of the LIVE snapshot after repointing, never of the API's
 * own success response — a 200 on the PATCH says the flow action changed, not that
 * the flow now serves the content we meant.
 *
 * Semantic, for the same reason `driftFindings` is: Klaviyo rewrites markup on save,
 * so `live === intended` is never true and a byte check would fail every push.
 */
export function pushVerdict({ intendedHtml, liveHtml, postalAddress }) {
  const problems = [];
  const live = liveHtml ?? '';

  for (const tag of tagsIn(intendedHtml)) {
    if (!live.includes(tag)) problems.push(`tag did not survive the push: ${tag}`);
  }
  const liveLinks = new Set(linksIn(live));
  for (const link of linksIn(intendedHtml)) {
    if (!liveLinks.has(link)) problems.push(`link did not survive the push: ${link}`);
  }
  if (postalAddress) problems.push(...postalFindings(live, postalAddress).problems);
  problems.push(...unsubscribeFindings(live).problems);

  // A push that lost a compliance link is the one failure that must never be shrugged
  // off as "close enough" — it is a CAN-SPAM defect, not a cosmetic one.
  const { compliance } = classifyLinks(linksIn(intendedHtml));
  for (const href of compliance) {
    if (!liveLinks.has(href)) problems.push(`COMPLIANCE link did not survive the push: ${href}`);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Which flow message does `data/brand/email-rebuild/<fileId>.after.html` belong to?
 *
 * The filename is the template id that was live when the rebuild was pulled — and a
 * push REPLACES that id, because Klaviyo mints a fresh snapshot and rewrites
 * `template_id` to point at it. So the filename is a stable name for an unstable
 * thing, and resolving by template id alone works exactly once: the second push of
 * the same email reports "no live flow points at this template" and does nothing.
 *
 * The message id is the stable key — it survives every repoint — so a push records
 * it and later runs resolve through it. Template id remains the fallback for a file
 * that has never been pushed.
 */
export function resolveTarget(fileId, index, map = {}) {
  const remembered = map[fileId];
  if (remembered?.messageId) {
    for (const uses of index.values()) {
      const hit = uses.find((u) => u.messageId === remembered.messageId);
      if (hit) return { use: hit, via: 'message id' };
    }
    return { use: null, via: 'message id', missing: remembered.messageId };
  }
  const uses = index.get(fileId);
  if (!uses) return { use: null, via: 'template id', missing: fileId };
  if (uses.length > 1) return { use: null, via: 'template id', ambiguous: uses };
  return { use: uses[0], via: 'template id' };
}

/**
 * Templates this tool provably stranded, and nothing else.
 *
 * `sweepableIds` is an ALLOWLIST — the previous serving-template ids recorded in
 * flow-map.json when a push repointed a flow. A template absent from it is never a
 * candidate, however unreferenced it looks.
 *
 * THAT DIRECTION IS THE WHOLE SAFETY PROPERTY, and the first version of this
 * function had it backwards: it swept anything no FLOW referenced. Run read-only
 * against the real account that proposed deleting 24 templates, including
 * `camp_*` snapshots owned by CAMPAIGNS (which this module never walks, so they are
 * structurally invisible to a flow-only reference set) and the named library
 * sources `scripts/giveaway/build-nurture-flow.mjs` finds through
 * `upsertTemplateByName`. Unreferenced-by-flows is not the same question as unused,
 * and answering the wrong one deletes live email.
 *
 * `referencedIds` is still applied on top, so a stranded id a flow has since picked
 * up again is spared. Deleting a template is irreversible; a cluttered list is not.
 */
export function findOrphans({ templates, sweepableIds, referencedIds, olderThan = null }) {
  const orphans = [];
  const kept = [];
  for (const t of templates) {
    const reason =
      !sweepableIds.has(t.id) ? 'not stranded by this tool'
      : referencedIds.has(t.id) ? 'in use by a flow'
      : olderThan && t.updated && new Date(t.updated) > olderThan ? 'too recent to be certain'
      : null;
    if (reason) kept.push({ ...t, reason });
    else orphans.push(t);
  }
  return { orphans, kept };
}

/** Every template a push has ever replaced, from flow-map.json's `stranded` lists. */
export function strandedIds(map = {}) {
  return new Set(Object.values(map).flatMap((m) => m.stranded ?? []));
}
