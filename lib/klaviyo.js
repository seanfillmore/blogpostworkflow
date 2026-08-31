/**
 * Shared Klaviyo API client
 * Reads KLAVIYO_PRIVATE_KEY from .env
 *
 * Covers the surfaces this project uses: templates (email HTML) and flows
 * (create/read/update graph + status). Handles Klaviyo's revision header and
 * 429 rate-limit backoff. Defaults to a revision new enough for the Flows
 * definition read/write endpoints.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  const envPath = join(ROOT, '.env');
  const lines = readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const KEY = env.KLAVIYO_PRIVATE_KEY;
if (!KEY) throw new Error('Missing KLAVIYO_PRIVATE_KEY in .env');

const BASE = 'https://a.klaviyo.com/api';
// Flows definition read/write requires 2024-10-15+; 2025-07-15 is the newest
// verified working for create-flow-with-definition and template CRUD.
export const REVISION = '2025-07-15';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Low-level request with 429 backoff. Returns parsed JSON.
 * Throws on non-2xx (except 429 which is retried) with the Klaviyo error detail.
 */
export async function klaviyoRequest(method, path, body = null, { revision = REVISION, retries = 6 } = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = {
    Authorization: `Klaviyo-API-Key ${KEY}`,
    revision,
    accept: 'application/json',
  };
  if (body) headers['content-type'] = 'application/json';

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 2 ** Math.min(attempt, 5);
      await sleep(wait * 1000);
      continue;
    }

    if (res.status === 204) return { ok: true };

    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = (json.errors || []).map((e) => `${e.detail} @ ${e.source?.pointer || ''}`).join('; ');
      throw new Error(`Klaviyo ${method} ${path} -> ${res.status}: ${detail || text}`);
    }
    return json;
  }
  throw new Error(`Klaviyo ${method} ${path}: exhausted retries (rate limited)`);
}

// ---------- Events (metric-triggered sends) ----------

/**
 * Record a custom metric event against a profile.
 *
 * WHY EVENTS RATHER THAN A CAMPAIGN. A campaign sends one message to a segment
 * on a schedule; this needs to reach one person, now, with THEIR referrer's
 * address in the copy. A metric-triggered flow does exactly that, and it
 * inherits Klaviyo's consent handling for free — an unsubscribed profile simply
 * is not delivered to, which is the behaviour the referral audit relies on
 * rather than reimplements.
 *
 * The metric is created implicitly by the first event that names it, so there is
 * no separate "create metric" call — but note the ordering consequence: a flow
 * cannot be built against a metric that has never fired.
 *
 * Idempotency is the CALLER's job. Klaviyo will happily record the same event
 * twice; scripts/giveaway/audit-referrals.mjs stamps the profile and checks that
 * stamp, so a re-run after a partial failure does not mail anyone twice.
 *
 * @param {string} metricName e.g. 'Giveaway Referral Pending'
 * @param {string} email the profile the event belongs to
 * @param {object} properties event properties, readable in the flow's template
 */
export async function trackEvent(metricName, email, properties = {}) {
  return klaviyoRequest('POST', '/events/', {
    data: {
      type: 'event',
      attributes: {
        properties,
        metric: { data: { type: 'metric', attributes: { name: metricName } } },
        profile: { data: { type: 'profile', attributes: { email } } },
      },
    },
  });
}

/**
 * Find a metric by exact name, or null. Used to bind a flow trigger to it.
 *
 * No page[size]: unlike most Klaviyo collections, 'metric' rejects it outright
 * ("'page_size' is not a valid field for the resource 'metric'", 400). Cursor
 * pagination via links.next is the only supported traversal here.
 */
export async function findMetricByName(name) {
  let url = '/metrics/';
  while (url) {
    const d = await klaviyoRequest('GET', url);
    const hit = (d.data || []).find((m) => m.attributes?.name === name);
    if (hit) return { id: hit.id, name: hit.attributes.name };
    url = d.links?.next || null;
  }
  return null;
}

// ---------- Templates (email HTML) ----------

/** List all templates (paginated), returns [{id, name, editor_type, updated}] */
export async function listTemplates() {
  const out = [];
  let url = `/templates/?fields%5Btemplate%5D=name,editor_type,updated&page%5Bsize%5D=10`;
  while (url) {
    const d = await klaviyoRequest('GET', url);
    out.push(...d.data.map((t) => ({ id: t.id, ...t.attributes })));
    url = d.links?.next || null;
  }
  return out;
}

