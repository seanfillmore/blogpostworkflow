/**
 * Ad-structure research refresh. ON DEMAND ONLY, never scheduled.
 *
 *   node agents/ad-concepts/research.js --refresh [--brands kopari,native] [--no-keywords] [--min-days 90]
 *   node agents/ad-concepts/research.js --approve <candidate-id>
 *
 * --refresh pulls active image ads from the Meta Ad Library with a HEADFUL Chrome
 * (headless is blocked), never logs in, paces page loads 3s+, and STOPS at a
 * login wall or captcha. It keeps body lotion/cream/butter/balm statics running
 * 90+ days, tags each with a vision call (format + non-transferable reasons) and
 * writes data/ad-structures/candidates/<date>.json, compressed images and a
 * markdown report. It NEVER edits library.json.
 *
 * --approve appends a status "candidate" entry (never "approved"; Sean promotes
 * it by hand) only when the entry can be made complete and valid automatically.
 * Otherwise it writes candidates/<id>.needs-human.md and leaves library.json alone.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify as realNotify } from '../../lib/notify.js';
import { loadLibrary, LAYOUTS, RUN_RATIOS } from './structures.js';
import { LAYOUT_REGISTRY } from './layouts/index.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DATA_DIR = join(ROOT, 'data/ad-structures');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIN_PACE_MS = 3000;

export class WallError extends Error {}

// ---------- pure ----------

/** Walk Ad Library response text (graphql lines or inline script JSON) into normalized ads. */
export function parseLibraryResponse(text) {
  const found = new Map();
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.ad_archive_id && o.snapshot) found.set(o.ad_archive_id, o);
    for (const k in o) walk(o[k]);
  };
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('ad_archive_id')) continue;
    try { walk(JSON.parse(t.replace(/^for \(;;\);/, ''))); } catch { /* not a JSON line */ }
  }
  return [...found.values()].map(a => {
    const s = a.snapshot || {};
    const cards = s.cards || [];
    const card0 = cards[0] || {};
    return {
      id: a.ad_archive_id, pageId: a.page_id || s.page_id, pageName: s.page_name || a.page_name,
      pageUrl: s.page_profile_uri, isActive: a.is_active, start: a.start_date, end: a.end_date,
      versions: a.collation_count, displayFormat: s.display_format,
      body: (s.body && s.body.text) || card0.body || '', title: s.title || card0.title || '',
      linkDescription: s.link_description || card0.link_description || '', cta: s.cta_text || card0.cta_text || '',
      linkUrl: s.link_url || card0.link_url || '',
      images: [...(s.images || []).map(i => i.original_image_url || i.resized_image_url), ...cards.map(c => c.original_image_url || c.resized_image_url)].filter(Boolean),
      videos: (s.videos || []).length + cards.filter(c => c.video_hd_url || c.video_sd_url).length,
    };
  });
}

export function daysRunning(startEpochSec, now = Date.now()) {
  return Math.max(0, Math.floor((now / 1000 - startEpochSec) / 86400));
}

const REL = /lotion|cream|butter|balm|tallow|skin ?food|moisturi[sz]|body (oil|care|glow)|dry skin|crepey|hydrat/i;
const EXCL = /\bspf\b|sunscreen|deodorant|serum|cleanser|face wash|shampoo|perfume|eau de|fragrance mist|\bsoap\b|lip (oil|gloss)/i;

export function isBodyCareAd(ad) {
  const txt = [ad.body, ad.title, ad.linkDescription, ad.linkUrl].join(' ');
  return REL.test(txt) && !EXCL.test(txt);
}

