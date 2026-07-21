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

export default {
  klaviyoRequest, REVISION,
  listTemplates, getTemplate, createTemplate, updateTemplate, upsertTemplateByName, renderTemplate,
  getFlowDefinition, listFlowActions, createFlow, updateFlowStatus, deleteFlow,
};
