/**
 * One-off deep audit of the other live Klaviyo flows.
 * Dumps graph + message meta + template text/links to scratchpad for analysis.
 */
import k from '../../lib/klaviyo.js';
import { writeFileSync } from 'fs';

const SCRATCH = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/a4c848d1-f4cb-4610-824d-3139a4187110/scratchpad';

const FLOWS = [
  { id: 'WMhLtj', name: 'Welcome Series - Customer vs Non-Customer' },
  { id: 'SVn26v', name: 'Abandoned Cart Reminder (Email)' },
  { id: 'WSWAUX', name: 'Browse Abandonment' },
  { id: 'T4FNSc', name: 'Customer Winback' },
  { id: 'UgeSBy', name: 'Product Review / Cross Sell' },
];

const strip = (html) => (html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const linksOf = (html) => [...new Set([...(html || '').matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('{') && !u.startsWith('mailto') && !u.includes('unsubscribe')))];

async function delayFieldOf(a) {
  const d = a.data || {};
  if (a.type === 'time-delay') return `${d.value ?? d.delay_seconds} ${d.unit || 'sec'}`;
  return '';
}

const report = {};
for (const f of FLOWS) {
  const out = { id: f.id, name: f.name, emails: [] };
  const def = await k.getFlowDefinition(f.id);
  out.status = def.status;
  out.trigger = (def.definition.triggers || []).map((t) => `${t.type}:${t.id}${t.trigger_filter ? ' (filtered)' : ''}`);
  out.profileFilter = def.definition.profile_filter ? JSON.stringify(def.definition.profile_filter).slice(0, 400) : null;

  // linear-ish action summary
  out.graph = [];
  for (const a of def.definition.actions) {
    let label = a.type;
    if (a.type === 'time-delay') label += ` ${await delayFieldOf(a)}`;
    if (a.type === 'conditional-split') label += ' [profile-split]';
    if (a.type === 'trigger-split') label += ' [event-split]';
    if (a.type === 'send-email' || a.type === 'send-message') label += ` :: ${a.data?.message?.name || a.data?.message?.subject_line || '(msg)'}`;
    out.graph.push(label);
  }

  // per-email detail via flow-actions + messages + templates
  const actions = await k.listFlowActions(f.id);
  for (const a of actions.filter((x) => x.action_type === 'SEND_EMAIL')) {
    const msgs = await k.klaviyoRequest('GET', `/flow-actions/${a.id}/flow-messages/?fields%5Bflow-message%5D=name,channel,content`);
    for (const m of msgs.data || []) {
      const c = m.attributes.content || {};
      const rel = m.relationships?.template?.data;
      let text = '', links = [], editor = '';
      if (rel) {
        try {
          const t = await k.getTemplate(rel.id);
          editor = t.editor_type;
          text = strip(t.html).slice(0, 700);
          links = linksOf(t.html);
        } catch (e) { text = `(template fetch failed: ${e.message})`; }
      }
      out.emails.push({
        actionStatus: a.status,
        name: m.attributes.name,
        subject: c.subject,
        preview: c.preview_text,
        from: c.from_email,
        editor,
        links,
        textSample: text,
      });
    }
  }
  report[f.id] = out;
  console.log(`✓ ${f.name}: ${out.emails.length} emails, ${out.graph.length} nodes, status ${out.status}`);
}

writeFileSync(`${SCRATCH}/flow-audit.json`, JSON.stringify(report, null, 2));
console.log(`\nWrote ${SCRATCH}/flow-audit.json`);
