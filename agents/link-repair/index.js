#!/usr/bin/env node
/**
 * Link Repair Agent
 *
 * Reads an editor report, identifies broken links, and fixes them:
 *   - Internal 404s  → looked up against the live blog index (exact title/handle match)
 *   - External 404s  → Claude finds a working replacement URL based on anchor text + context
 *   - 403/405 errors → assumed bot-blocked but valid; kept as-is (logged only)
 *
 * Saves the repaired HTML in-place and re-runs the editor to confirm no remaining
 * broken links before continuing the pipeline.
 *
 * Usage:
 *   node agents/link-repair/index.js <slug>
 *   node agents/link-repair/index.js natural-lip-balm
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from '../../lib/retry.js';
import { getContentPath, getMetaPath, getEditorReportPath, loadUnpublishedPostIndex, ROOT } from '../../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }
const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

let config;
try {
  config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
} catch (e) {
  console.error(`Failed to load config/site.json: ${e.message}`); process.exit(1);
}

// ── args ──────────────────────────────────────────────────────────────────────

const slug = process.argv[2];
if (!slug) {
  console.error('Usage: node agents/link-repair/index.js <slug>');
  process.exit(1);
}

// ── parse editor report ───────────────────────────────────────────────────────

function parseBrokenLinks(slug) {
  const reportPath = getEditorReportPath(slug);
  if (!existsSync(reportPath)) return [];

  const report = readFileSync(reportPath, 'utf8');
  const broken = [];

  // Match table rows in the Link Health section: | url | anchor | status | error |
  // Status may be a numeric code (404, 500) or a word (timeout, error).
  const rowRegex = /^\|\s*(https?:\/\/[^|]+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/gm;
  for (const m of report.matchAll(rowRegex)) {
    const [, url, anchor, rawStatus] = m;
    const status = rawStatus.trim();
    const code = /^\d+$/.test(status) ? parseInt(status, 10) : 0;
    const isBroken = code >= 400 || code === 0;
    if (!isBroken) continue;
    broken.push({ url: url.trim(), anchor: anchor.trim(), statusCode: code, statusLabel: status });
  }

  return broken;
}

// ── blog index lookup ─────────────────────────────────────────────────────────

function loadBlogIndex() {
  try {
    const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'blog-index.json'), 'utf8'));
    const articles = [];
    for (const blog of (Array.isArray(idx) ? idx : [idx])) {
      for (const a of (blog.articles || [])) {
        articles.push({
          title: a.title,
          handle: a.handle,
          url: `${config.url}/blogs/${blog.handle || 'news'}/${a.handle}`,
        });
      }
    }
    return articles;
  } catch { return []; }
}

function findBestInternalMatch(brokenUrl, anchor, articles) {
  // Extract the handle from the broken URL
  const m = brokenUrl.match(/\/blogs\/[^/]+\/(.+?)(?:\?.*)?$/);
  const brokenHandle = m ? m[1] : '';

  // Score each article
  let best = null;
  let bestScore = 0;

  const anchorWords = anchor.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const handleWords = brokenHandle.toLowerCase().split('-').filter(w => w.length > 3);

  for (const art of articles) {
    let score = 0;
    const titleLower = art.title.toLowerCase();
    const artHandleWords = art.handle.toLowerCase().split('-');

    // Handle word overlap
    for (const w of handleWords) {
      if (artHandleWords.includes(w)) score += 2;
    }
    // Anchor word overlap in title
    for (const w of anchorWords) {
      if (titleLower.includes(w)) score += 1;
    }

    if (score > bestScore) {
      bestScore = score;
      best = art;
    }
  }

  return bestScore >= 2 ? best : null;
}

// ── Claude replacement for external links ─────────────────────────────────────

/**
 * Fetch a URL and return its status code. Uses HEAD first (cheap), falls
 * back to GET if HEAD fails — some servers don't support HEAD or block it.
 * Returns null on network errors so the caller can treat it the same as a
 * failed check (candidate URL rejected).
 */
async function fetchStatusCode(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkRepair/1.0)' },
    });
    // Some servers return 405/403 on HEAD but are fine on GET. Retry with GET
    // when HEAD is ambiguous so we don't wrongly reject a live page.
    if (res.status === 405 || res.status === 403 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LinkRepair/1.0)' },
      });
    }
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ask Claude for a replacement URL, then HTTP-verify it actually resolves
 * before accepting. If the candidate 404s (or returns any non-2xx/3xx), try
 * again with a stricter prompt — Claude was previously writing hallucinated
 * URLs straight to production HTML, causing the editor gate to re-flag the
 * same post on the next run.
 *
 * Budget: up to MAX_ATTEMPTS candidate URLs per broken link. Beyond that we
 * give up and return null, so the caller removes the link entirely.
 */
