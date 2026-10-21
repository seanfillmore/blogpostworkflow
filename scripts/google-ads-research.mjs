#!/usr/bin/env node
/**
 * Google ads research — what are competitors running on Google, and for how long?
 *
 * A HAND-RUN research tool, not an agent: nothing schedules it and it writes
 * nothing anywhere but its own report folder. Reads the Google Ads Transparency
 * Center through DataForSEO (lib/dataforseo.js → getGoogleAdsTransparency) and
 * builds a browsable report, longest-running ads first — the same "run length
 * is the only public performance signal" approach used for the Meta library.
 *
 * Usage:
 *   node scripts/google-ads-research.mjs piperwai.com wellnesse.com
 *   node scripts/google-ads-research.mjs --advertiser AR07092063201331773441
 *   node scripts/google-ads-research.mjs --find "PiperWai"        # look up advertiser IDs by name
 *   options: --min-days 90   --live-only   --format text|image|video
 *            --label <name>  --no-media (skip preview fetching)  --region 2840
 *
 * Output: data/reports/google-ads-research/<date>-<label>/report.html (+ ads.json,
 * media/). Gitignored — it is research output, regenerable on demand.
 *
 * RUN IT ON THE PRODUCTION SERVER. DataForSEO whitelists API callers by IP and
 * only the server's is on the list; from anywhere else every call answers
 * "Access denied. Your IP is not whitelisted". Copy the folder back with scp.
 *
 * Cost: ~$0.003 per domain or advertiser (measured 2026-10-20). The preview
 * fetches are free and go to Google's own CDN, 4 at a time.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findGoogleAdvertisers, getGoogleAdsTransparency } from '../lib/dataforseo.js';
import { runPool } from '../lib/fetch-pool.js';
import { extractPreviewMedia, normaliseAd, sortByLongevity } from '../lib/ads-transparency.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_IMAGES_PER_AD = 4;

function parseArgs(argv) {
  const opts = { targets: [], advertiserIds: [], minDays: 0, liveOnly: false, format: null, media: true, region: 2840, label: null, find: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--advertiser') opts.advertiserIds.push(argv[++i]);
    else if (a === '--find') opts.find = argv[++i];
    else if (a === '--min-days') opts.minDays = Number(argv[++i]) || 0;
    else if (a === '--live-only') opts.liveOnly = true;
    else if (a === '--format') opts.format = argv[++i];
    else if (a === '--no-media') opts.media = false;
    else if (a === '--region') opts.region = Number(argv[++i]);
    else if (a === '--label') opts.label = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.targets.push(a.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''));
  }
  return opts;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function download(url, file) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const ext = type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : 'jpg';
    const name = `${file}.${ext}`;
    return { buf: Buffer.from(await res.arrayBuffer()), name };
  } catch {
    return null;
  }
}

/** Resolve what each ad actually shows. Mutates ad.media; never throws. */
async function enrich(ads, mediaDir) {
  const tally = { screenshot: 0, youtube: 0, shopping: 0, image: 0, unresolved: 0 };
  await runPool(ads, async (ad, idx) => {
    ad.media = { files: [], youtubeIds: [], shopping: [] };
    const sources = [];
    if (ad.previewImage) sources.push(ad.previewImage);
    if (ad.previewScript) {
      try {
        const res = await fetch(ad.previewScript, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
          const m = extractPreviewMedia(await res.text());
          ad.media.youtubeIds = m.youtubeIds;
          ad.media.shopping = m.shopping;
          for (const id of m.youtubeIds) sources.push(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
          for (const s of m.shopping) if (s.image) sources.push(s.image);
          sources.push(...m.images);
        }
      } catch { /* unresolved — the Transparency Center link still works */ }
    }
    for (const [n, url] of [...new Set(sources)].slice(0, MAX_IMAGES_PER_AD).entries()) {
      const got = await download(url, `${idx}-${n}`);
      if (got) {
        writeFileSync(join(mediaDir, got.name), got.buf);
        ad.media.files.push(`media/${got.name}`);
      }
    }
    if (ad.media.youtubeIds.length) tally.youtube++;
    else if (ad.media.shopping.length) tally.shopping++;
    else if (ad.previewImage && ad.media.files.length) tally.screenshot++;
    else if (ad.media.files.length) tally.image++;
    else tally.unresolved++;
  }, { concurrency: 4 });
  return tally;
}

function card(ad) {
  const imgs = ad.media?.files?.map((f) => `<a href="${esc(f)}" target="_blank"><img src="${esc(f)}" loading="lazy" alt=""></a>`).join('') || '<div class="none">No preview recovered. Open it in the Transparency Center.</div>';
  const yt = (ad.media?.youtubeIds || []).map((id) => `<a href="https://www.youtube.com/watch?v=${esc(id)}" target="_blank">Watch on YouTube ↗</a>`).join(' · ');
  const shop = (ad.media?.shopping || []).map((s) => `<div class="shop"><b>${esc(s.title || '')}</b>${s.merchant ? ` <span>· ${esc(s.merchant)}</span>` : ''}</div>`).join('');
  return `<article class="card">
  <header><span class="days">${ad.days == null ? '?' : ad.days} days</span>${ad.live ? '<span class="live">LIVE</span>' : '<span class="off">stopped</span>'}<span class="fmt">${esc(ad.format)}</span></header>
  <div class="media">${imgs}</div>
  ${shop}
  <footer><div>${esc(ad.advertiser || '')}${ad.verified ? ' ✓' : ''}</div><div class="dates">${esc((ad.firstShown || '').slice(0, 10))} → ${esc((ad.lastShown || '').slice(0, 10))}</div>
  <div class="links">${ad.transparencyUrl ? `<a href="${esc(ad.transparencyUrl)}" target="_blank">Transparency Center ↗</a>` : ''}${yt ? ` · ${yt}` : ''}</div></footer>
</article>`;
}

function renderHtml({ title, generatedAt, sections, filters }) {
  const body = sections.map((s) => {
    const advertisers = [...new Set(s.all.map((a) => a.advertiser).filter(Boolean))];
    const fm = {};
    for (const a of s.all) fm[a.format] = (fm[a.format] || 0) + 1;
    const live = s.all.filter((a) => a.live).length;
    const long = s.all.filter((a) => (a.days ?? 0) >= 180).length;
    const summary = s.error
      ? `<p class="err">${esc(s.error)}</p>`
      : `<p class="sum">${s.all.length} ads · ${live} live · ${long} running 180+ days · ${Object.entries(fm).map(([k, v]) => `${v} ${esc(k)}`).join(', ')}${advertisers.length ? ` · advertiser${advertisers.length > 1 ? 's' : ''}: ${advertisers.map(esc).join(', ')}` : ''}${s.shown.length !== s.all.length ? ` · showing ${s.shown.length} after filters` : ''}</p>`;
    return `<section><h2>${esc(s.label)}</h2>${summary}<div class="grid">${s.shown.map(card).join('')}</div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a66;--line:#e2e0da;--accent:#2f6b4f;--warn:#a5481e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--ink:#ecebe7;--muted:#9c9a94;--line:#34332f;--accent:#7cc39c;--warn:#f0956a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,sans-serif;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 4px}.meta,.sum{color:var(--muted);margin:0 0 12px}.err{color:var(--warn)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.card header{display:flex;gap:6px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line)}
.days{font-weight:700}.live{color:var(--accent);font-size:11px;font-weight:700}.off{color:var(--muted);font-size:11px}.fmt{margin-left:auto;color:var(--muted);font-size:12px}
.media{padding:8px;display:flex;flex-direction:column;gap:6px}.media img{width:100%;border-radius:6px;border:1px solid var(--line);background:#fff}
.none{color:var(--muted);font-size:12px;padding:12px 4px}.shop{padding:0 10px 6px;font-size:13px}.shop span{color:var(--muted)}
.card footer{margin-top:auto;padding:8px 10px;border-top:1px solid var(--line);font-size:12px}.dates{color:var(--muted)}a{color:var(--accent)}
</style></head><body>
<h1>${esc(title)}</h1>
<p class="meta">Google Ads Transparency Center via DataForSEO · generated ${esc(generatedAt)} · sorted by days running (first → last shown). ${esc(filters)}
Run length is the only performance signal here; there is no spend, impression or targeting data.</p>
${body}
</body></html>`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.find && !opts.targets.length && !opts.advertiserIds.length)) {
    console.log('Usage: node scripts/google-ads-research.mjs <domain...> [--advertiser AR...] [--find "Brand"] [--min-days N] [--live-only] [--format text|image|video] [--label name] [--no-media]');
    process.exit(opts.help ? 0 : 64);
  }

  if (opts.find) {
    const rows = await findGoogleAdvertisers(opts.find, { locationCode: opts.region });
    if (!rows.length) console.log(`No advertiser names match "${opts.find}".`);
    for (const r of rows) {
      console.log(r.type === 'ads_domain'
        ? `domain      ${r.domain}`
        : `advertiser  ${r.advertiser_id}  ${r.title}${r.verified ? ' ✓' : ''}  ~${r.approx_ads_count ?? '?'} ads  ${r.location || ''}`);
    }
    if (!opts.targets.length && !opts.advertiserIds.length) return;
  }

  const jobs = [
    ...opts.targets.map((t) => ({ label: t, who: { target: t } })),
    ...(opts.advertiserIds.length ? [{ label: `advertiser ${opts.advertiserIds.join(', ')}`, who: { advertiserIds: opts.advertiserIds } }] : []),
  ];
  const label = opts.label || slug(jobs.map((j) => j.who.target || 'advertisers').join('-'));
  const outDir = join(ROOT, 'data/reports/google-ads-research', `${new Date().toISOString().slice(0, 10)}-${label}`);
  const mediaDir = join(outDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  const now = new Date();
  const sections = [];
  let cost = 0;
  for (const job of jobs) {
    process.stdout.write(`${job.label}: `);
    try {
      const { items, cost: c } = await getGoogleAdsTransparency(job.who, { locationCode: opts.region });
      cost += c;
      const all = sortByLongevity(items.map((i) => normaliseAd(i, { now })));
      const shown = all.filter((a) => (a.days ?? 0) >= opts.minDays
        && (!opts.liveOnly || a.live)
        && (!opts.format || a.format === opts.format));
      console.log(`${all.length} ads, ${shown.length} after filters`);
      sections.push({ label: job.label, all, shown });
    } catch (err) {
      const hint = /whitelist/i.test(err.message)
        ? ' (run this on the production server; DataForSEO only accepts its IP)'
        : '';
      console.log(`FAILED ${err.message}${hint}`);
      sections.push({ label: job.label, all: [], shown: [], error: `${err.message}${hint}` });
    }
  }

  const shownAds = sections.flatMap((s) => s.shown);
  if (opts.media && shownAds.length) {
    console.log(`Resolving previews for ${shownAds.length} ads…`);
    const t = await enrich(shownAds, mediaDir);
    console.log(`  screenshots ${t.screenshot} · YouTube ${t.youtube} · Shopping ${t.shopping} · other images ${t.image} · unresolved ${t.unresolved}`);
  }

  const filters = [
    opts.minDays ? `min ${opts.minDays} days` : null,
    opts.liveOnly ? 'live only' : null,
    opts.format ? `format ${opts.format}` : null,
  ].filter(Boolean).join(', ');
  writeFileSync(join(outDir, 'ads.json'), JSON.stringify({ generated_at: now.toISOString(), region: opts.region, cost_usd: cost, sections }, null, 2));
  writeFileSync(join(outDir, 'report.html'), renderHtml({
    title: `Google ads research: ${jobs.map((j) => j.label).join(', ')}`,
    generatedAt: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    sections,
    filters: filters ? `Filters: ${filters}.` : '',
  }));
  console.log(`DataForSEO cost $${cost.toFixed(4)}`);
  console.log(`Report: ${join(outDir, 'report.html')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
