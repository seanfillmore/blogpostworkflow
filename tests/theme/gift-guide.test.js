// tests/theme/gift-guide.test.js
//
// The holiday gift-guide listicle (data/presell/gift-guide/content.json ->
// theme/templates/page.presell-gifts.json, rendered by
// sections/gift-guide-listicle.liquid). A COMMERCIAL surface: every pick ends
// in a link to a product page, so every string clears the default commercial
// health gate. Prices and stock are live in the section, so the copy may carry
// no price at all, and the section must hide a sold-out pick rather than show
// it (three of the six picks were sold out on the day it was built).
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';
import { render, buildTemplate, TEMPLATE_PATH, CONTENT_PATH } from '../../scripts/presell/build-gift-guide-template.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const content = JSON.parse(readFileSync(join(ROOT, CONTENT_PATH), 'utf8'));
const section = readFileSync(join(ROOT, 'theme/sections/gift-guide-listicle.liquid'), 'utf8');

function strings(value, path = '', out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

const COPY = strings(content).filter(([p]) => p !== 'page' && p !== 'handle' && !p.endsWith('.handle'));

test('every string clears the commercial health gate', () => {
  for (const [p, s] of COPY) {
    const r = checkSeoCopyFields({ [p]: s });
    assert.ok(r.ok, `${p}: ${JSON.stringify(r.claims ?? r)}`);
  }
});

test('no em dash, no petroleum names, never antiperspirant', () => {
  for (const [p, s] of COPY) {
    assert.ok(!s.includes('—'), `em dash at ${p}`);
    assert.ok(!/mineral oil|petrolatum|paraffin|antiperspirant/i.test(s), `forbidden term at ${p}`);
  }
});

test('copy carries no price: prices are live in the section', () => {
  for (const [p, s] of COPY) {
    if (p === 'notes[0]') continue; // the $45 free-shipping threshold is a policy, not a product price
    assert.ok(!/\$\d/.test(s), `hardcoded price at ${p}: ${s}`);
  }
});

test('the headline carries {count} so it matches the picks actually shown', () => {
  assert.ok(content.headline.includes('{count}'));
  assert.match(section, /replace: count_token, shown/);
});

test('the section hides a sold-out pick and numbers the rest without gaps', () => {
  assert.match(section, /unless gp\.available -%\}\{%- continue/);
  assert.match(section, /assign n = n \| plus: 1/);
  assert.match(section, /v\.compare_at_price > v\.price/);
});

test('picks link to the product page; the section has no custom cart form', () => {
  assert.match(section, /href="\{\{ gp\.url \}\}"/);
  const markup = section.replace(/\{%-? comment -?%\}[\s\S]*?\{%-? endcomment -?%\}/g, '');
  assert.ok(!/cart_add_url|\/cart\/add/.test(markup),'a custom /cart/add form is hijacked by Zipify OCU');
});

test('reviews reuse the three Judge.me reviews checked 5/5 for the cream page', () => {
  const cream = JSON.parse(readFileSync(join(ROOT, 'data/presell/coconut-cream/content.json'), 'utf8'));
  const byId = new Map(cream.reviews.map((r) => [r.judgemeId, r.quote]));
  for (const r of content.reviews) assert.equal(byId.get(r.judgemeId), r.quote, `review ${r.judgemeId}`);
});

test('the template on disk is a fresh build of content.json', () => {
  assert.equal(readFileSync(join(ROOT, TEMPLATE_PATH), 'utf8'), render(ROOT));
});

test('buildTemplate refuses a headline without {count}', () => {
  assert.throws(() => buildTemplate({ ...content, headline: '6 gifts' }), /\{count\}/);
});
