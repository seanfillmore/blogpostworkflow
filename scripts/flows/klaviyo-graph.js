/**
 * Shared Klaviyo flow-graph builders + lifecycle helpers for RSC flows.
 * Flows are trees (branches don't reconverge); keep graphs linear with at most
 * terminal splits. Personalize inside templates via {% if ... in event.Items %}.
 */
import k from '../../lib/klaviyo.js';

export const FROM = { from_email: 'support@realskincare.com', from_label: 'Real Skin Care', reply_to_email: '', cc_email: '', bcc_email: '' };

export const delay = (tid, value, unit, next) => ({
  temporary_id: tid, type: 'time-delay',
  data: { unit, value, secondary_value: null, timezone: 'profile' },
  links: { next },
});

/** send-email action. `msg` = {subject, preview, template_id, name}. status default draft. */
export const send = (tid, msg, next, status = 'draft') => ({
  temporary_id: tid, type: 'send-email',
  data: {
    status,
    message: {
      ...FROM,
      subject_line: msg.subject, preview_text: msg.preview || '',
      template_id: msg.template_id,
      smart_sending_enabled: true, transactional: false,
      add_tracking_params: false, custom_tracking_params: null, additional_filters: null,
      name: msg.name,
    },
  },
  links: { next },
});

/** trigger-split on the trigger event's Items list containing ANY of `titles`. */
export const itemSplit = (tid, metricId, titles, nextTrue, nextFalse) => ({
  temporary_id: tid, type: 'trigger-split',
  data: {
    trigger_filter: { condition_groups: [{ conditions: titles.map((value) => ({ type: 'metric-property', metric_id: metricId, field: 'Items', filter: { type: 'list', operator: 'contains', value } })) }] },
    trigger_id: metricId, trigger_type: 'metric', trigger_subtype: null,
  },
  links: { next_if_true: nextTrue, next_if_false: nextFalse },
});

export async function createFlow(name, definition) {
  return k.createFlow({ name, definition });
}

/** Verify a flow: status + no orphan/dangling links + message statuses. */
export async function verifyFlow(flowId) {
  const f = await k.getFlowDefinition(flowId);
  const ids = new Set(f.definition.actions.map((a) => a.id));
  const issues = [];
  for (const a of f.definition.actions) {
    const nexts = [a.links.next, a.links.next_if_true, a.links.next_if_false].filter((x) => x !== undefined);
    if (a.type !== 'trigger-split' && a.type !== 'conditional-split' && a.links.next === undefined) issues.push(`orphan ${a.id} (${a.type})`);
    for (const n of nexts) if (n !== null && !ids.has(n)) issues.push(`dangling ${a.id} -> ${n}`);
  }
  const acts = await k.listFlowActions(flowId);
  const sends = acts.filter((a) => a.action_type === 'SEND_EMAIL');
  return { status: f.status, sends: sends.map((s) => ({ id: s.id, status: s.status })), issues, graph: f.definition.actions };
}

/** Set a flow live (idempotent). */
export async function setLive(flowId) {
  return k.updateFlowStatus(flowId, 'live');
}
