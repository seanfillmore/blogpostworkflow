#!/usr/bin/env node
/**
 * Repair the stray closing brace left in the vqr picker script, and syntax-check the
 * result before writing.
 *
 *   node scripts/fix-vqr-brace.mjs [--apply]
 *
 * The previous patch replaced the handler's opening — `if(hidden){ if(tag==='SELECT'){` —
 * but left both closers in place, so the function ended with one `}` too many. The whole
 * IIFE then failed to parse with "missing ) after argument list", the change listener was
 * never attached, and the picker silently did nothing.
 *
 * That failure mode is worth naming: a syntax error anywhere in this block disables the
 * ENTIRE picker, and the page still renders and returns 200. Nothing short of opening a
 * console or driving a browser reveals it — which is why this script refuses to write
 * without parsing the script first.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getAccessToken } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEME = 147480051882;
const KEY = 'templates/product.bundle-landing.json';
const APPLY = process.argv.includes('--apply');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const token = await getAccessToken();
const base = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/themes/${THEME}/assets.json`;

const current = (await (await fetch(`${base}?asset[key]=${encodeURIComponent(KEY)}`, {
  headers: { 'X-Shopify-Access-Token': token },
})).json()).asset.value;

const doc = JSON.parse(current);
const block = doc.sections.main.blocks['vqr-combo'];

const BROKEN = `      radios.forEach(function(r){ if(opts.indexOf(r.value) !== -1){ r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); } });
      }
    }
  });`;
const FIXED = `      radios.forEach(function(r){ if(opts.indexOf(r.value) !== -1){ r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); } });
    }
  });`;

if (!block.settings.custom_liquid.includes(BROKEN)) {
  console.log(block.settings.custom_liquid.includes(FIXED) ? 'already repaired' : 'broken region not found — inspect manually');
  process.exit(0);
}
block.settings.custom_liquid = block.settings.custom_liquid.replace(BROKEN, FIXED);

/**
 * Parse the script with Liquid stripped. The map is Liquid-generated, so substitute a
 * representative literal — the point is to prove the surrounding JS is well-formed.
 */
function syntaxCheck(liquid) {
  const s = liquid.slice(liquid.indexOf('<script'));
  let js = s.slice(s.indexOf('>') + 1, s.lastIndexOf('</script>'));
  js = js.replace(/var VQR_OPTION_VALUES = \{[\s\S]*?\n  \};/, 'var VQR_OPTION_VALUES = {"1":["a"]};');
  js = js.replace(/\{\{[\s\S]*?\}\}/g, '0').replace(/\{%[\s\S]*?%\}/g, '');
  const tmp = join('/tmp', `vqr-check-${Date.now()}.js`);
  writeFileSync(tmp, js);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e.stderr).split('\n').slice(0, 4).join(' ') }; }
}

const check = syntaxCheck(block.settings.custom_liquid);
console.log(`syntax check after repair: ${check.ok ? 'PASS' : 'FAIL — ' + check.err}`);
if (!check.ok) { console.error('refusing to write a script that does not parse'); process.exit(1); }

const before = syntaxCheck(JSON.parse(current).sections.main.blocks['vqr-combo'].settings.custom_liquid);
console.log(`syntax check of what is live now: ${before.ok ? 'PASS' : 'FAIL (this is the bug)'}`);

if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }

const dir = join(ROOT, 'data/reports/theme-backups/2026-08-01');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'product.bundle-landing.json.pre-brace-fix'), current);

const res = await fetch(base, {
  method: 'PUT',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ asset: { key: KEY, value: JSON.stringify(doc, null, 2) } }),
});
if (!res.ok) throw new Error(`PUT failed HTTP ${res.status}`);
console.log('✓ written to the live theme');
