#!/usr/bin/env node
/**
 * Theme SEO Auditor Agent
 *
 * Crawls one representative URL per Shopify template type (homepage, product,
 * collection, blog post, page) using Puppeteer for full JS rendering, then
 * audits DOM structure and runs Lighthouse for performance/SEO/accessibility.
 *
 * Usage:
 *   node agents/theme-seo-auditor/index.js
 *   node agents/theme-seo-auditor/index.js --type product
 *
 * Output:
 *   data/reports/theme-seo-audit/latest.json
 *   data/reports/theme-seo-audit/theme-seo-audit.md
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
import {
  getProducts,
  getCustomCollections,
  getSmartCollections,
  getBlogs,
  getArticles,
  getPages,
} from '../../lib/shopify.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'theme-seo-audit');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const typeFilter = args.includes('--type') ? args[args.indexOf('--type') + 1] : null;

// ── DOM audit functions ──────────────────────────────────────────────────────

function auditHeadings(html) {
  const h1s = (html.match(/<h1[\s>]/gi) || []).length;
  const headings = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => parseInt(m[1]));
  let hierarchyValid = true;
  for (let i = 1; i < headings.length; i++) {
    if (headings[i] > headings[i - 1] + 1) { hierarchyValid = false; break; }
  }
  return { h1_count: h1s, heading_hierarchy_valid: hierarchyValid };
}

function auditMeta(html) {
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html);
  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  const ogTitle = /<meta[^>]+property=["']og:title["']/i.test(html);
  const ogDesc = /<meta[^>]+property=["']og:description["']/i.test(html);
  const ogImage = /<meta[^>]+property=["']og:image["']/i.test(html);
  const ogUrl = /<meta[^>]+property=["']og:url["']/i.test(html);
  const twitterCard = /<meta[^>]+name=["']twitter:card["']/i.test(html);
  return {
    canonical_present: !!canonical,
    canonical_href: canonical ? canonical[1] : null,
    viewport_present: viewport,
    og_tags: { title: ogTitle, description: ogDesc, image: ogImage, url: ogUrl },
    twitter_tags: { card: twitterCard },
  };
}

function auditImages(html) {
  const imgs = [...html.matchAll(/<img[^>]*>/gi)];
  const withAlt = imgs.filter((m) => /alt=["'][^"']+["']/i.test(m[0]));
  return {
    image_count: imgs.length,
    images_with_alt: withAlt.length,
    alt_coverage: imgs.length > 0 ? withAlt.length / imgs.length : 1,
  };
}

function countStructuredData(html) {
  return (html.match(/<script[^>]+type=["']application\/ld\+json["']/gi) || []).length;
}

// ── URL selection ────────────────────────────────────────────────────────────

async function selectUrls() {
  const urls = {};

  // Homepage
  urls.homepage = config.url;

  // Product
  try {
    const products = await getProducts();
    if (products.length > 0) {
      urls.product = `${config.url}/products/${products[0].handle}`;
    }
  } catch (e) {
    console.warn(`  Could not fetch products: ${e.message}`);
  }

  // Collection
  try {
    const customs = await getCustomCollections();
    const smarts = await getSmartCollections();
    const all = [...customs, ...smarts];
    if (all.length > 0) {
      urls.collection = `${config.url}/collections/${all[0].handle}`;
    }
  } catch (e) {
    console.warn(`  Could not fetch collections: ${e.message}`);
  }

  // Blog post
  try {
    const blogs = await getBlogs();
    if (blogs.length > 0) {
      const articles = await getArticles(blogs[0].id);
      if (articles.length > 0) {
        urls.blog_post = `${config.url}/blogs/news/${articles[0].handle}`;
      }
    }
  } catch (e) {
    console.warn(`  Could not fetch blog posts: ${e.message}`);
  }

  // Page
  try {
    const pages = await getPages();
    if (pages.length > 0) {
      urls.page = `${config.url}/pages/${pages[0].handle}`;
    }
  } catch (e) {
    console.warn(`  Could not fetch pages: ${e.message}`);
  }

  return urls;
}

// ── Issue compilation ────────────────────────────────────────────────────────

function compileIssues(headings, meta, images, structuredDataCount, lighthouseScores) {
  const issues = [];

  if (headings.h1_count === 0) {
    issues.push({ severity: 'critical', message: 'No H1 tag found' });
  } else if (headings.h1_count > 1) {
    issues.push({ severity: 'warning', message: `Multiple H1 tags found (${headings.h1_count})` });
  }

  if (!headings.heading_hierarchy_valid) {
    issues.push({ severity: 'warning', message: 'Heading hierarchy skips levels' });
  }

  if (!meta.canonical_present) {
    issues.push({ severity: 'critical', message: 'Missing canonical tag' });
  }

  if (!meta.viewport_present) {
    issues.push({ severity: 'critical', message: 'Missing viewport meta tag' });
  }

  if (!meta.og_tags.title || !meta.og_tags.description || !meta.og_tags.image || !meta.og_tags.url) {
    const missing = Object.entries(meta.og_tags).filter(([, v]) => !v).map(([k]) => k);
    issues.push({ severity: 'warning', message: `Missing OG tags: ${missing.join(', ')}` });
  }

  if (!meta.twitter_tags.card) {
    issues.push({ severity: 'warning', message: 'Missing twitter:card meta tag' });
  }

  if (images.alt_coverage < 0.8) {
    issues.push({ severity: 'warning', message: `Image alt coverage ${Math.round(images.alt_coverage * 100)}% (< 80%)` });
  }

  if (structuredDataCount === 0) {
    issues.push({ severity: 'warning', message: 'No JSON-LD structured data found' });
  }

  if (lighthouseScores) {
    if (lighthouseScores.performance < 50) {
      issues.push({ severity: 'warning', message: `Lighthouse performance score ${lighthouseScores.performance}/100` });
    }
    if (lighthouseScores.seo < 80) {
      issues.push({ severity: 'warning', message: `Lighthouse SEO score ${lighthouseScores.seo}/100` });
    }
    if (lighthouseScores.accessibility < 80) {
      issues.push({ severity: 'warning', message: `Lighthouse accessibility score ${lighthouseScores.accessibility}/100` });
    }
  }

  return issues;
}

// ── Lighthouse ───────────────────────────────────────────────────────────────

// Lighthouse has NO internal wall-clock ceiling, and a stall is not an error —
// the try/catch below cannot see one. On 2026-09-01 this hung for FOUR DAYS on
// the production box, holding ~334 MB (a node process plus six orphaned Chrome
// processes) on a 1 GB droplet with no swap, which is what drove the OOM killer
// to kill `seo-dashboard` 642 times and take the dashboard off the air. Every
// monthly job after this one (content-gap, device weights) silently never ran,
// and nothing reported it, because the process never exited to record a failure.
//
// 180s is ~30x the only healthy sample in 52 days of scheduler logs (5.7s) and
// well past a slow cold Lighthouse run on a 1-vCPU box. A timeout DEGRADES the
// report (that template loses its `lighthouse` block, the DOM audits are kept)
// rather than failing the run — same shape as the existing catch.
const LIGHTHOUSE_TIMEOUT_MS = 180_000;

function withTimeout(promise, ms, label) {
  let timer;
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    timer.unref?.(); // never hold the event loop open on this timer alone
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

// `browser.close()` is itself a promise that can hang — it waits on a CDP
// round-trip to a Chrome that may be the very thing that is wedged. A finally
// block awaiting it forever is not a guarantee, so fall back to SIGKILL on the
// browser's own OS process. Never throws: this runs in a finally, and masking
// the original error with a close failure would hide why the run stopped.
const BROWSER_CLOSE_TIMEOUT_MS = 15_000;

async function closeBrowser(browser) {
  try {
    await withTimeout(browser.close(), BROWSER_CLOSE_TIMEOUT_MS, 'browser.close()');
  } catch (e) {
    console.warn(`  Browser did not close cleanly (${e.message}); killing it`);
    try {
      browser.process()?.kill('SIGKILL');
    } catch (killErr) {
      console.warn(`  Could not kill browser process: ${killErr.message}`);
    }
  }
}

async function runLighthouse(url, browserPort) {
  try {
    const result = await withTimeout(
      lighthouse(url, {
        port: browserPort,
        output: 'json',
        onlyCategories: ['performance', 'seo', 'accessibility'],
        formFactor: 'mobile',
        screenEmulation: { mobile: true, width: 375, height: 812, deviceScaleFactor: 2 },
      }),
      LIGHTHOUSE_TIMEOUT_MS,
      `Lighthouse for ${url}`,
    );

    const lhr = result.lhr;
    return {
      performance: Math.round((lhr.categories.performance?.score || 0) * 100),
      seo: Math.round((lhr.categories.seo?.score || 0) * 100),
      accessibility: Math.round((lhr.categories.accessibility?.score || 0) * 100),
      lcp_ms: Math.round(lhr.audits['largest-contentful-paint']?.numericValue || 0),
      cls: parseFloat((lhr.audits['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
      tbt_ms: Math.round(lhr.audits['total-blocking-time']?.numericValue || 0),
      failures: Object.values(lhr.audits)
        .filter((a) => a.score === 0 && a.title && a.details?.type !== 'debugdata')
        .map((a) => a.title)
        .slice(0, 10),
    };
  } catch (e) {
    console.warn(`  Lighthouse failed for ${url}: ${e.message}`);
    return null;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  Theme SEO Auditor');
  console.log('  =================\n');

  // Select URLs
  console.log('  Selecting representative URLs...');
  const allUrls = await selectUrls();

  // Filter by type if specified
  const urls = {};
  if (typeFilter) {
    if (allUrls[typeFilter]) {
      urls[typeFilter] = allUrls[typeFilter];
    } else {
      console.error(`  No URL found for type: ${typeFilter}`);
      console.error(`  Available types: ${Object.keys(allUrls).join(', ')}`);
      process.exit(1);
    }
  } else {
    Object.assign(urls, allUrls);
  }

  console.log(`  Auditing ${Object.keys(urls).length} template(s): ${Object.keys(urls).join(', ')}\n`);

  // Launch browser
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const browserPort = parseInt(new URL(browser.wsEndpoint()).port);

  const results = {};

  // try/finally, NOT a bare `await browser.close()` after the loop: anything
  // that throws or is cut short between launch and close orphans the whole
  // Chrome process tree, which is exactly the 4-day leak described above. The
  // finally runs on the throw path too, so the browser dies whatever happens.
  try {
    for (const [templateType, url] of Object.entries(urls)) {
      console.log(`  [${templateType}] ${url}`);

      // Render page with Puppeteer
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
      } catch (e) {
        console.warn(`    Page load error: ${e.message}`);
        await page.close();
        results[templateType] = { url, error: e.message };
        continue;
      }
      const html = await page.content();
      await page.close();

      // DOM audits
      const headings = auditHeadings(html);
      const meta = auditMeta(html);
      const images = auditImages(html);
      const structuredDataCount = countStructuredData(html);

      console.log(`    H1s: ${headings.h1_count}, hierarchy: ${headings.heading_hierarchy_valid ? 'valid' : 'INVALID'}`);
      console.log(`    Canonical: ${meta.canonical_present ? meta.canonical_href : 'MISSING'}`);
      console.log(`    Images: ${images.image_count} (${Math.round(images.alt_coverage * 100)}% alt coverage)`);
      console.log(`    JSON-LD blocks: ${structuredDataCount}`);

      // Lighthouse
      console.log('    Running Lighthouse...');
      const lighthouseScores = await runLighthouse(url, browserPort);

      if (lighthouseScores) {
        console.log(`    Perf: ${lighthouseScores.performance}  SEO: ${lighthouseScores.seo}  A11y: ${lighthouseScores.accessibility}`);
        console.log(`    LCP: ${lighthouseScores.lcp_ms}ms  CLS: ${lighthouseScores.cls}  TBT: ${lighthouseScores.tbt_ms}ms`);
      }

      // Compile issues
      const issues = compileIssues(headings, meta, images, structuredDataCount, lighthouseScores);
      console.log(`    Issues: ${issues.length} (${issues.filter((i) => i.severity === 'critical').length} critical)\n`);

      results[templateType] = {
        url,
        headings,
        meta,
        images,
        structured_data_count: structuredDataCount,
        lighthouse: lighthouseScores,
        issues,
      };
    }

  } finally {
    await closeBrowser(browser);
  }

  // ── Write reports ────────────────────────────────────────────────────────────

  mkdirSync(REPORTS_DIR, { recursive: true });

  // JSON
  const jsonPath = join(REPORTS_DIR, 'latest.json');
  writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  console.log(`  JSON report: ${jsonPath}`);

  // Markdown
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [
    `# Theme SEO Audit — ${config.name}`,
    `**Run date:** ${now}`,
    `**Templates audited:** ${Object.keys(results).length}`,
    '',
  ];

  for (const [templateType, data] of Object.entries(results)) {
    lines.push(`## ${templateType.charAt(0).toUpperCase() + templateType.slice(1).replace('_', ' ')}`);
    lines.push(`**URL:** ${data.url}`);
    lines.push('');

    if (data.error) {
      lines.push(`> **Error:** ${data.error}`);
      lines.push('');
      continue;
    }

    // DOM summary
    lines.push('### DOM Audit');
    lines.push(`| Check | Result |`);
    lines.push(`|---|---|`);
    lines.push(`| H1 count | ${data.headings.h1_count} |`);
    lines.push(`| Heading hierarchy | ${data.headings.heading_hierarchy_valid ? 'Valid' : 'Invalid (skips levels)'} |`);
    lines.push(`| Canonical | ${data.meta.canonical_present ? data.meta.canonical_href : 'Missing'} |`);
    lines.push(`| Viewport | ${data.meta.viewport_present ? 'Present' : 'Missing'} |`);
    lines.push(`| OG tags | title: ${data.meta.og_tags.title ? 'yes' : 'no'}, desc: ${data.meta.og_tags.description ? 'yes' : 'no'}, image: ${data.meta.og_tags.image ? 'yes' : 'no'}, url: ${data.meta.og_tags.url ? 'yes' : 'no'} |`);
    lines.push(`| Twitter card | ${data.meta.twitter_tags.card ? 'Present' : 'Missing'} |`);
    lines.push(`| Images | ${data.images.image_count} total, ${data.images.images_with_alt} with alt (${Math.round(data.images.alt_coverage * 100)}%) |`);
    lines.push(`| JSON-LD blocks | ${data.structured_data_count} |`);
    lines.push('');

    // Lighthouse summary
    if (data.lighthouse) {
      lines.push('### Lighthouse Scores');
      lines.push(`| Metric | Value |`);
      lines.push(`|---|---|`);
      lines.push(`| Performance | ${data.lighthouse.performance}/100 |`);
      lines.push(`| SEO | ${data.lighthouse.seo}/100 |`);
      lines.push(`| Accessibility | ${data.lighthouse.accessibility}/100 |`);
      lines.push(`| LCP | ${data.lighthouse.lcp_ms}ms |`);
      lines.push(`| CLS | ${data.lighthouse.cls} |`);
      lines.push(`| TBT | ${data.lighthouse.tbt_ms}ms |`);
      lines.push('');

      if (data.lighthouse.failures.length > 0) {
        lines.push('**Failed audits:**');
        data.lighthouse.failures.forEach((f) => lines.push(`- ${f}`));
        lines.push('');
      }
    }

    // Issues
    if (data.issues.length > 0) {
      lines.push('### Issues');
      lines.push('| Severity | Issue |');
      lines.push('|---|---|');
      data.issues.forEach((issue) => {
        const icon = issue.severity === 'critical' ? '🔴' : '🟡';
        lines.push(`| ${icon} ${issue.severity} | ${issue.message} |`);
      });
      lines.push('');
    } else {
      lines.push('No issues found.');
      lines.push('');
    }
  }

  const mdPath = join(REPORTS_DIR, 'theme-seo-audit.md');
  writeFileSync(mdPath, lines.join('\n'));
  console.log(`  Markdown report: ${mdPath}`);

  // Summary
  const totalIssues = Object.values(results).reduce((sum, r) => sum + (r.issues?.length || 0), 0);
  const criticalIssues = Object.values(results).reduce((sum, r) => sum + (r.issues?.filter((i) => i.severity === 'critical').length || 0), 0);
  console.log(`\n  Total issues: ${totalIssues} (${criticalIssues} critical)`);
}

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main()
    .then(() => notifyLatestReport('Theme SEO Audit completed', REPORTS_DIR))
    // Exit EXPLICITLY on success. Lighthouse and Chrome can leave an open
    // handle behind, and node will not exit while one is pending — so a run
    // that finished its work and wrote its report could still sit forever
    // holding memory, which is what `scheduler.js` was waiting on. The report
    // and the notification are both already written by this point.
    .then(() => process.exit(0))
    .catch((err) => {
      notify({ subject: 'Theme SEO Audit failed', body: err.message || String(err), status: 'error' });
      console.error('Error:', err.message);
      process.exit(1);
    });
}