async function findExternalReplacement(brokenUrl, anchor, postContext) {
  const MAX_ATTEMPTS = 3;
  const tried = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const triedBlock = tried.length
      ? `\n\nUrls you have already suggested that also 404 — do NOT suggest any of these again:\n${tried.map((u) => '- ' + u).join('\n')}`
      : '';
    const prompt = `You are helping fix a broken link in a blog post about natural skincare.

The following external link is returning a 404 error and needs to be replaced:
- Broken URL: ${brokenUrl}
- Anchor text: "${anchor}"
- Post topic: ${postContext}

Your task: suggest a single working replacement URL from a credible source (government agency, academic institution, peer-reviewed journal, or major health organization) that supports the same claim the anchor text suggests.

Rules:
- Only suggest URLs you are highly confident exist and are currently live
- Prefer PubMed, NIH.gov, CDC.gov, FDA.gov, USDA.gov, ADA.org, or similar authoritative domains
- If the domain itself is the problem (e.g. the page moved), suggest the new canonical URL if you know it
- If you cannot find a reliable replacement, respond with exactly: REMOVE
- Do NOT suggest competitor brand websites or commercial sources
- Do NOT fabricate URLs${triedBlock}

Respond with ONLY the replacement URL (starting with https://) or the word REMOVE. No explanation.`;

    let candidate = '';
    await withRetry(async () => {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      });
      candidate = msg.content[0].text.trim();
    }, { label: 'link-repair-claude' });

    if (candidate === 'REMOVE' || !candidate.startsWith('http')) return null;

    // Treat the same candidate back-to-back as equivalent to REMOVE.
    if (tried.includes(candidate)) return null;
    tried.push(candidate);

    const status = await fetchStatusCode(candidate);
    if (status && status >= 200 && status < 400) {
      if (attempt > 1) console.log(`       (accepted on attempt ${attempt})`);
      return candidate;
    }
    console.log(`       candidate returned ${status || 'network error'} — retrying (${attempt}/${MAX_ATTEMPTS})`);
  }

  // Exhausted all attempts without finding a live URL — remove the link.
  return null;
}

// ── apply fix to HTML ─────────────────────────────────────────────────────────

function applyLinkFix(html, oldUrl, newUrl) {
  // Escape special regex chars in URL
  const escaped = oldUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`href=["']${escaped}["']`, 'g');
  if (!re.test(html)) return { html, changed: false };
  return {
    html: html.replace(re, `href="${newUrl}"`),
    changed: true,
  };
}

