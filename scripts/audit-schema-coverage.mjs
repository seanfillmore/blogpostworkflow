#!/usr/bin/env node
/**
 * Structured-data coverage audit — READ ONLY. Writes nothing to Shopify.
 *
 * Measures, from live, which schema.org types each published blog article actually
 * publishes, at TWO layers, because they answer different questions:
 *
 *   body   — the JSON-LD inside the article's Shopify body_html. This is the layer
 *            agents/schema-injector writes, and the only layer this repo controls.
 *   live   — the JSON-LD in the fully rendered page fetched over HTTP. This is what
 *            Google actually sees, and includes anything the THEME emits (the repo's
 *            theme/ directory is a partial mirror, so the theme layer cannot be read
 *            from the checkout — it has to be fetched).
 *
 * Usage:
 *   node scripts/audit-schema-coverage.mjs                 # both layers, all published articles
 *   node scripts/audit-schema-coverage.mjs --no-live       # body_html only (no HTTP fetches)
 *   node scripts/audit-schema-coverage.mjs --limit 10      # sample
 *   node scripts/audit-schema-coverage.mjs --out <path>    # JSON report destination
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBlogs, getArticles } from '../lib/shopify.js';
import { auditHtml, summarizeCoverage, TRACKED_TYPES } from '../lib/schema-audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const arg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const doLive = !args.includes('--no-live');
const limit = arg('--limit') ? Number(arg('--limit')) : Infinity;
const outPath = arg('--out') || join(ROOT, 'data', 'reports', 'schema-audit', 'coverage.json');

const SITE = 'https://www.realskincare.com';

async function fetchLive(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'RSC-schema-audit/1.0 (read-only structured data audit)' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return { ok: false, status: res.status, html: '' };
    return { ok: true, status: res.status, html: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message || err), html: '' };
  }
}

async function main() {
  const blogs = await getBlogs();
  const records = [];

  for (const blog of blogs) {
    let sinceId = 0;
    for (;;) {
      const batch = await getArticles(blog.id, { limit: 250, since_id: sinceId });
      if (!batch.length) break;
      for (const a of batch) {
        sinceId = Math.max(sinceId, a.id);
        if (!a.published_at) continue;               // drafts are not in search
        records.push({ blogHandle: blog.handle, id: a.id, handle: a.handle, title: a.title, body_html: a.body_html || '' });
      }
      if (batch.length < 250) break;
    }
  }

  const chosen = records.slice(0, limit);
  console.log(`Published articles: ${records.length}${chosen.length < records.length ? ` (auditing ${chosen.length})` : ''}`);

  const rows = [];
  for (const r of chosen) {
    const url = `${SITE}/blogs/${r.blogHandle}/${r.handle}`;
    const body = auditHtml(r.body_html);
    let live = null;
    let httpStatus = null;
    if (doLive) {
      const got = await fetchLive(url);
      httpStatus = got.status;
      live = got.ok ? auditHtml(got.html) : null;
      process.stdout.write('.');
    }
    rows.push({ id: r.id, handle: r.handle, blog: r.blogHandle, title: r.title, url, httpStatus, body, live });
  }
  if (doLive) process.stdout.write('\n');

  const bodySummary = summarizeCoverage(rows.map((r) => r.body));
  const liveRows = rows.filter((r) => r.live);
  const liveSummary = summarizeCoverage(liveRows.map((r) => r.live));

  const report = {
    generated_at: new Date().toISOString(),
    site: SITE,
    published_articles: records.length,
    audited: rows.length,
    live_fetched: liveRows.length,
    body_summary: bodySummary,
    live_summary: liveSummary,
    rows,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : '—');
  console.log('\ntype             body_html        live page');
  console.log('---------------------------------------------');
  for (const t of TRACKED_TYPES) {
    const b = bodySummary.byType[t], l = liveSummary.byType[t];
    console.log(`${t.padEnd(16)} ${String(b).padStart(3)} (${pct(b, bodySummary.total).padStart(4)})   ${String(l).padStart(3)} (${pct(l, liveSummary.total).padStart(4)})`);
  }
  console.log(`${'(no schema)'.padEnd(16)} ${String(bodySummary.bare).padStart(3)} (${pct(bodySummary.bare, bodySummary.total).padStart(4)})   ${String(liveSummary.bare).padStart(3)} (${pct(liveSummary.bare, liveSummary.total).padStart(4)})`);
  console.log(`\nReport: ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
