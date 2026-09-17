import { getProducts, getPages, getCustomCollections, getSmartCollections, getBlogs, getArticles } from '/Users/seanfillmore/Code/Claude/lib/shopify.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
const DRAFT = 148782940330, BASE = 'https://www.realskincare.com';
const S = '/private/tmp/claude-501/-Users-seanfillmore-Code-Claude/363304d7-fc64-470b-8f25-d8d7cc74b167/scratchpad';
const JAR = `${S}/preview.jar`;
const products = (await getProducts({ limit: 250 })).filter(p => p.status === 'active');
const pages = (await getPages({ limit: 250 })).filter(p => p.published_at);
const cols = [...await getCustomCollections({ limit: 250 }), ...await getSmartCollections({ limit: 250 })].filter(c => c.published_at);
const [blog] = await getBlogs();
const arts = (await getArticles(blog.id, { limit: 250 })).filter(a => a.published_at).slice(0, 3);
const paths = ['/', '/cart', '/search?q=lotion', '/collections/all', '/blogs/news', '/llms.txt', '/robots.txt', '/pages/zz-not-a-page',
  ...products.map(p => `/products/${p.handle}`), ...pages.map(p => `/pages/${p.handle}`), ...cols.map(c => `/collections/${c.handle}`),
  ...arts.map(a => `/blogs/news/${a.handle}`)];
const sleep = (ms) => execFileSync('sleep', [String(ms / 1000)]);
function get(url, jar) {
  const out = `${S}/render.html`;
  const args = ['-s', '-L', '-o', out, '-w', '%{http_code}', '-A', 'Mozilla/5.0 (Macintosh) render-compare', url];
  if (jar) args.unshift('-c', JAR, '-b', JAR);
  const code = execFileSync('curl', args).toString();
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
  };
}
get(`${BASE}/?preview_theme_id=${DRAFT}`, true); sleep(1000);
const rows = [];
for (const p of paths) {
  const live = fp(get(`${BASE}${p}`, false)); sleep(1000);
  const prev = fp(get(`${BASE}${p}`, true)); sleep(1000);
  const diffs = Object.keys(live).filter(k => k !== 'themeId' && k !== 'textLen' && live[k] !== prev[k]);
  const textDelta = live.textLen ? Math.round(100 * (prev.textLen - live.textLen) / live.textLen) : 0;
  rows.push({ path: p, live, prev, diffs, textDelta });
  console.log(`${live.code}/${prev.code} theme ${live.themeId}/${prev.themeId} text${textDelta >= 0 ? '+' : ''}${textDelta}% ${diffs.length ? 'DIFF ' + diffs.join(',') : 'same'}  ${p}`);
}
writeFileSync(`${S}/render-compare.json`, JSON.stringify(rows, null, 2));