export async function getTemplate(id) {
  const d = await klaviyoRequest('GET', `/templates/${id}/?fields%5Btemplate%5D=name,editor_type,html`);
  return { id: d.data.id, ...d.data.attributes };
}

export async function createTemplate({ name, html, editorType = 'CODE' }) {
  const d = await klaviyoRequest('POST', '/templates/', {
    data: { type: 'template', attributes: { name, editor_type: editorType, html } },
  });
  return { id: d.data.id, ...d.data.attributes };
}

export async function updateTemplate(id, { name, html } = {}) {
  const attributes = {};
  if (name != null) attributes.name = name;
  if (html != null) attributes.html = html;
  const d = await klaviyoRequest('PATCH', `/templates/${id}/`, {
    data: { type: 'template', id, attributes },
  });
  return { id: d.data.id, ...d.data.attributes };
}

/** Find a template by exact name, or create it. Idempotent build helper. */
export async function upsertTemplateByName(name, html) {
  const all = await listTemplates();
  const existing = all.find((t) => t.name === name);
  if (existing) return updateTemplate(existing.id, { html });
  return createTemplate({ name, html });
}

/** Render a template with sample context to preview merge output. */
export async function renderTemplate(id, context = {}) {
  const d = await klaviyoRequest('POST', '/template-render/', {
    data: { type: 'template', id, attributes: { context } },
  });
  return d.data.attributes; // { html, text }
}

// ---------- Flows ----------

export async function getFlowDefinition(id) {
  const d = await klaviyoRequest('GET', `/flows/${id}/?additional-fields%5Bflow%5D=definition`);
  return { id: d.data.id, ...d.data.attributes };
}

export async function listFlowActions(id) {
  const d = await klaviyoRequest('GET', `/flows/${id}/flow-actions/?fields%5Bflow-action%5D=action_type,status,settings&page%5Bsize%5D=50`);
  return d.data.map((a) => ({ id: a.id, ...a.attributes }));
}

/** Create a flow from a full definition graph. Always created as draft by Klaviyo. */
export async function createFlow({ name, definition }) {
  const d = await klaviyoRequest('POST', '/flows/', {
    data: { type: 'flow', attributes: { name, definition } },
  });
  return { id: d.data.id, ...d.data.attributes };
}

/** Set flow status: 'draft' | 'manual' | 'live'. */
export async function updateFlowStatus(id, status) {
  const d = await klaviyoRequest('PATCH', `/flows/${id}/`, {
    data: { type: 'flow', id, attributes: { status } },
  });
  return { id: d.data.id, ...d.data.attributes };
}

export async function deleteFlow(id) {
  return klaviyoRequest('DELETE', `/flows/${id}/`);
}

/**
 * Every flow on the account: `{ id, name, status }`.
 *
 * Exists so a caller can resolve "which flow is LIVE under this name" at run
 * time instead of trusting an id written down in a module. A hardcoded flow id
 * is correct exactly once: the first go-live deletes the flow it names and
 * replaces it, after which the id points at nothing and any code relying on it
 * silently does nothing. See `cmdGolive` in scripts/flows/build.js.
 *
 * `page[size]` maxes out at 50 for this endpoint; a larger value is a 400.
 */
export async function listFlows() {
  const d = await klaviyoRequest('GET', '/flows/?fields%5Bflow%5D=name,status&page%5Bsize%5D=50');
  return d.data.map((f) => ({ id: f.id, name: f.attributes.name, status: f.attributes.status }));
}

/** Ids of every LIVE flow with this exact name, excluding `exceptId`. */
export async function liveFlowIdsByName(name, { exceptId = null } = {}) {
  const flows = await listFlows();
  return flows.filter((f) => f.name === name && f.status === 'live' && f.id !== exceptId).map((f) => f.id);
}

// ── Campaigns ────────────────────────────────────────────────────────────────
// A campaign, not a flow, is the right shape for any email whose timing is a
// FIXED DATE shared by every recipient — a deadline, a launch, a draw. A flow
// delay is relative to when each profile entered it, so a deadline email built
// as a flow step reaches late entrants after the deadline has already passed.
// See lib/giveaway/nurture-schedule.js for the case that forced this split.

