#!/usr/bin/env node
/**
 * Run the SEO copy health gate over the two live surfaces nothing else screens:
 * THEME TEMPLATE COPY and PRODUCT IMAGE ALT TEXT. Read-only. Never writes.
 *
 * WHY THESE TWO. `lib/seo-copy-health-gate.js` covers what agents GENERATE —
 * titles, metas, collection and product bodies, queue items. It has never seen a
 * theme template or an image alt, and on 2026-09-03 both turned out to carry live
 * blocking-tier claims on a page with an Add-to-Cart button:
 *
 *   - `templates/product.landing-page-cream.json` listed "Eczema-prone skin" among
 *     who the product is FOR — an intended-use claim — plus two more disease words
 *     in an FAQ answer and the founder block.
 *   - Five `coconut-moisturizer` images carried the alt text
 *     "…natural healing eczema <scent>" — a disease word AND a therapeutic verb,
 *     rendered dozens of times per page view and read by search engines.
 *
 * Both were found by hand while verifying something else. That is the argument for
 * a timer: these surfaces are edited in the Shopify admin by a human, so no agent
 * gate can ever cover them, and nothing else looks.
 *
 * WHAT COUNTS AS COPY IN A TEMPLATE. A template JSON is mostly settings — colours,
 * handles, liquid, image refs, booleans. `isProseCandidate` keeps only strings that
 * plausibly address a reader (a space, 25+ characters, not liquid/url/handle) and
 * the run REPORTS how many strings it scanned and skipped, so a reader can see the
 * filter rather than trust it. Widening the filter can only ever add findings, and
 * the counts are printed so a change in them is visible.
 *
 * EXIT CODES follow the same vocabulary as the other drift gates:
 *   0  clean — nothing on either surface trips the blocking tier
 *   1  advisory-tier hits only (toxicity / regulatory-reference). Routine.
 *   2  BLOCKING-tier hit on a live surface. A human needs to look.
 *   3  a surface could not be read (theme or catalogue fetch failed)
 *
 * Usage: node scripts/check-uncovered-copy-surfaces.mjs [--json] [--all-strings]
 *   --all-strings  disable the prose filter and gate every string (noisy; for
 *                  checking what the filter is hiding, not for routine use)
 */

import { getMainThemeId, listThemeAssets, getThemeAssetRaw, getProducts } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { ACKNOWLEDGED_KEEPS } from '../lib/theme-claim-keeps.js';

const AS_JSON = process.argv.includes('--json');
const ALL_STRINGS = process.argv.includes('--all-strings');

/** Strings that plausibly address a reader, as opposed to settings machinery. */
export function isProseCandidate(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length < 25) return false;
  if (!/\s/.test(t)) return false;
  if (/^(https?:|shopify:|\/|#|\{\{|\{%)/.test(t)) return false;
  if (/^[a-z0-9_-]+$/i.test(t)) return false;
  return true;
}

function walkStrings(node, path, out) {
  if (typeof node === 'string') {
    out.push({ path, value: node });
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => walkStrings(v, `${path}/${i}`, out));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}/${k}`, out);
  }
}

async function main() {
  const findings = { blocking: [], advisory: [] };
  const counts = { templates: 0, templateStrings: 0, templateScanned: 0, images: 0, imagesWithAlt: 0 };

  // ---- theme templates ----
  const themeId = await getMainThemeId();
  const assets = await listThemeAssets(themeId);
  const templateKeys = assets.map((a) => a.key).filter((k) => /^templates\/.*\.json$/.test(k));

  for (const key of templateKeys) {
    const asset = await getThemeAssetRaw(themeId, key);
    if (!asset || typeof asset.value !== 'string') continue;
    let parsed;
    try {
      parsed = JSON.parse(asset.value);
    } catch {
      // A template we cannot parse is not a claims finding — say so and move on.
      console.error(`  ! ${key} did not parse; skipped.`);
      continue;
    }
    counts.templates += 1;

    const strings = [];
    walkStrings(parsed, '', strings);
    counts.templateStrings += strings.length;

    const fields = {};
    for (const { path, value } of strings) {
      if (!ALL_STRINGS && !isProseCandidate(value)) continue;
      counts.templateScanned += 1;
      fields[`${key}${path}`] = value;
    }
    if (!Object.keys(fields).length) continue;
    const res = checkSeoCopyFields(fields);
    for (const v of res.blocking || []) findings.blocking.push({ surface: 'template', ...v });
    for (const v of res.advisory || []) findings.advisory.push({ surface: 'template', ...v });
  }

  // ---- product image alt text ----
  const products = await getProducts({ limit: 250 });
  for (const p of products) {
    for (const im of p.images || []) {
      counts.images += 1;
      const alt = (im.alt || '').trim();
      if (!alt) continue;
      counts.imagesWithAlt += 1;
      const res = checkSeoCopyFields({ [`${p.handle}#${im.id}`]: alt });
      for (const v of res.blocking || []) findings.blocking.push({ surface: 'image-alt', status: p.status, ...v });
      for (const v of res.advisory || []) findings.advisory.push({ surface: 'image-alt', status: p.status, ...v });
    }
  }

  // Split judged-and-kept findings out of `blocking`, so the daily gate reports what
  // is NEW. A keep whose field no longer appears anywhere is reported STALE rather
  // than dropped — otherwise the list rots into a rule nobody can check.
  const ackByField = new Map(ACKNOWLEDGED_KEEPS.map((k) => [k.field, k]));
  const seenFields = new Set(findings.blocking.map((f) => f.field));
  const acknowledged = [];
  const stillBlocking = [];
  for (const f of findings.blocking) {
    const ack = ackByField.get(f.field);
    if (ack) acknowledged.push({ ...f, why: ack.why });
    else stillBlocking.push(f);
  }
  findings.blocking = stillBlocking;
  findings.acknowledged = acknowledged;
  findings.stale_keeps = ACKNOWLEDGED_KEEPS.filter((k) => !seenFields.has(k.field)).map((k) => k.field);

  const result = { generated_at: new Date().toISOString(), theme_id: themeId, counts, findings };
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nUncovered copy surfaces — theme ${themeId}`);
    console.log(
      `Templates: ${counts.templates} parsed, ${counts.templateScanned} of ${counts.templateStrings} strings gated` +
        (ALL_STRINGS ? ' (--all-strings: filter off)' : ' (prose filter on)')
    );
    console.log(`Product images: ${counts.imagesWithAlt} of ${counts.images} carry alt text\n`);

    console.log(`BLOCKING — NEW (${findings.blocking.length})`);
    for (const f of findings.blocking) console.log(`  [${f.category}] ${f.field}\n      "${f.match}"`);
    console.log(`\nACKNOWLEDGED KEEPS (${findings.acknowledged.length}) — judged and deliberately kept`);
    for (const f of findings.acknowledged) console.log(`  [${f.category}] ${f.field}\n      ${f.why}`);
    if (findings.stale_keeps.length) {
      console.log(`\nSTALE KEEPS (${findings.stale_keeps.length}) — no longer present; prune from lib/theme-claim-keeps.js`);
      for (const f of findings.stale_keeps) console.log(`  ${f}`);
    }
    console.log(`\nADVISORY (${findings.advisory.length})`);
    for (const f of findings.advisory.slice(0, 25)) console.log(`  [${f.category}] ${f.field} — "${f.match}"`);
    if (findings.advisory.length > 25) console.log(`  … and ${findings.advisory.length - 25} more`);
    console.log('');
  }

  if (findings.blocking.length) process.exit(2);
  if (findings.advisory.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(3);
});
