#!/usr/bin/env node
/**
 * Publish /pages/giveaway-offer on draw day.
 *
 *   node scripts/giveaway/publish-offer-page.mjs           # dry run
 *   node scripts/giveaway/publish-offer-page.mjs --apply
 *
 * WHY THIS IS ON A TIMER AND NOT DONE BY HAND. The page is the destination of
 * all three consolation sends, the first of which is scheduled for
 * 2026-09-16 22:00 UTC. If it is still unpublished then, every one of those
 * emails links to a 404 — and it is the campaign's only revenue event, so there
 * is no second chance and nothing else in the system would notice.
 *
 * WHY IT REFUSES TO PUBLISH EARLY, AND WHY THAT IS THE WHOLE POINT.
 * The page opens "We drew the winner. It wasn't you." Published during an open
 * Entry Period that sentence is FALSE, it is visible to people who are still
 * entering, and it is indexable. So the window is enforced in code rather than
 * left to whoever runs it: before OPENS_AT the script refuses. `--force` exists
 * for a deliberate rehearsal and says loudly what it is doing.
 *
 * It also refuses AFTER the offer closes, which is what makes the annual cron
 * re-fire (`30 19 16 9 *` has no year field) a no-op in 2027 rather than a
 * resurrection of a dead offer.
 *
 * Idempotent: a page that is already published is reported and left alone.
 * Verifies the live URL returns 200 after publishing — `published_at` being set
 * is Shopify's opinion, not evidence the page renders.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../../lib/shopify.js';
import { API_VERSION } from '../../lib/shopify-api-version.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { OPENS_AT, CLOSES_AT, CLOSES_HUMAN } from '../../lib/giveaway/consolation-offer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PAGE_HANDLE = 'giveaway-offer';
export const PAGE_URL = `https://www.realskincare.com/pages/${PAGE_HANDLE}`;

/**
 * May the offer page be published right now?
 *
 * Pure so the window rule is covered by tests rather than discovered on a live
 * storefront during an open promotion.
 */
export function publishDecision(now, { opensAt = OPENS_AT, closesAt = CLOSES_AT, force = false } = {}) {
  // Accept a Date, an ISO string or an epoch number. Date.parse(<number>) is
  // NaN, and a NaN comparison is false in BOTH directions — the window check
  // would silently allow every publish rather than refusing.
  const t = now instanceof Date ? now.getTime()
    : typeof now === 'number' ? now
      : Date.parse(now);
  if (!Number.isFinite(t)) throw new Error(`publishDecision: unusable timestamp ${JSON.stringify(now)}`);
  const opens = Date.parse(opensAt);
  const closes = Date.parse(closesAt);
  if (t < opens) {
    return {
      ok: force,
      reason: `the offer opens at ${opensAt} — publishing now would put "We drew the winner. It wasn't you." `
        + 'in front of people who are still entering, on an indexable page',
    };
  }
  if (t > closes) {
    return { ok: false, reason: `the offer closed at ${closesAt} (${CLOSES_HUMAN} PT) — nothing to publish` };
  }
  return { ok: true, reason: 'inside the offer window' };
}

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');

  const decision = publishDecision(new Date(), { force });
  console.log(`Window: ${OPENS_AT} → ${CLOSES_AT}`);
  console.log(`Decision: ${decision.ok ? 'MAY PUBLISH' : 'REFUSE'} — ${decision.reason}`);
  if (force && Date.now() < Date.parse(OPENS_AT)) {
    console.warn('  --force: publishing BEFORE the draw. The page says the winner has been drawn.');
  }

  const env = loadEnv();
  const token = await getAccessToken();
  const base = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}`;
  const H = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  const list = await (await fetch(`${base}/pages.json?limit=250`, { headers: H })).json();
  const page = (list.pages || []).find((p) => p.handle === PAGE_HANDLE);
  if (!page) throw new Error(`no page with handle ${PAGE_HANDLE} — create it before draw day`);

  if (page.published_at) {
    console.log(`Already published (${page.published_at}) — nothing to do.`);
    return;
  }
  if (!decision.ok) { process.exitCode = 0; return; }
  if (!apply) { console.log('\nDry run — re-run with --apply to publish.'); return; }

  const res = await fetch(`${base}/pages/${page.id}.json`, {
    method: 'PUT',
    headers: H,
    body: JSON.stringify({ page: { id: page.id, published: true } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`publish failed ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  console.log(`Published page ${page.id} at ${body.page.published_at}`);

  // published_at is Shopify's opinion. Ask the storefront.
  await new Promise((r) => setTimeout(r, 3000));
  const live = await fetch(PAGE_URL, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await live.text();
  const ok = live.status === 200 && html.includes('$99') && html.includes('$66');
  console.log(`Live check: ${PAGE_URL} -> ${live.status}${ok ? ' (both tiers render)' : ' — CONTENT CHECK FAILED'}`);
  if (!ok) throw new Error('page published but does not render both tiers');
}

if (isDirectRun(import.meta.url)) {
  await main();
}
