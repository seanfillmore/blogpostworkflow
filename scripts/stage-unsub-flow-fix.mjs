#!/usr/bin/env node
/**
 * Stage the unsubscribe-tag repair for every live flow email that carries the broken
 * `href="{% unsubscribe %}"`.
 *
 * READ-ONLY against Klaviyo. Writes data/brand/email-rebuild/<id>.{before,after}.html
 * so scripts/klaviyo-push-flow-template.mjs can do the actual push with its own
 * backup / drift-refusal / verify-through-the-consumer / rollback machinery.
 *
 * The AFTER is the LIVE body with exactly one token changed. It is deliberately not
 * the repo's data/giveaway/nurture/*.html: those files are the build input, the live
 * templates have since been rendered and pushed, and pushing the repo copy would
 * carry every unrelated difference along with the fix. One token is auditable; a
 * whole-file replacement is not.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFlows, listFlowActionsWithDefinition, getFlowAction, getFlowMessageTemplate } from '../lib/klaviyo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/brand/email-rebuild');
const BROKEN = /href="\{%\s*unsubscribe\s*%\}"/g;

mkdirSync(DIR, { recursive: true });
const staged = [];

for (const f of await listFlows()) {
  for (const a of (await listFlowActionsWithDefinition(f.id)).filter((x) => x.definition?.type === 'send-email')) {
    const full = await getFlowAction(a.id);
    const msgId = full.definition?.data?.message?.id ?? full.definition?.data?.message;
    const tpl = await getFlowMessageTemplate(msgId);
    const html = tpl.html ?? '';
    const hits = (html.match(BROKEN) ?? []).length;
    if (!hits) continue;
    const after = html.replace(BROKEN, 'href="{% unsubscribe_link %}"');
    if (after === html) throw new Error(`${tpl.id}: replacement was a no-op`);
    writeFileSync(join(DIR, `${tpl.id}.before.html`), html);
    writeFileSync(join(DIR, `${tpl.id}.after.html`), after);
    staged.push({ templateId: tpl.id, name: tpl.name, flow: f.id, occurrences: hits, delta: after.length - html.length });
  }
}

for (const s of staged) console.log(`${s.templateId}  ${String(s.occurrences).padStart(2)}×  +${s.delta}b  ${s.name}`);
console.log(`\nstaged ${staged.length} template(s)`);
console.log(staged.map((s) => s.templateId).join(' '));
