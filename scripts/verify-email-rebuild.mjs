#!/usr/bin/env node
/**
 * Verify a rebuilt Klaviyo email before it is pasted into production.
 *
 *   node scripts/verify-email-rebuild.mjs SCxShR
 *   node scripts/verify-email-rebuild.mjs --all
 *
 * Reads data/brand/email-rebuild/<id>.before.html and .after.html and checks that the
 * rebuild is a RESTYLE, not a rewrite:
 *
 *   1. every Klaviyo tag survives            — a dropped {% coupon_code %} ships a
 *                                              broken offer; a dropped {% unsubscribe %}
 *                                              is a CAN-SPAM violation
 *   2. no link is lost                       — under --redesign this softens to a warning
 *                                              for marketing links, because the format
 *                                              matrix mandates at most two destinations
 *                                              and several templates carry 10-11. The
 *                                              compliance set (unsubscribe, preferences,
 *                                              policies) still fails hard in every mode.
 *   3. copy is identical                     — so a performance change is attributable
 *                                              to design, not new words
 *   4. every colour is on-palette
 *   5. the postal address survives           — CAN-SPAM
 *   6. unsubscribe uses {% unsubscribe_link %} inside an href, never
 *      {% unsubscribe %} — the latter expands to a whole <a> element, so nesting it in
 *      an attribute leaks the rest of the footer markup into the email as visible text.
 *      All 22 live templates shipped with the wrong tag.
 *
 * It also re-fetches the live template and warns if it has drifted from .before.html,
 * because these files are a snapshot: if someone edited the email in the UI since,
 * pasting the rebuild would silently revert their work.
 *
 * Exit 0 = safe to paste. Exit 1 = do not paste.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveFlowTemplates, resolveLiveTemplate } from '../lib/klaviyo-flow-templates.js';
import { specs } from '../data/brand/email-rebuild/specs.js';
import {
  linksIn,
  linkFindings,
  tagsIn,
  tagFindings,
  postalFindings,
  unsubscribeFindings,
} from '../lib/email-rebuild-checks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'data/brand/email-rebuild');
const KIT = JSON.parse(readFileSync(join(ROOT, 'data/brand/brand-kit.json'), 'utf8'));
const ALLOWED = new Set([...KIT.palette_hexes.map((h) => h.toUpperCase()), '#FFFFFF']);

function loadEnv() {
  const out = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}


const hexesIn = (s) => [...new Set((s.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toUpperCase()))].sort();
const textIn = (s) => s
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * The live body of the template a flow email ACTUALLY sends.
 *
 * Resolved by the email's NAME, never by the spec's file key. Klaviyo rotates the
 * template id every time the email is saved in the UI: on 2026-08-31, one day after
 * five emails were pasted, 9 of 21 spec ids had rotated and every old id 404'd. This
 * function used to fetch by the key, get a 404, return null, print "(could not fetch)"
 * and let the run report PASS — a drift check that had silently stopped checking.
 *
 * Returns a reason rather than a bare null so the caller can tell "no API key here"
 * (benign) from "this email no longer exists under that name" (a real finding).
 */
