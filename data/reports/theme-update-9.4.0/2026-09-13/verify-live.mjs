import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const S = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad';
const NEW = '148782940330', BASE = 'https://www.realskincare.com';
const rows = JSON.parse(readFileSync(`${S}/render-compare.json`, 'utf8'));
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);
function get(url) {
  const out = `${S}/verify.html`;
  const code = execFileSync('curl', ['-s', '-L', '-o', out, '-w', '%{http_code}', '-A', 'Mozilla/5.0 (Macintosh) verify-live', url]).toString();
  return { code, html: readFileSync(out, 'utf8') };
}
function fp({ code, html }) {
  const themeId = (html.match(/Shopify\.theme\s*=\s*\{[^}]*?"id"\s*:\s*(\d+)/) || [])[1] || null;
  const sections = [...html.matchAll(/id="shopify-section-([^"]+)"/g)].map(m => m[1].replace(/^template--\d+__/, 'T__').replace(/^sections--\d+__/, 'S__'));
  const ld = [...html.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)].map(m => m[1]);
  const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return {
    code, themeId, sections: sections.join(','),
    title: (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1]?.replace(/\s+/g, ' ').trim() ?? null,
    h1: (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]?.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() ?? null,
    canonical: (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1] ?? null,
    gtag: (html.match(/googletagmanager\.com\/gtag\/js/g) || []).length, gtm: (html.match(/googletagmanager\.com\/gtm\.js/g) || []).length,
    clarity: /clarity\.ms/.test(html), judgeme: /judge\.me|jdgm/.test(html), recurpay: /recurpay/i.test(html),
    atc: (html.match(/name="add"|add-to-cart|AddToCart/gi) || []).length > 0,
    ld: [...new Set(ld)].sort().join(','), textLen: text.length, ruled: (text.match(/mineral oil|petrolatum|dimethicone/gi) || []).length,
    tokens: (text.match(/\[\[(TOTAL|PRICE|SAVINGS|CTA)\]\]/g) || []).length, rum: /rsc-rum/.test(html), clickId: /rsc-click-id/.test(html),
    buttons: [...html.matchAll(/<a class="button[^"]*"[^>]*>([\s\S]*?)<\/a>/g)].map(m => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('|'),
    blogFilter: /blog-filter/.test(html),
  };
}
const results = [];
let bad = 0;
for (const row of rows) {
  const url = `${BASE}${row.path}${row.path.includes('?') ? '&' : '?'}cb=${Date.now()}`;
  const now = fp(get(url)); sleep(1000);
  const ref = row.prev; // the repaired draft, as rendered through preview before publish
  const diffs = Object.keys(ref).filter(k => !['themeId', 'textLen'].includes(k) && ref[k] !== now[k]);
  const themeOk = row.live.themeId === null ? now.themeId === null : now.themeId === NEW;
  const issues = [...diffs, ...(themeOk ? [] : ['themeId=' + now.themeId]), ...(now.tokens ? ['TOKENS'] : []), ...(now.blogFilter ? ['blogFilter'] : [])];
  if (issues.length) bad++;
  results.push({ path: row.path, now, issues });
  console.log(`${now.code} theme ${now.themeId} tokens ${now.tokens} clarity ${now.clarity} rum ${now.rum} click ${now.clickId} ${issues.length ? 'ISSUES ' + issues.join(',') : 'ok'}  ${row.path}`);
}
writeFileSync(`${S}/verify-live.json`, JSON.stringify(results, null, 2));
console.log(`\n${rows.length - bad}/${rows.length} pages ok`);
for (const r of results.filter(r => r.issues.length)) {
  const ref = rows.find(x => x.path === r.path).prev;
  for (const k of r.issues.filter(k => k in ref)) console.log(`  ${r.path} ${k}: expected ${JSON.stringify(ref[k]).slice(0, 160)} got ${JSON.stringify(r.now[k]).slice(0, 160)}`);
}
