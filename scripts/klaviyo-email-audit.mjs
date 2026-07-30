#!/usr/bin/env node
/**
 * Klaviyo Email Audit — inventory every email a live flow sends, and score each
 * one against data/brand/brand-kit.json.
 *
 *   node scripts/klaviyo-email-audit.mjs            # audit live flows
 *   node scripts/klaviyo-email-audit.mjs --all      # include draft/manual flows
 *   node scripts/klaviyo-email-audit.mjs --dump-html # also write each email's HTML
 *
 * Writes data/reports/email-audit/YYYY-MM-DD.md (plus .json) and prints a summary.
 *
 * WHY THIS EXISTS: "the emails lack brand cohesion" is not actionable. This turns it
 * into a per-email list of which colours and fonts are actually in the HTML versus
 * what the brand kit says, so a redesign has a work queue instead of an opinion.
 *
 * HOW THE CONTENT IS REACHED — the non-obvious part:
 *   flows -> flow-actions (action_type SEND_EMAIL) -> flow-messages -> template
 * The email body is NOT on the flow-message. It lives on the template the message
 * points at.
 *
 * THAT TEMPLATE IS READ-ONLY. Measured 2026-07-30 against a real flow template:
 *   GET   /api/templates/{id}      -> 200, full html
 *   PATCH /api/templates/{id}      -> 404 "Template ... does not exist"
 *   PATCH /api/flow-messages/{id}  -> 405 method_not_allowed
 * The PATCH 404 is identical across revisions 2024-10-15, 2025-01-15 and
 * 2025-07-15, so it is not a versioning artifact — Klaviyo returns 404 rather than
 * 403 to mean "not in the writable set".
 *
 * PATCH does work on templates you create yourself via POST /api/templates (proven
 * by a scratch round-trip). That is what misled an earlier version of this comment
 * into claiming flow emails were editable: a library template is writable, a
 * flow-owned one is not. Rebuilt flow email HTML has to be pasted into Klaviyo's
 * code editor by hand.
 *
 * Read-only. This script never writes to Klaviyo.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REVISION = '2024-10-15';
const BASE = 'https://a.klaviyo.com/api';

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

const KEY = loadEnv().KLAVIYO_PRIVATE_KEY;
if (!KEY) {
  console.error('KLAVIYO_PRIVATE_KEY is not set in .env');
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Klaviyo-API-Key ${KEY}`, revision: REVISION },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`${path} -> ${res.status} ${JSON.stringify(body.errors ?? {}).slice(0, 200)}`);
  }
  return body;
}

const brand = JSON.parse(readFileSync(join(ROOT, 'data/brand/brand-kit.json'), 'utf8'));
const onBrand = new Set(brand.palette_hexes.map((h) => h.toUpperCase()));
// Neutrals nobody should be flagged for: plain white and the shorthand forms.
const IGNORED_HEX = new Set(['#FFFFFF', '#FFF', '#000', '#TRANSPARENT']);

/** Every hex literal in the HTML, normalised to 6-digit uppercase. */
function hexesIn(html) {
  const found = new Map();
  for (const m of html.matchAll(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g)) {
    let h = m[1].toUpperCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const k = `#${h}`;
    found.set(k, (found.get(k) ?? 0) + 1);
  }
  return found;
}