/**
 * Create a scheduled email campaign. Klaviyo creates it in draft; it does not
 * send until a send-job is submitted, so this is safe to run repeatedly while
 * iterating.
 *
 * `sendAt` must be an ISO-8601 string with an offset. `is_local: false` sends
 * everyone at that absolute instant rather than at that wall-clock time in each
 * recipient's own timezone — correct for a deadline, which is one moment
 * worldwide, and wrong for a "good morning" send.
 *
 * `audienceId` is a LIST **or** SEGMENT id — `audiences.included` accepts both
 * and validates neither against what you meant, so pointing a campaign at the
 * wrong population is accepted silently. It was named `listId` until the
 * giveaway's confirm cutover made the correct audience a segment; the name was
 * the only thing saying otherwise.
 */
export async function createCampaign({
  name, audienceId, sendAt, subject, preview = '', fromEmail, fromLabel, messageLabel = name, useSmartSending = true,
}) {
  const d = await klaviyoRequest('POST', '/campaigns/', {
    data: {
      type: 'campaign',
      attributes: {
        name,
        audiences: { included: [audienceId], excluded: [] },
        send_strategy: { method: 'static', datetime: sendAt, options: { is_local: false } },
        send_options: { use_smart_sending: useSmartSending },
        'campaign-messages': {
          data: [{
            type: 'campaign-message',
            attributes: {
              definition: {
                channel: 'email',
                label: messageLabel,
                content: { subject, preview_text: preview, from_email: fromEmail, from_label: fromLabel },
              },
            },
          }],
        },
      },
    },
  });
  return { id: d.data.id, ...d.data.attributes, messageIds: (d.data.relationships?.['campaign-messages']?.data || []).map((m) => m.id) };
}

export async function getCampaign(id) {
  const d = await klaviyoRequest('GET', `/campaigns/${id}/?include=campaign-messages`);
  return { id: d.data.id, ...d.data.attributes, included: d.included || [] };
}

/**
 * Update a campaign message's SUBJECT and PREVIEW, preserving everything else.
 *
 * These live on the campaign MESSAGE, not on the template — so
 * assignTemplateToCampaignMessage moves the body and leaves the subject
 * untouched. Verified live 2026-08-24: three re-templated campaigns kept their
 * old subject lines while their bodies changed, which is the worst version of
 * the mismatch (a subject advertising a price the email no longer leads with).
 *
 * READ-MODIFY-WRITE, not a blind PATCH, for two reasons found the hard way:
 * `channel` is a REQUIRED field of the definition (a content-only patch is a
 * 400), and `definition` is replaced wholesale — sending only `content` would
 * drop `from_email`/`from_label` and leave the campaign with no sender.
 */
export async function updateCampaignMessageContent(messageId, { subject, preview } = {}) {
  const current = await klaviyoRequest('GET', `/campaign-messages/${messageId}/`);
  const definition = current?.data?.attributes?.definition;
  if (!definition) throw new Error(`campaign message ${messageId} has no definition to update`);

  const content = { ...(definition.content || {}) };
  if (subject !== undefined) content.subject = subject;
  if (preview !== undefined) content.preview_text = preview;

  const d = await klaviyoRequest('PATCH', `/campaign-messages/${messageId}/`, {
    data: {
      type: 'campaign-message',
      id: messageId,
      attributes: { definition: { ...definition, content } },
    },
  });
  return { id: d.data.id, ...d.data.attributes };
}

/** Point a campaign message at an existing template. Without this the campaign has no body. */
export async function assignTemplateToCampaignMessage(messageId, templateId) {
  const d = await klaviyoRequest('POST', '/campaign-message-assign-template/', {
    data: { type: 'campaign-message', id: messageId, relationships: { template: { data: { type: 'template', id: templateId } } } },
  });
  return { id: d.data.id, ...d.data.attributes };
}

export async function deleteCampaign(id) {
  return klaviyoRequest('DELETE', `/campaigns/${id}/`);
}

export default {
  klaviyoRequest, REVISION,
  listTemplates, getTemplate, createTemplate, updateTemplate, upsertTemplateByName, renderTemplate,
  getFlowDefinition, listFlowActions, createFlow, updateFlowStatus, deleteFlow,
  listFlows, liveFlowIdsByName,
  createCampaign, getCampaign, assignTemplateToCampaignMessage, deleteCampaign,
};