/** Static, body-care ads running >= minDays, de-duplicated by id, longest first. */
export function rankCandidates(ads, { minDays = 90, now = Date.now() } = {}) {
  const seen = new Set(); const out = [];
  for (const a of ads) {
    if (seen.has(a.id)) continue; seen.add(a.id);
    if (a.videos || !a.images?.length || a.displayFormat === 'DPA') continue;
    if (/\{\{product/.test([a.body, a.title, a.linkDescription, a.linkUrl].join(' '))) continue;
    if (!isBodyCareAd(a)) continue;
    const days = daysRunning(a.start, now);
    if (days < minDays) continue;
    out.push({ ...a, days });
  }
  return out.sort((x, y) => y.days - x.days);
}

export function libraryUrl({ pageId, name, keyword }) {
  const base = 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&media_type=image';
  if (pageId) return `${base}&search_type=page&view_all_page_id=${encodeURIComponent(pageId)}`;
  const q = keyword ?? name;
  const type = keyword ? 'keyword_unordered' : 'keyword_exact_phrase';
  return `${base}&q=${encodeURIComponent(q).replace(/'/g, '%27')}&search_type=${type}`;
}

export const FORMATS = [...LAYOUTS, 'other'];

export function buildTagPrompt(ad) {
  return `You are cataloguing a competitor body-care static ad that has run ${ad.days} days, so its STRUCTURE is proven. Look at the image.
Primary text: ${JSON.stringify((ad.body || '').slice(0, 500))}
Headline: ${JSON.stringify(ad.title || '')}

Classify the visual structure as exactly one of: ${FORMATS.join(', ')}.
- comment-card: a customer comment/review card over a product photo
- headline-over-photo: a short headline over a product or texture photo
- split-two-panel: two side-by-side panels (contrast / reveal)
- checklist-split: a product photo beside a checklist of ours-vs-theirs rows
- photo-only: a product photo with at most a small band of text
- labelled-bundle: a product group with labelled callouts
- other: anything else

List "nonTransferable" reasons: anything we could not copy for a cosmetic brand, e.g. before/after of skin or body, collagen/wrinkle/condition/disease claims, drug or treatment claims, "chemicals are killing you" fear framing, founder or family photo, customer counts, press logos, a named competitor. Empty array when none.

Return ONLY JSON: {"format":"<one of the list>","nonTransferable":["..."],"summary":"<one sentence on how the structure works>"}`;
}

/** Fail-closed: anything that is not exactly the expected shape throws. */
export function parseTagResponse(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('tag response has no JSON object');
  let o;
  try { o = JSON.parse(m[0]); } catch { throw new Error('tag response is not valid JSON'); }
  if (typeof o.format !== 'string' || !o.format.trim()) throw new Error('tag response: format missing');
  if (!Array.isArray(o.nonTransferable)) throw new Error('tag response: nonTransferable must be an array');
  if (!o.nonTransferable.every(x => typeof x === 'string')) throw new Error('tag response: nonTransferable entries must be strings');
  const format = FORMATS.includes(o.format.trim()) ? o.format.trim() : 'other';
  return { format, nonTransferable: o.nonTransferable, summary: String(o.summary || '') };
}

// ---------- collection (I/O behind a browserFactory) ----------

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * browserFactory() -> { visit(url) -> ads[], close() }; visit throws WallError on a
 * login wall or captcha. Pages are paced >= 3s apart, and a wall stops the whole
 * collection and returns what was gathered so far.
 */
export async function collect({ brands = [], keywords = [], browserFactory, sleep = defaultSleep, log = () => {} }) {
  const jobs = [
    ...brands.map(b => ({ source: b.key, url: libraryUrl(b) })),
    ...keywords.map(k => ({ source: `kw:${k}`, url: libraryUrl({ keyword: k }) })),
  ];
  const session = await browserFactory();
  const ads = []; let stopped = null; let first = true;
  try {
    for (const j of jobs) {
      if (!first) await sleep(MIN_PACE_MS + Math.floor(Math.random() * 1500));
      first = false;
      try {
        const got = await session.visit(j.url);
        log(`${j.source}: ${got.length} ads`);
        for (const a of got) ads.push({ ...a, source: j.source });
      } catch (e) {
        if (e instanceof WallError) { stopped = `${e.message} at ${j.source}`; break; }
        log(`${j.source}: failed (${e.message})`);
      }
    }
  } finally { await session.close(); }
  return { ads, stopped };
}

/** Real headful Chrome session. Not used by tests. */
export async function launchBrowser({ scrolls = 8 } = {}) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: false, executablePath: CHROME, args: ['--no-sandbox', '--disable-setuid-sandbox'], defaultViewport: { width: 1400, height: 1000 }, userDataDir: join(ROOT, 'data/ad-structures/.chrome-profile') });
  return {
    async visit(url) {
      const page = await browser.newPage();
      const text = [];
      page.on('response', async (res) => {
        if (!res.url().includes('/api/graphql')) return;
        try { text.push(await res.text()); } catch { /* body unavailable */ }
      });
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await defaultSleep(MIN_PACE_MS);
        const scripts = await page.evaluate(() => [...document.querySelectorAll('script')].map(s => s.textContent).filter(t => t.includes('ad_archive_id')));
        text.push(...scripts);
        const body = await page.evaluate(() => document.body.innerText.slice(0, 600));
        if (/log in to continue|log into facebook|captcha|security check/i.test(body)) throw new WallError('login wall or captcha');
        let stable = 0, last = -1;
        for (let i = 0; i < scrolls && stable < 3; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await defaultSleep(MIN_PACE_MS + Math.random() * 1500);
          const n = new Set(text.join('\n').match(/"ad_archive_id":"\d+"/g) || []).size;
          stable = n === last ? stable + 1 : 0; last = n;
        }
        return parseLibraryResponse(text.join('\n'));
      } finally { await page.close(); }
    },
    close: () => browser.close(),
  };
}