/** Font families named in the HTML, in declaration order. */
function fontsIn(html) {
  const fams = new Set();
  for (const m of html.matchAll(/font-family\s*:\s*([^;"'}]+)/gi)) {
    for (const f of m[1].split(',')) {
      const name = f.trim().replace(/^['"]|['"]$/g, '');
      if (name) fams.add(name);
    }
  }
  return [...fams];
}

function auditHtml(html) {
  const hexes = hexesIn(html);
  const offBrand = [...hexes.keys()].filter((h) => !onBrand.has(h) && !IGNORED_HEX.has(h));
  const fonts = fontsIn(html);
  // The site fonts, not the PDF's Mont — cohesion is measured against realskincare.com.
  const hasSiteFont = fonts.some((f) => /^(cabin|outfit)$/i.test(f));
  const hasFallback = fonts.some((f) => /trebuchet|helvetica|arial|segoe|tahoma|sans-serif/i.test(f));
  const leadsWithSerif = /font-family\s*:\s*['"]?(georgia|times|garamond|palatino|serif)/i.test(html);
  const findings = [];
  if (offBrand.length) findings.push(`off-palette colours: ${offBrand.join(', ')}`);
  if (!fonts.length) findings.push('no font-family declared anywhere — client default will render');
  else if (!hasSiteFont && !hasFallback) findings.push(`no site or fallback font: ${fonts.join(', ')}`);
  else if (!hasSiteFont) findings.push(`site font absent (Cabin/Outfit missing, fallback only): ${fonts.join(', ')}`);
  if (leadsWithSerif) findings.push('leads with a serif stack — the site is sans (Cabin/Outfit); this is the largest single cohesion break');
  if (!/#EDE5D8/i.test(html) && !/#AEDEAC/i.test(html)) {
    findings.push('neither brand neutral nor accent present — visually generic');
  }
  return { hexes: [...hexes.keys()], offBrand, fonts, findings };
}

const args = new Set(process.argv.slice(2));
const wantAll = args.has('--all');
const dumpHtml = args.has('--dump-html');

console.log('Fetching flows…');
const flows = (await api('/flows/')).data.filter((f) => wantAll || f.attributes.status === 'live');
console.log(`${flows.length} flow${flows.length === 1 ? '' : 's'}\n`);

const rows = [];
for (const flow of flows) {
  const actions = (await api(`/flows/${flow.id}/flow-actions/`)).data
    .filter((a) => a.attributes.action_type === 'SEND_EMAIL');
  for (const action of actions) {
    const messages = (await api(`/flow-actions/${action.id}/flow-messages/`)).data;
    for (const msg of messages) {
      let tpl = null;
      try {
        tpl = (await api(`/flow-messages/${msg.id}/template/`)).data;
      } catch (err) {
        rows.push({
          flow: flow.attributes.name, message: msg.attributes.name, error: err.message,
        });
        continue;
      }
      const html = tpl?.attributes?.html ?? '';
      rows.push({
        flow: flow.attributes.name,
        flowId: flow.id,
        message: msg.attributes.name,
        messageId: msg.id,
        subject: msg.attributes.content?.subject ?? null,
        preview: msg.attributes.content?.preview_text ?? null,
        templateId: tpl?.id ?? null,
        editorType: tpl?.attributes?.editor_type ?? null,
        htmlBytes: html.length,
        ...auditHtml(html),
      });
      if (dumpHtml && html) {
        const dir = join(ROOT, 'data/reports/email-audit/html');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${tpl.id}.html`), html);
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);
const dir = join(ROOT, 'data/reports/email-audit');
mkdirSync(dir, { recursive: true });

const clean = rows.filter((r) => !r.error && !r.findings?.length);
const dirty = rows.filter((r) => !r.error && r.findings?.length);
const errored = rows.filter((r) => r.error);
const allOff = [...new Set(dirty.flatMap((r) => r.offBrand))].sort();
const codeEditable = rows.filter((r) => r.editorType === 'CODE').length;

const L = [];
L.push(`# Klaviyo email audit — ${today}`, '');
L.push(`${rows.length} emails across ${flows.length} flows. **${clean.length} on-brand, ${dirty.length} with findings**${errored.length ? `, ${errored.length} unreadable` : ''}.`, '');
L.push(`Audited against \`data/brand/brand-kit.json\` — palette ${brand.palette_hexes.join(' ')}, type ${brand.typography.site.heading} / ${brand.typography.site.body} (per the live site).`, '');
L.push(`**${codeEditable} of ${rows.length} templates are \`editor_type: CODE\`**, so a rebuilt HTML body can be pasted straight into Klaviyo's code editor. Note the API will NOT write it for you — flow-owned templates are readable but not writable (PATCH returns 404; flow-messages returns 405). Anything not CODE is drag-and-drop and must be rebuilt block by block.`, '');
if (allOff.length) L.push(`Off-palette colours in use across all emails: ${allOff.map((h) => `\`${h}\``).join(', ')}`, '');

L.push('## Emails with findings', '');
if (!dirty.length) L.push('_None._', '');
for (const r of dirty) {
  L.push(`### ${r.flow} → ${r.message}`, '');
  L.push(`- Template \`${r.templateId}\` (${r.editorType}), ${r.htmlBytes} bytes`);
  if (r.subject) L.push(`- Subject: ${r.subject}`);
  L.push(`- Fonts declared: ${r.fonts.length ? r.fonts.join(', ') : '_none_'}`);
  for (const f of r.findings) L.push(`- ⚠️ ${f}`);
  L.push('');
}

if (clean.length) {
  L.push('## On-brand', '');
  for (const r of clean) L.push(`- ${r.flow} → ${r.message} (\`${r.templateId}\`)`);
  L.push('');
}
if (errored.length) {
  L.push('## Unreadable', '');
  for (const r of errored) L.push(`- ${r.flow} → ${r.message}: ${r.error}`);
  L.push('');
}

writeFileSync(join(dir, `${today}.md`), L.join('\n'));
writeFileSync(join(dir, `${today}.json`), JSON.stringify({ generated: today, brandKit: brand.palette_hexes, rows }, null, 2));

console.log(`${rows.length} emails: ${clean.length} on-brand, ${dirty.length} with findings, ${errored.length} unreadable`);
console.log(`${codeEditable}/${rows.length} templates are CODE (paste-able by hand; API cannot write them)`);
if (allOff.length) console.log(`off-palette colours: ${allOff.join(', ')}`);
console.log(`\nreport: data/reports/email-audit/${today}.md`);
