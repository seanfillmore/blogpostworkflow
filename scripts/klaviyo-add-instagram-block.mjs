#!/usr/bin/env node
/**
 * One-off (2026-11-04, Sean-approved): add the "Come say hi on Instagram" block to
 * Post-Purchase 01 Thank You and 02 How To Use It, and strip every em/en dash from 01.
 *
 *   node scripts/klaviyo-add-instagram-block.mjs            # dry run: prints the planned HTML diff
 *   node scripts/klaviyo-add-instagram-block.mjs --apply    # write live
 *
 * Edits are applied to the CURRENT live flow-owned HTML, not to a rebuild from
 * data/brand/email-rebuild/specs.js, so nothing else in the email changes. Every edit
 * is a literal replacement asserted to match exactly once; a miss aborts before any
 * write.
 *
 * Order (same as scripts/klaviyo-push-flow-template.mjs): back up the serving HTML and
 * the message definition to BACKUP_DIR, validate the new HTML through Klaviyo's
 * renderer, create a LIBRARY template, repoint the flow action's template_id at it
 * (Klaviyo snapshots it into a new flow-owned copy), then READ BACK through
 * /flow-messages/{id}/template and verify. A failed verify repoints back to the
 * original template id.
 *
 * Backups go to /tmp, not data/reports/, because data/reports/klaviyo-backups is not
 * gitignored.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTemplate,
  renderTemplate,
  updateFlowActionMessage,
  getFlowAction,
  getFlowMessageTemplate,
} from '../lib/klaviyo.js';
import { unsubscribeFindings } from '../lib/email-rebuild-checks.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { IG, BLOCK_COPY, INSTAGRAM_FOLLOW_BLOCK as BLOCK_HTML } from '../lib/instagram-follow-block.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = process.env.KLAVIYO_BACKUP_DIR || '/tmp/klaviyo-backups';
const DATE = new Date().toISOString().slice(0, 10);

// Insert immediately before the sign-off paragraph: after the email's main content,
// still inside the white card, above "Take care, Sean" and the footer.
const SIGNOFF = /<p style="margin:0 0 6px;[^"]*">\s*Take care,/g;

/** Literal [before, after] pairs for 01. Each must occur exactly once. */
const DASH_EDITS_01 = [
  ['Thank you — and one thing to expect', 'Thank you, and one thing to expect'],
  ['Hi {{ first_name|default:"there" }} — your order', 'Hi {{ first_name|default:"there" }}, your order'],
  ['<strong>1–2 weeks</strong>', '<strong>1 to 2 weeks</strong>'],
  ['at first — that is your sweat glands', 'at first. That is your sweat glands'],
  ['<strong>PS —</strong>', '<strong>PS:</strong>'],
  ['Unsubscribe here — no hard feelings.', 'Unsubscribe here, no hard feelings.'],
];
const PREVIEW_EDIT_01 = ["Your order's on the way — here's", "Your order's on the way. Here's"];

export const TARGETS = [
  { label: '01 Thank You', messageId: 'SDt8Hg', actionId: '112411003', dashEdits: DASH_EDITS_01, previewEdit: PREVIEW_EDIT_01, noDashes: true },
  { label: '02 How To Use It', messageId: 'TNRXB8', actionId: '112411005', dashEdits: [], previewEdit: null, noDashes: false },
];

function replaceOnce(html, before, after, label) {
  const n = html.split(before).length - 1;
  if (n !== 1) throw new Error(`${label}: expected exactly 1 occurrence of ${JSON.stringify(before)}, found ${n}`);
  return html.replace(before, after);
}

export function applyEdits(html, t) {
  let out = html;
  for (const [b, a] of t.dashEdits) out = replaceOnce(out, b, a, t.label);
  if (out.includes('data-rsc-block="instagram-follow"') || /instagram-follow/.test(out)) {
    throw new Error(`${t.label}: block already present`);
  }
  const hits = [...out.matchAll(SIGNOFF)];
  if (hits.length !== 1) throw new Error(`${t.label}: expected 1 sign-off anchor, found ${hits.length}`);
  out = out.slice(0, hits[0].index) + BLOCK_HTML + out.slice(hits[0].index);
  return out;
}

export function verifyHtml(html, t) {
  const problems = [];
  const blockCount = (html.match(/Come say hi on Instagram/g) || []).length;
  if (blockCount !== 1) problems.push(`block heading appears ${blockCount} times`);
  if (!html.includes(`href="${IG}"`)) problems.push('Instagram href missing');
  if (!html.includes('href="{% unsubscribe_link %}"')) problems.push('unsubscribe_link href missing');
  const unsub = unsubscribeFindings(html);
  if (unsub.length) problems.push(`unsubscribe findings: ${JSON.stringify(unsub)}`);
  if (t.noDashes && /[–—]/.test(html)) problems.push('em/en dash still present');
  return problems;
}

