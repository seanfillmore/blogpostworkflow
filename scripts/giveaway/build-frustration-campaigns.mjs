/**
 * Build the four pre-draw, full-price segment sends.
 *
 *   node scripts/giveaway/build-frustration-campaigns.mjs             # preview — renders to disk, NO API calls
 *   node scripts/giveaway/build-frustration-campaigns.mjs segments    # create/reuse the 4 Klaviyo segments
 *   node scripts/giveaway/build-frustration-campaigns.mjs templates   # upsert the 4 templates
 *   node scripts/giveaway/build-frustration-campaigns.mjs campaigns   # create the 4 campaigns (DRAFT)
 *
 * Copy, gates and segment definitions live in lib/giveaway/frustration-campaigns.js. This
 * file is I/O only, the same split as lib/giveaway/nurture-schedule.js against
 * build-nurture-flow.mjs — so the gates stay testable without stubbing Klaviyo.
 *
 * ── THIS SCRIPT NEVER SENDS ─────────────────────────────────────────────────────────
 *
 * `campaigns` mode leaves all four in DRAFT, deliberately. A campaign created through the
 * API queues NO send job: the send date is stored and the campaign looks scheduled in
 * every view except the one that governs whether it goes out. That trap has already cost
 * this project one silent miss (the two deadline campaigns) and is currently sitting live
 * under the three consolation drafts. Scheduling stays a deliberate human action in the
 * Klaviyo UI, and this script prints exactly which campaigns are waiting on it.
 *
 * ── SMART SENDING IS LEFT ON, ON PURPOSE ────────────────────────────────────────────
 *
 * These land while the nurture flow is still running, so a recipient who received a
 * nurture email in the previous 16 hours will be skipped. That is the correct trade —
 * two emails in one morning costs more in unsubscribes than one skipped recipient costs
 * in orders. But it does mean the campaign's recipient count will read LOWER than the
 * segment size, and that gap is a skip, not a smaller audience. Read `recipients` against
 * segment `profile_count` when measuring, or the send looks like it under-delivered.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { klaviyoRequest, upsertTemplateByName, createCampaign, assignTemplateToCampaignMessage } from '../../lib/klaviyo.js';
import { FROM } from '../flows/klaviyo-graph.js';
import { SEGMENTS, renderFrustrationEmail, segmentDefinition } from '../../lib/giveaway/frustration-campaigns.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'giveaway.json');
const OUT_DIR = join(ROOT, 'data', 'giveaway', 'frustration');

/**
 * Day 14 of the entry window (opened 2026-08-18), inside the day 12-15 band spec §7.1
 * named. 14:00Z is 07:00 PT, the same send hour the deadline campaigns use. Clear of the
 * weekend and of Labor Day (2026-09-07).
 */
const SEND_AT = '2026-09-01T14:00:00+00:00';

const mode = process.argv[2] || 'preview';
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

function saveConfig() {
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

config.frustrationCampaigns ||= { sendAt: SEND_AT, segments: {}, templates: {}, campaigns: {} };
const store = config.frustrationCampaigns;

const segName = (s) => `Giveaway 2026-09 — Frustration: ${s.label}`;
const tplName = (s) => `Giveaway Frustration — ${s.label}`;

/** Reuse a segment with this exact name rather than creating a second one that shadows it. */
async function findSegmentByName(name) {
  const d = await klaviyoRequest('GET', `/segments/?filter=equals(name,"${name.replace(/"/g, '\\"')}")`);
  return d.data?.[0]?.id || null;
}

async function upsertSegment(spec) {
  const name = segName(spec);
  const existing = await findSegmentByName(name);
  if (existing) return { id: existing, reused: true };
  const d = await klaviyoRequest('POST', '/segments/', {
    data: { type: 'segment', attributes: { name, definition: segmentDefinition(spec.key) } },
  });
  return { id: d.data.id, reused: false };
}

// ---------------------------------------------------------------------------

if (mode === 'preview') {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Rendering all four (gates run here — a failure stops the build):\n');
  for (const spec of SEGMENTS) {
    const html = renderFrustrationEmail(spec);
    const path = join(OUT_DIR, `${spec.key}.html`);
    writeFileSync(path, html);
    console.log(`  ${spec.key.padEnd(12)} ${String(html.length).padStart(6)} bytes  ->  data/giveaway/frustration/${spec.key}.html`);
    console.log(`  ${''.padEnd(12)} subject: ${spec.subject}`);
  }
  console.log('\nNo API calls made. Open the files above to review the copy.');
  console.log(`Would send: ${SEND_AT} (07:00 PT, day 14 of the entry window).`);

} else if (mode === 'segments') {
  console.log('Creating/reusing the four segments...\n');
  for (const spec of SEGMENTS) {
    const { id, reused } = await upsertSegment(spec);
    store.segments[spec.key] = id;
    console.log(`  ${spec.key.padEnd(12)} ${id}  ${reused ? '(reused)' : '(created)'}  gv_frustration = "${spec.key}"`);
  }
  saveConfig();
  console.log('\nSegment ids written to config/giveaway.json.');
  console.log('Counts populate asynchronously — re-read profile_count in a minute, not immediately.');

} else if (mode === 'templates') {
  console.log('Upserting the four templates...\n');
  for (const spec of SEGMENTS) {
    const html = renderFrustrationEmail(spec);
    const t = await upsertTemplateByName(tplName(spec), html);
    store.templates[spec.key] = t.id;
    console.log(`  ${spec.key.padEnd(12)} template ${t.id}`);
  }
  saveConfig();
  console.log('\nTemplate ids written to config/giveaway.json.');

} else if (mode === 'campaigns') {
  const missing = SEGMENTS.filter((s) => !store.segments[s.key] || !store.templates[s.key]);
  if (missing.length) {
    throw new Error(`run \`segments\` and \`templates\` first — missing: ${missing.map((s) => s.key).join(', ')}`);
  }

  console.log('Creating the four campaigns (all DRAFT)...\n');
  for (const spec of SEGMENTS) {
    const campaign = await createCampaign({
      name: `Giveaway — ${spec.label} (${SEND_AT.slice(0, 10)})`,
      audienceId: store.segments[spec.key],
      sendAt: SEND_AT,
      subject: spec.subject,
      preview: spec.preheader,
      fromEmail: FROM.from_email,
      fromLabel: FROM.from_label,
      messageLabel: `Giveaway Frustration — ${spec.label}`,
    });

    // Without this the message exists and renders empty, and Klaviyo says nothing.
    const messageId = campaign.messageIds?.[0];
    if (!messageId) throw new Error(`campaign ${campaign.id} came back with no campaign-message`);
    await assignTemplateToCampaignMessage(messageId, store.templates[spec.key]);

    store.campaigns[spec.key] = { id: campaign.id, messageId, sendAt: SEND_AT };
    console.log(`  ${spec.key.padEnd(12)} campaign ${campaign.id}  ->  segment ${store.segments[spec.key]}`);
  }
  saveConfig();

  console.log('\nAll four are DRAFT and will NOT send on their own.');
  console.log('>>> MANUAL STEP: open each campaign in Klaviyo and click Schedule. Creating a');
  console.log('    campaign via the API stores the send date but queues no send job. <<<\n');
  for (const spec of SEGMENTS) console.log(`    ${store.campaigns[spec.key].id}   Giveaway — ${spec.label}`);

} else {
  throw new Error(`unknown mode: ${mode} (preview | segments | templates | campaigns)`);
}
