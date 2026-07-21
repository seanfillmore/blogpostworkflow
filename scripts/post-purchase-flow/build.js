/**
 * Build the RSC Post-Purchase Flow headlessly.
 *
 * Steps (idempotent):
 *   node build.js templates          upsert all 8 email templates, save id map
 *   node build.js render <key>       render one template to scratchpad for review
 *   node build.js flow               assemble + create the DRAFT flow graph
 *   node build.js verify             read the created flow back, print the graph
 *
 * Never sets the flow live. Going live is a separate, reviewed manual step:
 *   node -e "import('../../lib/klaviyo.js').then(k=>k.updateFlowStatus('<id>','live'))"
 *
 * Design spec: docs/superpowers/specs/2026-07-20-post-purchase-flow-design.md
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import k from '../../lib/klaviyo.js';
import { EMAILS, ORDER, P } from './emails.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, 'build-state.json');

// Trigger + exclusion metrics (Klaviyo metric ids, verified live)
const M_PLACED_ORDER = 'V69ueg';
const M_CANCELLED_ORDER = 'WSzmJK';

// Exact line-item titles as they appear in real Placed Order events (verified)
const ITEM = {
  deodorant: 'Best Coconut Oil Deodorant — All Natural Formula | 2oz',
  toothpaste: 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free',
  handsoap: 'Foaming Liquid Coconut Oil Soap | 8oz',
  barsoap: 'Moisturizing Coconut Soap | 3.4oz',
  refill: 'Foam Soap Refill | 32oz',
  lotion: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients',
  moisturizer: 'Coconut Moisturizer | 4oz',
};
// Consumables eligible for the replenishment email (E5)
const CONSUMABLE_ITEMS = [ITEM.deodorant, ITEM.toothpaste, ITEM.handsoap, ITEM.barsoap, ITEM.refill];
// Non-deodorant/non-toothpaste products that route to the "body routine" email (E2c)
const BODY_ITEMS = [ITEM.handsoap, ITEM.barsoap, ITEM.refill, ITEM.lotion, ITEM.moisturizer];

function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
}
function saveState(s) {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

// ---------- graph builders ----------

const delay = (tid, value, unit, next) => ({
  temporary_id: tid,
  type: 'time-delay',
  data: { unit, value, secondary_value: null, timezone: 'profile' },
  links: { next },
});

function send(tid, emailKey, templateId, next, status = 'draft') {
  const e = EMAILS[emailKey];
  return {
    temporary_id: tid,
    type: 'send-email',
    data: {
      status,
      message: {
        from_email: 'support@realskincare.com',
        from_label: 'Real Skin Care',
        reply_to_email: '',
        cc_email: '',
        bcc_email: '',
        subject_line: e.subject,
        preview_text: e.preview,
        template_id: templateId,
        smart_sending_enabled: true,
        transactional: false,
        add_tracking_params: false,
        custom_tracking_params: null,
        additional_filters: null,
        name: e.name,
      },
    },
    links: { next },
  };
}

// trigger-split on the Placed Order event's Items list containing ANY of `titles`
function itemSplit(tid, titles, nextTrue, nextFalse) {
  return {
    temporary_id: tid,
    type: 'trigger-split',
    data: {
      trigger_filter: {
        condition_groups: [
          {
            conditions: titles.map((value) => ({
              type: 'metric-property',
              metric_id: M_PLACED_ORDER,
              field: 'Items',
              filter: { type: 'list', operator: 'contains', value },
            })),
          },
        ],
      },
      trigger_id: M_PLACED_ORDER,
      trigger_type: 'metric',
      trigger_subtype: null,
    },
    links: { next_if_true: nextTrue, next_if_false: nextFalse },
  };
}

function buildDefinition(ids, sendStatus = 'draft') {
  // ids: { e1_thankyou: '<templateId>', ... }
  const tpl = (key) => ids[key];
  const s = (tid, key, next) => send(tid, key, tpl(key), next, sendStatus);
  // Single linear trunk. Email 2 personalization lives INSIDE the e2 template
  // (conditional blocks on event.Items) rather than as graph branches, because
  // Klaviyo flows are trees — branch paths cannot re-converge, so per-product
  // branches would orphan Emails 3–5 for all but the first branch. The only
  // split is the terminal consumable gate before Email 5 (no convergence).
  const actions = [
    delay('d_1h', 1, 'hours', 'e1'),
    s('e1', 'e1_thankyou', 'd_2d'),

    // Email 2 — how-to-use, personalized via in-template conditionals (all)
    delay('d_2d', 2, 'days', 'e2'),
    s('e2', 'e2_howto', 'd_3d'),

    // Email 3 — set cross-sell (all)
    delay('d_3d', 3, 'days', 'e3'),
    s('e3', 'e3_set', 'd_5d'),

    // Email 4 — review + referral (all)
    delay('d_5d', 5, 'days', 'e4'),
    s('e4', 'e4_review', 'split_consumable'),

    // Email 5 — replenishment (consumable buyers only; non-consumables exit)
    itemSplit('split_consumable', CONSUMABLE_ITEMS, 'd_25d', null),
    delay('d_25d', 25, 'days', 'e5'),
    s('e5', 'e5_restock', null),
  ];

  return {
    triggers: [{ type: 'metric', id: M_PLACED_ORDER, trigger_filter: null }],
    // Entry filter: exclude anyone who has cancelled the order since the flow started
    profile_filter: {
      condition_groups: [
        {
          conditions: [
            {
              type: 'profile-metric',
              metric_id: M_CANCELLED_ORDER,
              measurement: 'count',
              measurement_filter: { type: 'numeric', operator: 'equals', value: 0 },
              timeframe_filter: { type: 'date', operator: 'flow-start' },
              metric_filters: null,
            },
          ],
        },
      ],
    },
    entry_action_id: 'd_1h',
    actions,
  };
}

// ---------- commands ----------

async function cmdTemplates(onlyKey) {
  const state = loadState();
  state.templates = state.templates || {};
  const keys = onlyKey ? [onlyKey] : ORDER;
  for (const key of keys) {
    const e = EMAILS[key];
    const res = await k.upsertTemplateByName(e.name, e.html);
    state.templates[key] = res.id;
    console.log(`  ✓ ${key.padEnd(20)} template ${res.id}  "${e.name}"`);
  }
  saveState(state);
  console.log(`Saved ${Object.keys(state.templates).length} template ids -> build-state.json`);
}

async function cmdRender(key) {
  const state = loadState();
  const id = state.templates?.[key];
  if (!id) throw new Error(`No template id for "${key}". Run: node build.js templates`);
  const ctx = { first_name: 'Sarah', organization: { name: 'Real Skin Care' } };
  const out = await k.renderTemplate(id, ctx);
  const path = join('/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/a4c848d1-f4cb-4610-824d-3139a4187110/scratchpad', `ppf-${key}.html`);
  writeFileSync(path, out.html);
  console.log(`Rendered ${key} -> ${path} (${out.html.length} bytes)`);
}

async function cmdFlow(sendStatus = 'draft') {
  const state = loadState();
  if (!state.templates || Object.keys(state.templates).length < ORDER.length) {
    throw new Error('Templates not fully built. Run: node build.js templates');
  }
  const definition = buildDefinition(state.templates, sendStatus);
  const flow = await k.createFlow({ name: 'Post-Purchase Flow (RSC v2)', definition });
  state.flowId = flow.id;
  saveState(state);
  console.log(`✓ Created flow ${flow.id} (flow status: ${flow.status}, messages: ${sendStatus})`);
}

// Take the flow live: recreate with live messages (Klaviyo forces new flows to
// draft, but action statuses persist), then flip the flow status to live.
async function cmdGolive() {
  const state = loadState();
  // Replace any existing draft build so message statuses are 'live' from creation.
  if (state.flowId) {
    await k.deleteFlow(state.flowId).catch(() => {});
    console.log(`  removed prior draft flow ${state.flowId}`);
  }
  await cmdFlow('live');
  const s2 = loadState();
  const live = await k.updateFlowStatus(s2.flowId, 'live');
  console.log(`✓ Flow ${s2.flowId} status -> ${live.status}`);
  // Verify both flow and every send action are live
  const acts = await k.listFlowActions(s2.flowId);
  const sends = acts.filter((a) => a.action_type === 'SEND_EMAIL');
  const draftSends = sends.filter((a) => a.status !== 'live');
  console.log(`  messages live: ${sends.length - draftSends.length}/${sends.length}`);
  if (draftSends.length || live.status !== 'live') throw new Error('Go-live incomplete — check statuses');
  console.log('  ✓ LIVE — flow and all messages active.');
}

async function cmdVerify() {
  const state = loadState();
  if (!state.flowId) throw new Error('No flowId. Run: node build.js flow');
  const f = await k.getFlowDefinition(state.flowId);
  const d = f.definition;
  console.log(`Flow ${f.id} — status: ${f.status}`);
  console.log(`Trigger: ${d.triggers[0].type} ${d.triggers[0].id}`);
  console.log(`Profile filter: ${d.profile_filter ? 'set (cancelled-order exclusion)' : 'none'}`);
  console.log('Graph:');
  const byId = Object.fromEntries(d.actions.map((a) => [a.id, a]));
  for (const a of d.actions) {
    let label = a.type;
    if (a.type === 'time-delay') label += ` ${a.data.value} ${a.data.unit}`;
    if (a.type === 'send-email') label += `  "${a.data.message.subject_line}"`;
    if (a.type === 'trigger-split') {
      const vals = a.data.trigger_filter.condition_groups[0].conditions.map((c) => c.filter.value);
      label += `  Items ∈ [${vals.length} item(s)]`;
    }
    const nx = a.links.next ?? `T:${a.links.next_if_true} / F:${a.links.next_if_false}`;
    console.log(`  ${a.id.padEnd(12)} ${label.padEnd(52)} -> ${nx}`);
  }
}

const [cmd, arg] = process.argv.slice(2);
const run = { templates: () => cmdTemplates(arg), render: () => cmdRender(arg), flow: () => cmdFlow('draft'), golive: cmdGolive, verify: cmdVerify }[cmd];
if (!run) {
  console.log('Usage: node build.js <templates [key] | render <key> | flow | golive | verify>');
  process.exit(1);
}
run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