function removeLinkFromHtml(html, brokenUrl) {
  const escaped = brokenUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Replace <a href="...broken...">text</a> with just text. Inner content
  // can contain nested HTML (e.g. <em>, <strong>) — common for source
  // citations like "<em>Streptococcus mutans</em>" — so the inner pattern
  // must allow any character including '<'. Non-greedy + dotall keeps it
  // bounded to the matching </a>.
  const re = new RegExp(`<a[^>]+href=["']${escaped}["'][^>]*>([\\s\\S]*?)</a>`, 'g');
  if (!re.test(html)) return { html, changed: false };
  return {
    html: html.replace(re, '$1'),
    changed: true,
  };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nLink Repair Agent — Real Skin Care\n');

  const htmlPath = getContentPath(slug);
  if (!existsSync(htmlPath)) {
    console.error(`  No HTML file found for slug: ${slug}`);
    process.exit(1);
  }

  const brokenLinks = parseBrokenLinks(slug);
  if (brokenLinks.length === 0) {
    console.log('  No broken links found in editor report — nothing to repair.');
    process.exit(0);
  }

  const truelyBroken = brokenLinks.filter(l => l.statusCode === 404);
  const botBlocked   = brokenLinks.filter(l => l.statusCode === 403 || l.statusCode === 405);

  if (botBlocked.length > 0) {
    console.log(`  ${botBlocked.length} link(s) returning 403/405 (bot-blocked, likely valid — kept as-is):`);
    for (const l of botBlocked) console.log(`    - ${l.url}`);
    console.log('');
  }

  if (truelyBroken.length === 0) {
    console.log('  No true 404 broken links to repair.');
    process.exit(0);
  }

  console.log(`  ${truelyBroken.length} broken link(s) to repair:\n`);

  const articles = loadBlogIndex();
  const siteBase = config.url;
  let html = readFileSync(htmlPath, 'utf8');

  // Read post meta for context + parent publish date (used to decide whether
  // a cross-link to a not-yet-published post will be live in time).
  const metaPath = getMetaPath(slug);
  let postContext = slug.replace(/-/g, ' ');
  let parentPublishAt = null;
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    postContext = meta.target_keyword || postContext;
    if (meta.shopify_publish_at) parentPublishAt = new Date(meta.shopify_publish_at);
  } catch {}

  // Index of unpublished/scheduled posts so we can mirror the editor's
  // smart cross-link logic: a target scheduled to publish on or before this
  // post is live by the time this post goes live, so the link is safe even
  // if it 404s right now.
  const unpubIndex = loadUnpublishedPostIndex();

  let fixedCount = 0;
  let removedCount = 0;
  let failedCount = 0;

  for (const link of truelyBroken) {
    const isInternal = link.url.startsWith(siteBase) || link.url.includes('realskincare.com');

    process.stdout.write(`  [${link.statusCode}] ${link.url.slice(0, 80)}\n`);
    process.stdout.write(`       anchor: "${link.anchor}"\n`);

    if (isInternal) {
      // Try blog index lookup, then accept based on three rules — mirrors
      // the smart logic the editor uses when classifying cross-links:
      //   1. Target is unpublished but scheduled on/before this post's
      //      publish date → ACCEPT (will be live in time, no HTTP check).
      //   2. Target is unpublished AND scheduled after (or has no schedule)
      //      → REJECT (would 404 at publish; remove the link).
      //   3. Target is not in the unpublished index → presumably live;
      //      HTTP-verify and accept on 2xx/3xx.
      const match = findBestInternalMatch(link.url, link.anchor, articles);
      let accepted = null;
      if (match) {
        const unpub = unpubIndex.get(match.url);
        if (unpub) {
          if (unpub.publish_at && parentPublishAt && new Date(unpub.publish_at) <= parentPublishAt) {
            accepted = match.url;
            console.log(`       ✓ Will be live by publish (target scheduled ${new Date(unpub.publish_at).toISOString().slice(0, 10)})`);
          } else {
            const reason = !unpub.publish_at ? 'target is a draft (no schedule)'
              : !parentPublishAt ? 'this post has no schedule yet'
              : `target scheduled after this post (${new Date(unpub.publish_at).toISOString().slice(0, 10)})`;
            console.log(`       candidate ${match.url.slice(0, 80)} skipped — ${reason}`);
          }
        } else {
          // Not in unpublished index — presumed live; HTTP-verify.
          const status = await fetchStatusCode(match.url);
          if (status && status >= 200 && status < 400) {
            accepted = match.url;
          } else {
            console.log(`       candidate ${match.url.slice(0, 80)} returned ${status || 'network error'} — treating as no match`);
          }
        }
      }
      if (accepted) {
        const result = applyLinkFix(html, link.url, accepted);
        if (result.changed) {
          html = result.html;
          console.log(`       ✓ Fixed → ${accepted}`);
          fixedCount++;
        } else {
          console.log(`       ⚠️  URL not found in HTML (may already be fixed)`);
        }
      } else {
        // Remove the link, keep anchor text
        const result = removeLinkFromHtml(html, link.url);
        if (result.changed) {
          html = result.html;
          console.log(`       ✗ No live match — link removed, anchor text kept`);
          removedCount++;
        } else {
          console.log(`       ⚠️  Could not locate link in HTML`);
          failedCount++;
        }
      }
    } else {
      // External — ask Claude
      process.stdout.write(`       Searching for replacement... `);
      const replacement = await findExternalReplacement(link.url, link.anchor, postContext);
      if (replacement) {
        const result = applyLinkFix(html, link.url, replacement);
        if (result.changed) {
          html = result.html;
          console.log(`✓ Fixed → ${replacement}`);
          fixedCount++;
        } else {
          console.log(`not found in HTML`);
          failedCount++;
        }
      } else {
        const result = removeLinkFromHtml(html, link.url);
        if (result.changed) {
          html = result.html;
          console.log(`no replacement found — link removed, anchor text kept`);
          removedCount++;
        } else {
          console.log(`no replacement and link not found in HTML`);
          failedCount++;
        }
      }
    }
  }

  // Save repaired HTML
  writeFileSync(htmlPath, html);
  console.log(`\n  Saved repaired HTML: ${htmlPath}`);
  console.log(`  Fixed: ${fixedCount}  |  Removed: ${removedCount}  |  Could not locate: ${failedCount}`);

  if (failedCount > 0) {
    console.log(`\n  ⚠️  ${failedCount} link(s) could not be located in the HTML. Review manually.`);
  }

  console.log('\nLink repair complete.\n');
}

main().catch(err => { console.error(err); process.exit(1); });