async function liveHtml(specId, index) {
  const key = loadEnv().KLAVIYO_PRIVATE_KEY;
  if (!key) return { html: null, skipped: 'no KLAVIYO_PRIVATE_KEY' };

  const name = specs[specId]?.name;
  if (!name) return { html: null, problem: `no spec named ${specId} — cannot resolve its live template` };

  const r = await resolveLiveTemplate({ specId, name, index });
  if (!r.templateId) return { html: null, problem: r.reason };

  try {
    const res = await fetch(`https://a.klaviyo.com/api/templates/${r.templateId}/`, {
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: '2024-10-15' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return { html: null, problem: `template ${r.templateId} -> HTTP ${res.status}`, rotated: r.rotated, templateId: r.templateId };
    const html = (await res.json())?.data?.attributes?.html ?? null;
    return { html, rotated: r.rotated, templateId: r.templateId };
  } catch (e) {
    return { html: null, problem: `fetching ${r.templateId}: ${e.message}`, rotated: r.rotated, templateId: r.templateId };
  }
}

async function verify(id, index) {
  const before = join(DIR, `${id}.before.html`);
  const after = join(DIR, `${id}.after.html`);
  if (!existsSync(before) || !existsSync(after)) {
    console.log(`${id}: missing before/after pair — skipped`);
    return true;
  }
  const b = readFileSync(before, 'utf8');
  const a = readFileSync(after, 'utf8');
  const problems = [];
  const warnings = [];

  const [tb, ta] = [tagsIn(b), tagsIn(a)];
  const tag = tagFindings(b, a, { redesign: REDESIGN });
  warnings.push(...tag.warnings);
  problems.push(...tag.problems);

  const link = linkFindings(b, a, { redesign: REDESIGN });
  problems.push(...link.problems);
  warnings.push(...link.warnings);

  problems.push(...unsubscribeFindings(a).problems);

  // The wordmark legitimately moves from text to an <img alt>. Any other copy change
  // is a rewrite and breaks attribution.
  const norm = (t) => t.replace(/REAL SKIN CARE/gi, '').replace(/\s+/g, ' ').trim();
  const copyChanged = norm(textIn(b)) !== norm(textIn(a));
  if (copyChanged && !REDESIGN) problems.push('copy changed — a restyle must not touch copy (pass --redesign if intended)');

  const offPalette = hexesIn(a).filter((h) => !ALLOWED.has(h));
  if (offPalette.length) problems.push(`off-palette colours: ${offPalette.join(', ')}`);

  problems.push(...postalFindings(a, KIT.postal_address).problems);

  const liveRes = await liveHtml(id, index);
  const live = liveRes.html;
  const drifted = live !== null && live !== b;
  // A rotation means somebody saved this email in the UI, so `.before.html` is a
  // snapshot of a body that is no longer what ships. Say so — this is the state in
  // which a later 'safe to paste' would be reasoning from a stale baseline.
  // A rotation on its OWN is not a finding — the ids move every time the email is saved,
  // and 9 of 21 specs are permanently rotated already. Warning on that alone would print
  // nine standing warnings with nothing to do about them, which is how a report stops
  // being read. It only matters when the body ALSO drifted: then `.before.html` is a
  // baseline for a body that no longer ships.
  if (liveRes.rotated && drifted) warnings.push(`this email was saved in Klaviyo (template is now ${liveRes.templateId}) — refresh .before.html before trusting the diff`);
  if (liveRes.problem) warnings.push(`live check UNAVAILABLE — ${liveRes.problem}`);

  console.log(`\n${id}`);
  console.log(`  tags     ${tb.length} → ${ta.length}${tag.problems.length ? ' ✗' : ' ✓'}`);
  console.log(`  links    ${linksIn(b).length} → ${linksIn(a).length}${link.problems.length ? ' ✗' : link.warnings.length ? ' ⚠ dropped (redesign)' : ' ✓'}`);
  console.log(`  colours  ${hexesIn(b).length} → ${hexesIn(a).length}${offPalette.length ? ' ✗' : ' ✓ all on-palette'}`);
  console.log(`  copy     ${copyChanged ? (REDESIGN ? '⚠ changed (redesign — intended)' : '✗ changed') : '✓ unchanged'}`);
  // The resolved id is printed on the happy path too: it is the only place a reader can
  // see WHICH template was actually compared, and the spec key is no longer that id.
  const liveLabel = live !== null
    ? (drifted
      ? `⚠ DRIFTED from .before — someone edited it in the UI (template ${liveRes.templateId})`
      : `✓ matches .before (template ${liveRes.templateId})`)
    : liveRes.skipped ? `(skipped — ${liveRes.skipped})` : `⚠ NOT CHECKED — ${liveRes.problem}`;
  console.log(`  live     ${liveLabel}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  if (!problems.length) console.log(`  → safe to paste${drifted ? ', BUT reconcile the drift first' : ''}`);
  return problems.length === 0;
}

const args = process.argv.slice(2);
// A restyle must not touch copy — that is what makes a performance change attributable
// to design. A redesign deliberately changes copy (a first-glance payoff, a PS, a CTA
// bridged to what was just read), so the check is downgraded to a warning rather than
// bypassed: you still see exactly what moved.
const REDESIGN = args.includes('--redesign');
const ids = args.filter((a) => !a.startsWith('--')).length && !args.includes('--all')
  ? args.filter((a) => !a.startsWith('--'))
  : args.includes('--all')
    ? [...new Set(readdirSync(DIR).filter((f) => f.endsWith('.after.html')).map((f) => f.replace('.after.html', '')))]
    : [];

if (!ids.length) {
  console.error('usage: verify-email-rebuild.mjs <templateId> | --all');
  process.exit(2);
}

// One index for the whole run — resolving per email would re-walk every flow each time.
let index = null;
try { index = loadEnv().KLAVIYO_PRIVATE_KEY ? await liveFlowTemplates() : null; }
catch (e) { console.error(`could not index live flow templates: ${e.message}`); }

let allOk = true;
for (const id of ids) allOk = (await verify(id, index)) && allOk;
console.log(`\n${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
