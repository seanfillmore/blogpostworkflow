import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/Users/seanfillmore/Code/Claude/package.json');
const puppeteer = require('puppeteer');
// usage: node collect.mjs <label> <url> [scrolls]
const [label, url, scrollsArg] = process.argv.slice(2);
const scrolls = Number(scrollsArg || 8);
const ads = new Map();
function walk(o) {
  if (!o || typeof o !== 'object') return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (o.ad_archive_id && o.snapshot) {
    ads.set(o.ad_archive_id, o);
  }
  for (const k in o) walk(o[k]);
}
function parseBlob(text) {
  for (const line of text.split('\n')) {
    const t = line.trim(); if (!t || !t.includes('ad_archive_id')) continue;
    try { walk(JSON.parse(t.replace(/^for \(;;\);/, ''))); } catch {}
  }
}
const browser = await puppeteer.launch({ headless: false, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', defaultViewport: { width: 1400, height: 1000 }, userDataDir: './chrome-profile' });
const page = await browser.newPage();
page.on('response', async (res) => {
  if (!res.url().includes('/api/graphql')) return;
  try { parseBlob(await res.text()); } catch {}
});
await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
await new Promise(r => setTimeout(r, 3000));
const scripts = await page.evaluate(() => [...document.querySelectorAll('script')].map(s => s.textContent).filter(t => t.includes('ad_archive_id')));
scripts.forEach(parseBlob);
const body = await page.evaluate(() => document.body.innerText.slice(0, 600));
if (/log in to continue|captcha|security check/i.test(body)) console.error('WALL:', body);
const resultsTxt = await page.evaluate(() => (document.body.innerText.match(/~?[\d,]+ results?/) || [''])[0]);
let stable = 0, last = -1;
for (let i = 0; i < scrolls && stable < 3; i++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(r => setTimeout(r, 3000 + Math.random() * 1500));
  if (ads.size === last) stable++; else stable = 0; last = ads.size;
}
console.log('library says:', resultsTxt);
const out = [...ads.values()].map(a => {
  const s = a.snapshot || {};
  const card0 = (s.cards || [])[0] || {};
  return {
    id: a.ad_archive_id, page_id: a.page_id || s.page_id, page_name: s.page_name || a.page_name,
    page_url: s.page_profile_uri, is_active: a.is_active, start: a.start_date, end: a.end_date,
    collation_count: a.collation_count, display_format: s.display_format,
    body: (s.body && s.body.text) || card0.body || '', title: s.title || card0.title || '',
    link_description: s.link_description || card0.link_description || '', cta: s.cta_text || card0.cta_text || '',
    link_url: s.link_url || card0.link_url || '',
    images: [...(s.images || []).map(i => i.original_image_url || i.resized_image_url), ...(s.cards || []).map(c => c.original_image_url || c.resized_image_url)].filter(Boolean),
    videos: (s.videos || []).length + (s.cards || []).filter(c => c.video_hd_url || c.video_sd_url).length,
    publisher_platform: a.publisher_platform,
  };
});
fs.mkdirSync('raw', { recursive: true });
fs.writeFileSync(`raw/${label}.json`, JSON.stringify(out, null, 1));
console.log(label, 'ads:', out.length);
const pages = {}; out.forEach(a => { const k = a.page_id + ' ' + a.page_name; pages[k] = (pages[k] || 0) + 1; });
console.log(Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 6));
await browser.close();
