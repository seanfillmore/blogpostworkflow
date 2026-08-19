#!/usr/bin/env node
/**
 * Rebind the bundle lander's picker with event delegation so it survives Dawn's
 * re-render, and syntax-check before writing.
 *
 *   node scripts/fix-vqr-delegation.mjs [--apply]
 *
 * THE BUG
 *   Dawn's onVariantChange re-fetches the section and replaces the product info
 *   container. The vqr picker and quantity stepper live inside it, so they are swapped for
 *   fresh DOM nodes on every variant change. Listeners were bound directly to the original
 *   elements, so they died with them: the first switch worked, and nothing after it did.
 *
 *   Measured — `pickerIsSameNode` is true on load and false after one change.
 *
 *   Inline <script> injected via innerHTML does not execute, so the replacement markup
 *   never re-binds. Delegation on document is the fix: one listener, bound once, that
 *   keeps working no matter how many times the subtree is replaced.
 *
 * Replaces the whole <script> block rather than editing inside it. A previous surgical
 * patch left a stray brace, which stopped the script parsing and silently disabled the
 * entire picker while the page still returned 200.
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
const liquid = block.settings.custom_liquid;
const start = liquid.indexOf('<script');
const end = liquid.lastIndexOf('</script>') + '</script>'.length;
if (start < 0 || end < start) throw new Error('script block not found');

const SCRIPT = `<script>
(function(){
  // Bound once. Dawn replaces the product info container on every variant change, so the
  // picker and stepper are new DOM nodes each time — listeners bound to the elements
  // themselves die after the first switch. Inline scripts in replaced markup do not run,
  // so nothing re-binds. Delegation on document is what makes this survive.
  if(window.__vqrDelegated){ return; }
  window.__vqrDelegated = true;

  // variant id -> its option values. Covers multi-option bundles (Configuration + Scent),
  // not just the first select.
  var VQR_OPTION_VALUES = {
    {%- for v in product.variants -%}
    "{{ v.id }}": [{% for o in v.options %}{{ o | json }}{% unless forloop.last %},{% endunless %}{% endfor %}]{% unless forloop.last %},{% endunless %}
    {%- endfor -%}
  };

  document.addEventListener('change', function(e){
    var pick = e.target;
    if(!pick || !pick.matches || !pick.matches('select[data-vqr-variant]')){ return; }
    var opts = VQR_OPTION_VALUES[pick.value];
    if(!opts){ return; }

    var root = document.querySelector('variant-selects:not([data-vqr-skip])');
    var selects = root ? root.querySelectorAll('select') : [];
    if(selects.length){
      // Assign the OPTION VALUE, never the variant id — an id matches no option, so the
      // select silently empties and the gallery never updates.
      for(var i = 0; i < selects.length; i++){
        if(opts[i] != null){ selects[i].value = opts[i]; }
      }
      selects[selects.length - 1].dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    var radios = document.querySelectorAll('variant-radios input[type="radio"]');
    radios.forEach(function(r){
      if(opts.indexOf(r.value) !== -1){ r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); }
    });
  });

  document.addEventListener('click', function(e){
    var btn = e.target.closest && e.target.closest('[data-vqr-qty-minus], [data-vqr-qty-plus]');
    if(!btn){ return; }
    var wrap = btn.closest('.vqr-stepper') || btn.parentElement;
    var qty = wrap && wrap.querySelector('input');
    if(!qty){ return; }
    var v = parseInt(qty.value, 10) || 1;
    var next = btn.hasAttribute('data-vqr-qty-minus') ? Math.max(1, v - 1) : v + 1;
    if(next !== v){ qty.value = next; qty.dispatchEvent(new Event('change',{bubbles:true})); }
  });
})();
</script>`;

block.settings.custom_liquid = liquid.slice(0, start) + SCRIPT + liquid.slice(end);

function syntaxCheck(l) {
  const s = l.slice(l.indexOf('<script'));
  let js = s.slice(s.indexOf('>') + 1, s.lastIndexOf('</script>'));
  js = js.replace(/var VQR_OPTION_VALUES = \{[\s\S]*?\n  \};/, 'var VQR_OPTION_VALUES = {"1":["a"]};');
  js = js.replace(/\{\{[\s\S]*?\}\}/g, '0').replace(/\{%[\s\S]*?%\}/g, '');
  const tmp = join('/tmp', `vqr-${Date.now()}.js`);
  writeFileSync(tmp, js);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e.stderr).split('\n').slice(0, 3).join(' ') }; }
}

const check = syntaxCheck(block.settings.custom_liquid);
console.log(`syntax check: ${check.ok ? 'PASS' : 'FAIL — ' + check.err}`);
if (!check.ok) { console.error('refusing to write'); process.exit(1); }
console.log(`${current.length} bytes -> ${JSON.stringify(doc, null, 2).length} bytes`);

if (!APPLY) { console.log('\ndry run — pass --apply'); process.exit(0); }

const dir = join(ROOT, 'data/reports/theme-backups/2026-08-01');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'product.bundle-landing.json.pre-delegation'), current);

const res = await fetch(base, {
  method: 'PUT',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ asset: { key: KEY, value: JSON.stringify(doc, null, 2) } }),
});
if (!res.ok) throw new Error(`PUT failed HTTP ${res.status}`);
console.log('✓ written to the live theme');
