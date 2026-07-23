/**
 * Coconut Reset — Digital Delivery flow (net-new, RSC).
 *
 * Trigger: Placed Order (V69ueg, no filter) -> trigger-split on Items containing
 * "Coconut Reset" -> TRUE: immediate transactional send of the two digital guides;
 * FALSE: exit. Delivers on EVERY bundle purchase (no first-time gate).
 *
 * The send is built manually (not via components' `send` helper) so it is:
 *   - smart_sending_enabled: false  -> never suppressed (a paid delivery must arrive)
 *   - transactional: true           -> reaches buyers even without marketing consent
 *
 *   node build-reset-delivery.mjs template   upsert the email template
 *   node build-reset-delivery.mjs flow        (re)create the flow as DRAFT
 *   node build-reset-delivery.mjs golive      (re)create + set flow & message LIVE
 *   node build-reset-delivery.mjs verify       print built flow graph
 *   node build-reset-delivery.mjs render       render the email to scratchpad HTML
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import k from '../../lib/klaviyo.js';
import { verifyFlow, itemSplit, FROM } from './klaviyo-graph.js';
import { shell, H1, P_, SIGN, button } from './components.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, 'reset-delivery-state.json');
const SCRATCH = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/bf5292fc-c246-424e-8e64-205d1934d1f2/scratchpad';
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

const PLACED_ORDER = 'V69ueg';
const MATCH_TITLES = ['Coconut Reset']; // stable substring of "$99 Coconut Reset-Digital"

const TRACKER_URL = 'https://cdn.shopify.com/s/files/1/0270/1911/6579/files/90-Day-Calm-Skin-Routine-and-Tracker.pdf?v=1784819747';
const GUIDE_URL   = 'https://cdn.shopify.com/s/files/1/0270/1911/6579/files/Coconut-Skincare-Field-Guide.pdf?v=1784819751';

const EMAIL = {
  name: 'Coconut Reset — Digital Delivery',
  subject: 'Your 90-Day Reset guides are inside 🥥',
  preview: 'Download your Routine & Tracker and Field Guide — plus what to do first.',
  html: shell(
    'Download your Routine & Tracker and Field Guide — plus what to do first.',
    H1('Your reset starts now') +
    P_('Hi {{ first_name|default:"there" }}, thanks for starting your 90-Day Coconut Reset. Your box is on its way — and your two digital guides are ready to download right now.') +
    P_('<strong>1. The 90-Day Calm-Skin Routine &amp; Tracker</strong> — the simple two-step plan and a 12-week tracker to keep you on it.') +
    button(TRACKER_URL, 'Download the Routine &amp; Tracker') +
    P_('<strong>2. The Coconut Skincare Field Guide</strong> — what helps sensitive skin, what quietly irritates it, and how to get the most from every drop.') +
    button(GUIDE_URL, 'Download the Field Guide') +
    P_('<strong>Do this first:</strong> patch test the lotion on your wrist (24 hours), then start the two-step routine — lotion every morning, cream every night. Consistency is the whole game.') +
    P_('Your box ships within 2 business days. Questions? Just reply to this email — a real person will answer.') +
    SIGN,
  ),
};

async function cmdTemplate() {
  const res = await k.upsertTemplateByName(EMAIL.name, EMAIL.html);
  const state = loadState();
  state.templateId = res.id;
  saveState(state);
  console.log(`✓ template ${res.id}  "${EMAIL.name}"`);
  return res.id;
}

function buildSend(templateId, status) {
  return {
    temporary_id: 'send1', type: 'send-email',
    data: {
      status,
      message: {
        ...FROM,
        subject_line: EMAIL.subject, preview_text: EMAIL.preview,
        template_id: templateId,
        smart_sending_enabled: false,   // paid delivery must never be suppressed
        transactional: true,            // reaches buyers regardless of marketing consent
        add_tracking_params: false, custom_tracking_params: null, additional_filters: null,
        name: EMAIL.name,
      },
    },
    links: { next: null },
  };
}

async function buildFlow(sendStatus, flowStatus) {
  const state = loadState();
  if (!state.templateId) throw new Error('run `template` first');
  if (state.flowId) { await k.deleteFlow(state.flowId).catch(() => {}); console.log(`  removed prior flow ${state.flowId}`); }

  const definition = {
    triggers: [{ type: 'metric', id: PLACED_ORDER, trigger_filter: null }],
    profile_filter: null, // item-split does the filtering; deliver on every bundle purchase
    entry_action_id: 'split1',
    actions: [
      itemSplit('split1', PLACED_ORDER, MATCH_TITLES, 'send1', null),
      buildSend(state.templateId, sendStatus),
    ],
  };
  const flow = await k.createFlow({ name: 'Coconut Reset — Digital Delivery (RSC)', definition });
  state.flowId = flow.id;
  saveState(state);
  console.log(`✓ flow ${flow.id} created (flow: ${flow.status}, message: ${sendStatus})`);

  if (flowStatus === 'live') {
    const live = await k.updateFlowStatus(flow.id, 'live');
    console.log(`  flow status -> ${live.status}`);
  }
  return flow.id;
}

async function cmdVerify() {
  const state = loadState();
  if (!state.flowId) throw new Error('no flowId');
  const v = await verifyFlow(state.flowId);
  console.log(`Flow ${state.flowId} status: ${v.status} | messages: ${v.sends.map((s) => s.status).join(',') || '(none)'}`);
  console.log(`Issues: ${v.issues.length ? v.issues.join('; ') : 'NONE'}`);
  for (const a of v.graph) {
    let label = a.type;
    if (a.type === 'send-email') label += `  "${a.data.message.subject_line}"`;
    if (a.type === 'trigger-split') label += `  Items∈[${a.data.trigger_filter.condition_groups[0].conditions.map((c) => c.filter.value).join(',')}]`;
    const nx = a.links.next ?? `T:${a.links.next_if_true}/F:${a.links.next_if_false}`;
    console.log(`  ${String(a.id).padEnd(12)} ${label.padEnd(52)} -> ${nx}`);
  }
}

async function cmdRender() {
  const state = loadState();
  if (!state.templateId) throw new Error('run `template` first');
  const ctx = { first_name: 'Sarah', organization: { name: 'Real Skin Care' } };
  const r = await k.renderTemplate(state.templateId, ctx);
  writeFileSync(`${SCRATCH}/flow-reset-delivery.html`, r.html);
  console.log(`rendered -> flow-reset-delivery.html (${r.html.length}b)`);
}

const cmd = process.argv[2];
const run = {
  template: cmdTemplate,
  flow: () => buildFlow('draft', 'draft'),
  golive: () => buildFlow('live', 'live'),
  verify: cmdVerify,
  render: cmdRender,
}[cmd];
if (!run) { console.log('Usage: node build-reset-delivery.mjs <template|flow|golive|verify|render>'); process.exit(1); }
run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