// ---------- refresh ----------

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function renderReport({ date, candidates, stopped, collected }) {
  const L = [`# Ad structure candidates ${date}`, '', `Collected ${collected} ads; ${candidates.length} body-care statics running long enough.`];
  if (stopped) L.push('', `**Stopped early:** ${stopped}`);
  for (const c of candidates) {
    L.push('', `## ${c.id} (${c.days} days, ${c.format})`, `- Brand: ${c.brand}`, `- Ad: ${c.adLibraryUrl}`, `- Structure: ${c.summary}`,
      c.nonTransferable.length ? `- NON-TRANSFERABLE: ${c.nonTransferable.join('; ')}` : '- Transferable: nothing flagged',
      `- Image: ${c.image}`, `- Approve: node agents/ad-concepts/research.js --approve ${c.id}`);
  }
  return L.join('\n') + '\n';
}

export async function refresh({ dir = DATA_DIR, brandKeys = null, keywords = true, minDays = 90, browserFactory = launchBrowser, anthropic, fetchImage, compress, notify = realNotify, now = Date.now(), sleep = defaultSleep, log = console.log } = {}) {
  const cfg = JSON.parse(readFileSync(join(dir, 'brands.json'), 'utf8'));
  const brands = brandKeys ? cfg.brands.filter(b => brandKeys.includes(b.key)) : cfg.brands;
  const { ads, stopped } = await collect({ brands, keywords: keywords ? cfg.keywords : [], browserFactory, sleep, log });
  const ranked = rankCandidates(ads, { minDays, now });
  const date = new Date(now).toISOString().slice(0, 10);
  const outDir = join(dir, 'candidates'); mkdirSync(outDir, { recursive: true });
  const { CREATIVE_MODELS } = await import('../../config/creative-models.js');
  const candidates = []; const errors = [];
  for (const a of ranked) {
    const brand = a.pageName || a.source;
    const id = `${slug(brand)}-${a.id}`;
    try {
      const raw = await fetchImage(a.images[0]);
      const jpg = await compress(raw);
      const imageName = `${date}-${id}.jpg`;
      writeFileSync(join(outDir, imageName), jpg);
      const msg = await anthropic.messages.create({
        model: CREATIVE_MODELS.adStudio.verify, max_tokens: 800,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpg.toString('base64') } },
          { type: 'text', text: buildTagPrompt(a) },
        ] }],
      });
      if (msg.stop_reason === 'max_tokens') throw new Error('tag response cut off at the token limit');
      const tag = parseTagResponse((msg.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
      candidates.push({ id, brand, adId: a.id, adLibraryUrl: `https://www.facebook.com/ads/library/?id=${a.id}`, startDate: new Date(a.start * 1000).toISOString().slice(0, 10), days: a.days, primaryText: a.body, headline: a.title, linkUrl: a.linkUrl, image: imageName, ...tag });
    } catch (e) { errors.push(`${id}: ${e.message}`); }
  }
  writeFileSync(join(outDir, `${date}.json`), JSON.stringify({ date, stopped, errors, candidates }, null, 2));
  writeFileSync(join(outDir, `${date}.md`), renderReport({ date, candidates, stopped, collected: ads.length }));
  await notify({ subject: `Ad structure refresh: ${candidates.length} candidate(s)${stopped ? ' (stopped early)' : ''}`, body: `See data/ad-structures/candidates/${date}.md. ${errors.length} tagging error(s). ${stopped || ''}`, status: 'info', category: 'ad-structures' });
  return { candidates, stopped, errors, date };
}

// ---------- approve ----------

/** Layouts whose structure can be completed from a sibling library entry with no human input. */
const AUTO_LAYOUTS = ['comment-card', 'headline-over-photo', 'photo-only'];

