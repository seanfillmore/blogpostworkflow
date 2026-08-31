/**
 * Generic builder for RSC Klaviyo flow rebuilds.
 *
 *   node build.js <flow> templates            upsert all templates for <flow>
 *   node build.js <flow> render <key> [items] render one email (items = comma product titles)
 *   node build.js <flow> flow                 create DRAFT flow (messages draft)
 *   node build.js <flow> verify               verify built flow
 *   node build.js <flow> golive               recreate w/ live messages, set live, draft the OLD flow
 *
 * Each flow module (./flows/<flow>.js) exports:
 *   { name, oldFlowId, entry, emails:{key:{name,subject,preview,html}}, actions(t,helpers,sendStatus) }
 * Reuses the OLD flow's exact triggers + profile_filter (preserves enrollment logic).
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import k from '../../lib/klaviyo.js';
import { send, delay, itemSplit, verifyFlow, resolveEnrollment, isNetNew } from './klaviyo-graph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, 'build-state.json');
const SCRATCH = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/a4c848d1-f4cb-4610-824d-3139a4187110/scratchpad';
const helpers = { send, delay, itemSplit };

const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const saveState = (s) => writeFileSync(STATE, JSON.stringify(s, null, 2));

async function loadFlow(name) {
  const mod = await import(`./flows/${name}.js`);
  return mod.default;
}

async function upsertTemplates(flowName, mod) {
  const state = loadState();
  state[flowName] = state[flowName] || {};
  state[flowName].templates = state[flowName].templates || {};
  for (const [key, e] of Object.entries(mod.emails)) {
    const res = await k.upsertTemplateByName(e.name, e.html);
    state[flowName].templates[key] = res.id;
    console.log(`  ✓ ${key.padEnd(16)} ${res.id}  "${e.name}"`);
  }
  saveState(state);
  return state[flowName].templates;
}

function buildDefinition(mod, templateIds, triggers, profileFilter, sendStatus) {
  const t = (key) => {
    const id = templateIds[key];
    if (!id) throw new Error(`missing template id for ${key}`);
    return id;
  };
  const msg = (key) => ({ ...mod.emails[key], template_id: t(key) });
  const actions = mod.actions(msg, helpers, sendStatus);
  return { triggers, profile_filter: profileFilter, entry_action_id: mod.entry, actions };
}

async function cmdFlow(flowName, mod, sendStatus = 'draft') {
  const state = loadState();
  const templateIds = state[flowName]?.templates;
  if (!templateIds || Object.keys(templateIds).length < Object.keys(mod.emails).length) throw new Error('Run templates first');
  // Flows clone templates at creation, so a rebuild is the only way to refresh
  // content. Delete any prior draft of ours first so re-running is idempotent.
  if (state[flowName]?.flowId) { await k.deleteFlow(state[flowName].flowId).catch(() => {}); console.log(`  removed prior draft ${state[flowName].flowId}`); }
  const oldDef = isNetNew(mod) ? null : (await k.getFlowDefinition(mod.oldFlowId)).definition;
  const { triggers, profileFilter } = resolveEnrollment(mod, oldDef);
  const def = buildDefinition(mod, templateIds, triggers, profileFilter, sendStatus);
  const flow = await k.createFlow({ name: mod.name, definition: def });
  state[flowName].flowId = flow.id;
  saveState(state);
  console.log(`✓ Created flow ${flow.id} (flow: ${flow.status}, messages: ${sendStatus})`);
  return flow.id;
}

async function cmdVerify(flowName) {
  const state = loadState();
  const id = state[flowName]?.flowId;
  if (!id) throw new Error('no flowId — run flow');
  const v = await verifyFlow(id);
  console.log(`Flow ${id} status: ${v.status} | messages: ${v.sends.map((s) => s.status).join(',')}`);
  console.log(`Issues: ${v.issues.length ? v.issues.join('; ') : 'NONE'}`);
  for (const a of v.graph) {
    let label = a.type;
    if (a.type === 'time-delay') label += ` ${a.data.value} ${a.data.unit}`;
    if (a.type === 'send-email') label += `  "${a.data.message.subject_line}"`;
    if (a.type === 'trigger-split') label += `  Items∈[${a.data.trigger_filter.condition_groups[0].conditions.length}]`;
    const nx = a.links.next ?? `T:${a.links.next_if_true}/F:${a.links.next_if_false}`;
    console.log(`  ${a.id.padEnd(12)} ${label.padEnd(50)} -> ${nx}`);
  }
  return v;
}

async function cmdGolive(flowName, mod) {
  const state = loadState();
  if (state[flowName]?.flowId) { await k.deleteFlow(state[flowName].flowId).catch(() => {}); console.log(`  removed prior draft ${state[flowName].flowId}`); }

  // Which flow does this go-live REPLACE? Resolved by name against live Klaviyo,
  // never from mod.oldFlowId alone.
  //
  // mod.oldFlowId is correct exactly once. The first go-live retires it and puts
  // a NEW flow live under the same name; from then on the hardcoded id names a
  // flow that no longer exists, `updateFlowStatus` on it is a no-op or a 404,
  // and the genuinely-live flow is never retired. The result is TWO live flows
  // with the same trigger, both sending — the exact double-send the retire step
  // exists to prevent, arrived at silently. Measured 2026-08-31: all five
  // oldFlowId values on this account pointed at deleted flows, and three had a
  // live namesake.
  const preexistingLive = await k.liveFlowIdsByName(mod.name);
  const retireIds = preexistingLive.length ? preexistingLive : (mod.oldFlowId ? [mod.oldFlowId] : []);
  console.log(`  will retire after go-live: ${retireIds.length ? retireIds.join(', ') : '(nothing live under this name)'}`);

  const id = await cmdFlow(flowName, mod, 'live');
  const live = await k.updateFlowStatus(id, 'live');
  const v = await verifyFlow(id);
  const draftSends = v.sends.filter((s) => s.status !== 'live');
  if (live.status !== 'live' || draftSends.length || v.issues.length) throw new Error(`go-live incomplete: status=${live.status} draftSends=${draftSends.length} issues=${v.issues.join(';')}`);

  for (const oldId of retireIds) {
    if (oldId === id) continue;
    await k.updateFlowStatus(oldId, 'draft').catch((e) => { throw new Error(`new flow ${id} is LIVE but retiring ${oldId} failed (${e.message}) — two live flows may be double-sending, fix by hand now`); });
    console.log(`  retired ${oldId} → draft`);
  }

  // Assert the end state rather than trusting the writes: exactly this flow,
  // live, under this name.
  const stragglers = await k.liveFlowIdsByName(mod.name, { exceptId: id });
  if (stragglers.length) throw new Error(`${stragglers.length} other flow(s) still LIVE as "${mod.name}": ${stragglers.join(', ')} — double-send risk, retire by hand`);

  console.log(`✓ ${flowName} LIVE (${id}); retired ${retireIds.filter((x) => x !== id).length} old flow(s). Messages: ${v.sends.length}/${v.sends.length} live.`);
}

async function cmdRender(flowName, key, itemsCsv) {
  const state = loadState();
  const id = state[flowName]?.templates?.[key];
  if (!id) throw new Error(`no template for ${key}`);
  const items = itemsCsv ? itemsCsv.split('||') : [];
  const ctx = { first_name: 'Sarah', organization: { name: 'Real Skin Care' }, event: { Items: items, Name: items[0] || 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free', URL: 'https://www.realskincare.com/products/coconut-oil-toothpaste', ImageURL: 'https://www.realskincare.com/cdn/shop/products/AMZ_RealSkin_Toothpaste-Hero-Mint_JRA_2000x2000_002B_grande.jpg', Price: '13.00' } };
  const r = await k.renderTemplate(id, ctx);
  writeFileSync(`${SCRATCH}/flow-${flowName}-${key}.html`, r.html);
  console.log(`rendered ${flowName}/${key} -> flow-${flowName}-${key}.html (${r.html.length}b)`);
}

const [flowName, cmd, arg, arg2] = process.argv.slice(2);
if (!flowName || !cmd) { console.log('Usage: node build.js <flow> <templates|render <key>|flow|verify|golive>'); process.exit(1); }
const mod = await loadFlow(flowName);
const run = {
  templates: () => upsertTemplates(flowName, mod),
  render: () => cmdRender(flowName, arg, arg2),
  flow: () => cmdFlow(flowName, mod, 'draft'),
  verify: () => cmdVerify(flowName),
  golive: () => cmdGolive(flowName, mod),
}[cmd];
if (!run) { console.log('unknown command', cmd); process.exit(1); }
run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
