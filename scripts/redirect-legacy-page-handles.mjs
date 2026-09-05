#!/usr/bin/env node
/**
 * 301 the two CONVENTIONAL page handles at the real pages. Dry by default; --apply writes.
 *
 * `/pages/about` and `/pages/contact` both 404. Each has a Shopify page object
 * behind it with `published_at: null` — legacy duplicates left over when the live
 * copy moved to `about-us-1` and `contact-1`. Found while auditing theme templates
 * (PR #776); pre-existing and unrelated to that work.
 *
 * WHY REDIRECT RATHER THAN DELETE OR PUBLISH — the evidence, measured 2026-09-05:
 *
 *   - NOTHING LIVE LINKS TO EITHER. Scanned all 211 articles, 43 pages, 90
 *     collections and 21 products: exactly one hit, `/pages/contact` from
 *     `page:faq` — and that page is ITSELF unpublished and 404s. Dead linking to
 *     dead.
 *   - No GSC impressions in 30 days of snapshots, which is worth NOTHING as
 *     evidence: a 404 cannot appear in search, so its absence there is expected
 *     and proves only that the page is broken. Do not read it as "nobody wants it".
 *   - No redirect exists at either path (of 230 on the store).
 *
 *   DELETE is rejected: `contact` holds 342 characters of real copy, and deleting
 *   `about` would orphan `templates/page.about.json`, which that page is currently
 *   the only user of. Neither turns a 404 into anything better.
 *
 *   PUBLISH is rejected harder: it would create genuine duplicate About and
 *   Contact pages competing with the live `about-us-1` / `contact-1` — the
 *   collection-fragmentation mistake wearing new clothes.
 *
 *   REDIRECT is what is left, and its value is GUESSABILITY rather than measured
 *   traffic: `/pages/about` and `/pages/contact` are the conventional Shopify
 *   handles — what a person types, what an old directory listing carries, what an
 *   external site guesses when linking to a Shopify store. Two more redirects on a
 *   store already running 230 cost nothing and are reversible.
 *
 * A Shopify URL redirect only fires where the URL would otherwise 404, which is
 * exactly the state these two are in. That is asserted rather than assumed: the run
 * re-checks each path is still a 404 BEFORE creating its redirect, and refuses the
 * entry if the page has been published in the meantime — redirecting a live page
 * away from itself is the one way this script could destroy something.
 *
 * VERIFYING AFTERWARDS NEEDS A CACHE-BUSTER, and without one the run looks failed.
 * Immediately after creation both paths still answered 404 on a plain request —
 * the CDN was serving the cached 404 from before the redirect existed. The same
 * URL with `?cb=<random>` answered 301 straight away and resolved 200 at the
 * target. An unpublished page object does NOT squat the handle, which was the
 * other candidate explanation and would have meant redirects could never work
 * here. Always cache-bust when checking a freshly created redirect, or you will
 * conclude a working one is broken and go looking for a cause that is not there.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPages, getRedirects, createRedirect } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');
const STORE = 'https://www.realskincare.com';

const PLAN = [
  { path: '/pages/about', target: '/pages/about-us-1', handle: 'about' },
  { path: '/pages/contact', target: '/pages/contact-1', handle: 'contact' },
  // Added 2026-09-05. Same shape as the two above, found by following the one
  // inbound link they had. `faq` is an unpublished 155-character stub on a dead
  // GemPages template (`gem-46224867363-template`) whose entire body is one
  // sentence pointing at /pages/contact — it holds no FAQ content, so nothing is
  // lost by redirecting it. The real page is `faqs`, which is live, carries the
  // Q&A, and is what the site footer already links on every page.
  { path: '/pages/faq', target: '/pages/faqs', handle: 'faq' },
];

async function status(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return res.status;
}

async function main() {
  const pages = await getPages({ limit: 250 });
  const redirects = await getRedirects({ limit: 250 });
  const results = [];

  for (const entry of PLAN) {
    const src = pages.find((p) => p.handle === entry.handle);
    const dest = pages.find((p) => p.handle === entry.target.replace('/pages/', ''));

    if (!dest || !dest.published_at) {
      throw new Error(`${entry.path}: target ${entry.target} is missing or unpublished — refusing.`);
    }
    if (src && src.published_at) {
      console.error(`  ${entry.path}: SKIPPED — that page is PUBLISHED now; redirecting it would take a live page off itself.`);
      results.push({ ...entry, outcome: 'source-now-published' });
      continue;
    }
    const existing = redirects.find((r) => r.path === entry.path);
    if (existing) {
      console.log(`  ${entry.path}: already redirects to ${existing.target}.`);
      results.push({ ...entry, outcome: 'already-exists', target: existing.target });
      continue;
    }

    // A redirect only fires on a 404. Assert that rather than trusting the page record.
    const before = await status(`${STORE}${entry.path}`);
    if (before !== 404) {
      console.error(`  ${entry.path}: SKIPPED — live status is ${before}, not 404. Nothing to redirect.`);
      results.push({ ...entry, outcome: `live-${before}` });
      continue;
    }
    const destStatus = await status(`${STORE}${entry.target}`);
    if (destStatus !== 200) {
      throw new Error(`${entry.path}: target ${entry.target} answers ${destStatus}, not 200 — refusing.`);
    }

    if (!APPLY) {
      console.log(`  ${entry.path} (404) → ${entry.target} (200): would create.`);
      results.push({ ...entry, outcome: 'would-create' });
      continue;
    }
    const made = await createRedirect(entry.path, entry.target);
    console.log(`  ${entry.path} → ${entry.target}: CREATED (id ${made?.id ?? '?'})`);
    results.push({ ...entry, outcome: 'created', id: made?.id ?? null });
  }

  if (APPLY && results.some((r) => r.outcome === 'created')) {
    const dir = join('data', 'reports', 'legacy-page-redirects');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`),
      JSON.stringify({ at: new Date().toISOString(), results }, null, 2)
    );
  }
  if (!APPLY) console.log('\nDRY RUN — pass --apply to create.');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