function findCandidate(dir, id) {
  const cdir = join(dir, 'candidates');
  const files = existsSync(cdir) ? readdirSync(cdir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse() : [];
  for (const f of files) {
    const c = (JSON.parse(readFileSync(join(cdir, f), 'utf8')).candidates || []).find(x => x.id === id);
    if (c) return c;
  }
  return null;
}

function needsHuman(dir, c, why) {
  const p = join(dir, 'candidates', `${c.id}.needs-human.md`);
  writeFileSync(p, `# ${c.id} needs a human\n\n${why}\n\n- Format tagged: ${c.format}\n- Ad: ${c.adLibraryUrl}\n- Days running: ${c.days}\n- Structure: ${c.summary}\n\nlibrary.json was not touched.\n`);
  return { written: false, reason: why, note: p };
}

export async function approveCandidate(id, { dir = DATA_DIR } = {}) {
  const c = findCandidate(dir, id);
  if (!c) throw new Error(`unknown candidate "${id}"`);
  const libPath = join(dir, 'library.json');
  const raw = JSON.parse(readFileSync(libPath, 'utf8'));
  if ((raw.structures || []).some(s => s.id === id)) return { written: false, reason: 'already in library' };
  if (c.nonTransferable?.length) return { written: false, reason: `non-transferable: ${c.nonTransferable.join('; ')}` };
  if (!AUTO_LAYOUTS.includes(c.format)) return needsHuman(dir, c, `No automatic layout mapping for format "${c.format}" (auto-approvable: ${AUTO_LAYOUTS.join(', ')}). Build the entry by hand.`);
  const tpl = (raw.structures || []).find(s => s.layout === c.format);
  if (!tpl) return needsHuman(dir, c, `No existing "${c.format}" structure to borrow scene and slots from.`);
  const layoutRatios = LAYOUT_REGISTRY[c.format].ratios.filter(r => RUN_RATIOS.includes(r));
  const imageRel = `sources/${c.image}`;
  const entry = {
    id: c.id, name: `${c.brand}: ${c.summary}`.slice(0, 120), status: 'candidate',
    sources: [{ brand: c.brand, days: c.days, adLibraryUrl: c.adLibraryUrl, image: imageRel }],
    layout: c.format, ratio: layoutRatios[0], ratios: layoutRatios,
    fits: tpl.fits, requires: tpl.requires || [], people: 'none',
    scene: tpl.scene, slots: tpl.slots || {},
    notes: `CANDIDATE from the research refresh; scene and slots were borrowed from "${tpl.id}" and need review before promotion. ${c.summary}`,
  };
  const next = { ...raw, structures: [...raw.structures, entry] };
  // Validate through loadLibrary on a scratch copy; real files are touched only once it passes.
  mkdirSync(join(dir, 'sources'), { recursive: true });
  const dest = join(dir, imageRel);
  const existed = existsSync(dest);
  copyFileSync(join(dir, 'candidates', c.image), dest);
  const scratch = join(dir, `library.check-${process.pid}.json`);
  writeFileSync(scratch, JSON.stringify(next));
  try { loadLibrary(scratch); }
  catch (e) { if (!existed) unlinkSync(dest); return needsHuman(dir, c, `Automatic entry failed library validation: ${e.message}`); }
  finally { unlinkSync(scratch); }
  writeFileSync(libPath, JSON.stringify(next, null, 2) + '\n');
  return { written: true, entry };
}

// ---------- CLI ----------

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  if (args.includes('--approve')) {
    const r = await approveCandidate(val('--approve'));
    console.log(r.written ? `Added candidate-status entry ${r.entry.id}. Promote it to approved by hand after review.` : `Not added: ${r.reason}${r.note ? `\nNote: ${r.note}` : ''}`);
    return;
  }
  if (!args.includes('--refresh')) { console.error('usage: research.js --refresh [--brands a,b] [--no-keywords] [--min-days N] | --approve <id>'); process.exit(64); }
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const { default: sharp } = await import('sharp');
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const fetchImage = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`image ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const compress = (buf) => sharp(buf).resize({ width: 900, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
  const brandKeys = val('--brands') ? val('--brands').split(',') : null;
  const r = await refresh({ brandKeys, keywords: !args.includes('--no-keywords'), minDays: Number(val('--min-days') || 90), anthropic, fetchImage, compress });
  console.log(`${r.candidates.length} candidates written for ${r.date}${r.stopped ? `; STOPPED: ${r.stopped}` : ''}`);
  if (r.stopped) process.exitCode = 2;
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (e) => {
    console.error(e);
    try { await realNotify({ subject: 'Ad structure refresh failed', body: e.message, status: 'error', category: 'ad-structures' }); } catch { /* digest unavailable */ }
    process.exit(1);
  });
}