/** Line diff on whitespace-trimmed lines; enough to show what moved in a template. */
export function lineDiff(a, b) {
  const A = a.split('\n').map((l) => l.trim()).filter(Boolean);
  const B = b.split('\n').map((l) => l.trim()).filter(Boolean);
  const setA = new Set(A); const setB = new Set(B);
  return { removed: A.filter((l) => !setB.has(l)), added: B.filter((l) => !setA.has(l)) };
}

async function run() {
  const gate = checkSeoCopyFields({ ...BLOCK_COPY, 'preview 01': PREVIEW_EDIT_01[1] });
  console.log(`gate: ok=${gate.ok} blocking=${gate.blocking.length} advisory=${gate.advisory.length}`);
  if (!gate.ok) throw new Error('health gate blocked the block copy');

  mkdirSync(BACKUP_DIR, { recursive: true });
  const plans = [];
  for (const t of TARGETS) {
    const live = await getFlowMessageTemplate(t.messageId);
    const action = await getFlowAction(t.actionId);
    const msg = action.definition?.data?.message;
    if (msg?.template_id !== live.id) throw new Error(`${t.label}: action ${t.actionId} template_id ${msg?.template_id} != serving ${live.id}`);
    writeFileSync(join(BACKUP_DIR, `${DATE}-${t.messageId}.html`), live.html);
    writeFileSync(join(BACKUP_DIR, `${DATE}-${t.messageId}.message.json`), JSON.stringify(msg, null, 2));
    const next = applyEdits(live.html, t);
    const problems = verifyHtml(next, t);
    if (problems.length) throw new Error(`${t.label}: planned HTML fails: ${problems.join('; ')}`);
    let preview = msg.preview_text;
    if (t.previewEdit) preview = replaceOnce(preview, t.previewEdit[0], t.previewEdit[1], `${t.label} preview`);
    plans.push({ t, live, msg, next, preview });
    const d = lineDiff(live.html, next);
    console.log(`\n== ${t.label} (${t.messageId}, serving ${live.id}) backup ${join(BACKUP_DIR, `${DATE}-${t.messageId}.html`)}`);
    console.log(` -${d.removed.length} +${d.added.length} lines`);
    for (const l of d.removed) console.log(`  - ${l}`);
    for (const l of d.added) console.log(`  + ${l}`);
    if (preview !== msg.preview_text) console.log(`  preview: ${JSON.stringify(msg.preview_text)} -> ${JSON.stringify(preview)}`);
  }
  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to write.'); return; }

  for (const { t, live, msg, next, preview } of plans) {
    const created = await createTemplate({ name: `Post-Purchase ${t.label} (IG block ${DATE})`, html: next });
    const libId = created.id ?? created.data?.id;
    await renderTemplate(libId, { first_name: 'Test', event: { Items: ['Coconut Oil Deodorant'] } });
    const patch = { template_id: libId };
    if (preview !== msg.preview_text) patch.preview_text = preview;
    await updateFlowActionMessage(t.actionId, patch);
    const back = await getFlowMessageTemplate(t.messageId);
    const action = await getFlowAction(t.actionId);
    const backMsg = action.definition.data.message;
    const problems = verifyHtml(back.html, t);
    for (const k of Object.keys(msg)) {
      if (k === 'template_id' || k === 'preview_text') continue;
      if (JSON.stringify(msg[k]) !== JSON.stringify(backMsg[k])) problems.push(`message field ${k} changed`);
    }
    if (backMsg.preview_text !== preview) problems.push('preview text not as intended');
    if (problems.length) {
      console.error(`✗ ${t.label}: verify failed (${problems.join('; ')}); rolling back to ${live.id}`);
      await updateFlowActionMessage(t.actionId, { template_id: live.id, preview_text: msg.preview_text });
      process.exitCode = 1;
      continue;
    }
    writeFileSync(join(BACKUP_DIR, `${DATE}-${t.messageId}.after.html`), back.html);
    const d = lineDiff(live.html, back.html);
    console.log(`\n✓ ${t.label}: library ${libId} -> serving ${back.id}; action status ${action.status ?? 'n/a'}; vs backup -${d.removed.length} +${d.added.length} lines`);
  }
}

if (isDirectRun(import.meta.url)) run().catch((e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
