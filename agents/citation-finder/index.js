#!/usr/bin/env node
/**
 * Citation Finder
 *
 * Closes the YMYL "uncited health claim" gate that prose-revision can't: for each
 * claim the editor flags as lacking a source, it web-searches authoritative
 * domains (PubMed / journals / .gov / .edu), has Claude verify the source
 * actually supports the claim, and only then inserts an inline citation link.
 * Claims with no verifiable authoritative source are left untouched (never
 * fabricated) and reported for human sourcing.
 *
 * Operates on data/posts/<slug>/content.html (backs it up first). Re-running the
 * editor afterward should drop the uncited-claim count.
 *
 * Usage:
 *   node agents/citation-finder/index.js --slug <slug> [--max <n>]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getContentPath, getBackupsDir, ensurePostDir, ROOT } from '../../lib/posts.js';
import { findUncitedClaims } from '../../lib/citation-check.js';
import { claimSearchQuery, isAuthoritativeSource, insertCitation, AUTHORITATIVE_DOMAINS } from '../../lib/citation-finder.js';
import { searchWeb } from '../../lib/tavily.js';
import { assertHtmlComplete } from '../../lib/html-output-guards.js';
import { notify } from '../../lib/notify.js';

function loadEnv() {
  try {
    const env = {};
    for (const l of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}
const arg = (n) => { const i = process.argv.indexOf(n); return i !== -1 ? process.argv[i + 1] : null; };

// Ask Claude whether a candidate source actually supports the claim (anti-hallucination guard).
async function sourceSupportsClaim(anthropic, claim, cand) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `A blog post makes this health/scientific CLAIM:\n"${claim}"\n\nCandidate source to cite:\nURL: ${cand.url}\nTITLE: ${cand.title}\nEXCERPT: ${String(cand.content).slice(0, 2500)}\n\nDoes this source genuinely support the CLAIM? Be strict — only SUPPORTED if the excerpt clearly backs it.\nReply exactly: VERDICT: SUPPORTED | UNSUPPORTED | UNCLEAR`,
      }],
    });
    const raw = (msg.content || []).map((b) => b.text || '').join('');
    return /VERDICT:\s*SUPPORTED/i.test(raw);
  } catch { return false; }
}

async function main() {
  const slug = arg('--slug');
  const max = parseInt(arg('--max') || '12', 10);
  if (!slug) { console.error('Usage: node agents/citation-finder/index.js --slug <slug> [--max <n>]'); process.exit(1); }

  const env = loadEnv();
  const tavilyKey = env.TAVILY_API_KEY || process.env.TAVILY_API_KEY;
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY });
  if (!tavilyKey) { console.error('  citation-finder: no TAVILY_API_KEY — cannot search for sources.'); process.exit(1); }

  const contentPath = getContentPath(slug);
  let html = readFileSync(contentPath, 'utf8');
  const claims = findUncitedClaims(html).slice(0, max);
  if (claims.length === 0) {
    console.log(`  citation-finder: no uncited claims for "${slug}".`);
    return;
  }
  console.log(`  citation-finder: ${claims.length} uncited claim(s) in "${slug}".`);

  let cited = 0;
  const unresolved = [];
  for (const { text } of claims) {
    const results = await searchWeb(tavilyKey, claimSearchQuery(text), { maxResults: 6, includeDomains: AUTHORITATIVE_DOMAINS });
    const candidates = results.filter((r) => isAuthoritativeSource(r.url));
    let chosen = null;
    for (const cand of candidates) {
      if (await sourceSupportsClaim(anthropic, text, cand)) { chosen = cand; break; }
    }
    if (!chosen) { unresolved.push(text.slice(0, 80)); continue; }
    const { html: updated, inserted } = insertCitation(html, text, chosen.url);
    if (inserted) { html = updated; cited++; console.log(`    ✓ cited: "${text.slice(0, 60)}…" → ${chosen.url}`); }
    else { unresolved.push(text.slice(0, 80)); }
  }

  if (cited > 0) {
    assertHtmlComplete({ html });
    ensurePostDir(slug);
    copyFileSync(contentPath, join(getBackupsDir(slug), `content-${new Date().toISOString().replace(/[:.]/g, '-')}.html`));
    writeFileSync(contentPath, html);
  }

  console.log(`  citation-finder: cited ${cited}/${claims.length}; unresolved ${unresolved.length}.`);
  if (unresolved.length) console.log(`    unresolved (need human sourcing):\n      - ${unresolved.join('\n      - ')}`);

  await notify({
    subject: `Citation Finder: ${slug} (${cited} cited, ${unresolved.length} unresolved)`,
    body: `Added ${cited} verified citation(s) to ${slug}.${unresolved.length ? `\nUnresolved claims needing human sourcing:\n- ${unresolved.join('\n- ')}` : ''}`,
    status: unresolved.length ? 'info' : 'success',
  }).catch(() => {});
}

main().catch((err) => {
  notify({ subject: 'Citation Finder failed', body: err.message || String(err), status: 'error' }).catch(() => {});
  console.error(`  citation-finder error: ${err.message}`);
  process.exit(1);
});
