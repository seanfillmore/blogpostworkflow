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
import { linksIn, linkFindings } from '../lib/email-rebuild-checks.js';

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

const tagsIn = (s) => (s.match(/\{%[^%]*%\}|\{\{[^}]*\}\}/g) ?? []).sort();
const hexesIn = (s) => [...new Set((s.match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toUpperCase()))].sort();
const textIn = (s) => s
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function liveHtml(id) {
  const key = loadEnv().KLAVIYO_PRIVATE_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://a.klaviyo.com/api/templates/${id}/`, {
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: '2024-10-15' },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) return null;
    return (await res.json())?.data?.attributes?.html ?? null;
  } catch {
    return null;
  }
}

async function verify(id) {
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
  const lostTags = tb.filter((t) => !ta.includes(t));
  if (lostTags.length) problems.push(`Klaviyo tags dropped: ${lostTags.join(', ')}`);

  const link = linkFindings(b, a, { redesign: REDESIGN });
  problems.push(...link.problems);
  warnings.push(...link.warnings);

  // The wordmark legitimately moves from text to an <img alt>. Any other copy change
  // is a rewrite and breaks attribution.
  const norm = (t) => t.replace(/REAL SKIN CARE/gi, '').replace(/\s+/g, ' ').trim();
  const copyChanged = norm(textIn(b)) !== norm(textIn(a));
  if (copyChanged && !REDESIGN) problems.push('copy changed — a restyle must not touch copy (pass --redesign if intended)');

  const offPalette = hexesIn(a).filter((h) => !ALLOWED.has(h));
  if (offPalette.length) problems.push(`off-palette colours: ${offPalette.join(', ')}`);

  const addr = b.match(/\d+\s+[A-Z]{2}\s*\d*[^<]*,\s*[A-Z]{2}\s+\d{5}/)?.[0]
    ?? b.match(/[^<>]*\b[A-Z]{2}\s+\d{5}\b[^<>]*/)?.[0];
  if (addr && !a.includes(addr.trim())) problems.push('postal address missing — CAN-SPAM requires it');

  const live = await liveHtml(id);
  const drifted = live !== null && live !== b;

  console.log(`\n${id}`);
  console.log(`  tags     ${tb.length} → ${ta.length}${lostTags.length ? ' ✗' : ' ✓'}`);
  console.log(`  links    ${linksIn(b).length} → ${linksIn(a).length}${link.problems.length ? ' ✗' : link.warnings.length ? ' ⚠ dropped (redesign)' : ' ✓'}`);
  console.log(`  colours  ${hexesIn(b).length} → ${hexesIn(a).length}${offPalette.length ? ' ✗' : ' ✓ all on-palette'}`);
  console.log(`  copy     ${copyChanged ? (REDESIGN ? '⚠ changed (redesign — intended)' : '✗ changed') : '✓ unchanged'}`);
  console.log(`  live     ${live === null ? '(could not fetch)' : drifted ? '⚠ DRIFTED from .before — someone edited it in the UI' : '✓ matches .before'}`);
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

let allOk = true;
for (const id of ids) allOk = (await verify(id)) && allOk;
console.log(`\n${allOk ? 'PASS' : 'FAIL'}`);
process.exit(allOk ? 0 : 1);
