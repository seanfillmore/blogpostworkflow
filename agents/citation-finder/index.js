#!/usr/bin/env node
/**
 * Citation Finder
 *
 * Closes the YMYL "uncited health claim" gate that prose-revision can't: for each
 * claim the editor flags as lacking a source, it web-searches authoritative
 * domains (PubMed / journals / .gov / .edu), has Claude verify the source
 * actually supports the claim, and only then inserts an inline citation link.
 * Claims with no verifiable authoritative source are never fabricated. Instead
 * they are SOFTENED — rewritten to drop the research/statistic/absolute-health
 * framing that trips the YMYL gate — so the gate stops dead-ending on a claim no
 * source exists for. Anything still flagged after softening is reported for a
 * human. Pass --no-soften to cite-only and leave residuals untouched.
 *
 * Operates on data/posts/<slug>/content.html (backs it up first). Re-running the
 * editor afterward should drop the uncited-claim count.
 *
 * Usage:
 *   node agents/citation-finder/index.js --slug <slug> [--max <n>] [--no-soften]
 */
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { getContentPath, getBackupsDir, ensurePostDir, ROOT } from '../../lib/posts.js';
import { findUncitedClaims, softenClaimsInHtml } from '../../lib/citation-check.js';
import { claimSearchQuery, isAuthoritativeSource, insertCitation, AUTHORITATIVE_DOMAINS } from '../../lib/citation-finder.js';
import { searchWeb } from '../../lib/tavily.js';
import { assertHtmlComplete, externalLinksAdded } from '../../lib/html-output-guards.js';
import { notify } from '../../lib/notify.js';

const countLinks = (html) => (html.match(/<a\s/gi) || []).length;
const stripFences = (t) => t.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
const loadJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };

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

/**
 * Escape hatch for claims with NO verifiable authoritative source. We never
 * fabricate a citation, but leaving an uncited health/statistical assertion
 * fails the YMYL gate forever (the dead-end this closes). Instead, soften ONLY
 * those sentences so they no longer assert a sourceable fact — removing the gate
 * trigger without inventing a source. Returns revised HTML, or null if the model
 * added a link / produced junk (guarded — fail closed, leave for a human).
 */
async function softenUnsourcedClaims(anthropic, html, claims, { brand }) {
  const list = claims.map((c, i) => `${i + 1}. "${c}"`).join('\n');
  const prompt = `You are editing a Real Skin Care blog post. ${brand || 'Natural skincare and personal care brand.'}

We searched authoritative sources (PubMed, journals, .gov/.edu) and could NOT verify the CLAIM sentences below. We must not invent a citation. Instead, soften ONLY these exact sentences so they no longer assert a sourceable scientific/medical fact, while keeping the post readable and on-topic.

CLAIMS TO SOFTEN (rewrite each in place; change nothing else):
${list}

The rewritten sentence must NOT contain any of:
- references to studies/research/trials/data/surveys that show/prove/suggest/find something
- statistics or percentages presented as findings
- "clinically/scientifically/medically proven", "clinical trial", "doctors recommend"
- absolute health claims ("kills bacteria", "cures", "prevents infection")
Replace them with honest, general, consumer-friendly phrasing ("many people find…", "is often used to…", "may help…") that makes no research-backed or absolute claim. Keep it brief and in the same spot.

HARD CONSTRAINTS — violating these makes the result unusable:
- Return ONLY the complete revised HTML. No preamble, no explanation, no code fences.
- Do NOT add, remove, or change any <a href> link. Add no new links or URLs of any kind.
- Preserve all <script type="application/ld+json"> schema blocks, structure, headings, and approximate length.
- Change ONLY the listed claim sentences.

ORIGINAL POST HTML:
${html}`;

  const res = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });
  const revised = stripFences((res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));

  // Fail closed: any guard violation → discard, keep original, report for human.
  try { assertHtmlComplete({ html: revised, stopReason: res.stop_reason }); } catch { return null; }
  if (revised.length < html.length * 0.6) return null;            // truncated/over-deleted
  if (externalLinksAdded(html, revised).length) return null;      // must not fabricate a source
  if (countLinks(revised) < countLinks(html)) return null;        // dropped a real link
  return revised;
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
  let changed = false;
  const unresolved = []; // full claim text (not truncated) so softening can act on it
  for (const { text } of claims) {
    const results = await searchWeb(tavilyKey, claimSearchQuery(text), { maxResults: 6, includeDomains: AUTHORITATIVE_DOMAINS });
    const candidates = results.filter((r) => isAuthoritativeSource(r.url));
    let chosen = null;
    for (const cand of candidates) {
      if (await sourceSupportsClaim(anthropic, text, cand)) { chosen = cand; break; }
    }
    if (!chosen) { unresolved.push(text); continue; }
    const { html: updated, inserted } = insertCitation(html, text, chosen.url);
    if (inserted) { html = updated; cited++; changed = true; console.log(`    ✓ cited: "${text.slice(0, 60)}…" → ${chosen.url}`); }
    else { unresolved.push(text); }
  }

  // Escape hatch: soften the claims we couldn't source so the YMYL gate stops
  // dead-ending on them. Two stages: (1) an LLM rewrite for the best prose, and
  // (2) a DETERMINISTIC soften that is guaranteed to clear the gate. Stage 2 means
  // a tripped guard in stage 1 no longer leaves the post blocked "for a human" —
  // uncited claims always resolve to softened, publishable copy. Never fabricates.
  const config = loadJson(join(ROOT, 'config', 'site.json'), {});
  let softened = 0;
  let stillFlagged = unresolved.map((t) => t.slice(0, 80));
  if (unresolved.length && !process.argv.includes('--no-soften')) {
    console.log(`  citation-finder: softening ${unresolved.length} unsourceable claim(s)…`);
    // Stage 1 — LLM rewrite (best prose; discarded if it trips a guard).
    const revised = await softenUnsourcedClaims(anthropic, html, unresolved, { brand: config.brand_description });
    if (revised) {
      html = revised;
      changed = true;
    } else {
      console.log('  citation-finder: LLM soften discarded (guard tripped) — applying deterministic soften.');
    }
    // Stage 2 — deterministic guarantee for anything still flagged. Targeted
    // substring edits (no whole-HTML rewrite), so this cannot be discarded.
    if (findUncitedClaims(html).length) {
      const det = softenClaimsInHtml(html);
      if (det.changed) { html = det.html; changed = true; }
    }
    stillFlagged = findUncitedClaims(html).map((c) => c.text.slice(0, 80));
    softened = Math.max(0, unresolved.length - stillFlagged.length);
  }

  if (changed) {
    assertHtmlComplete({ html });
    ensurePostDir(slug);
    copyFileSync(contentPath, join(getBackupsDir(slug), `content-${new Date().toISOString().replace(/[:.]/g, '-')}.html`));
    writeFileSync(contentPath, html);
  }

  console.log(`  citation-finder: cited ${cited}/${claims.length}; softened ${softened}; still flagged ${stillFlagged.length}.`);
  if (stillFlagged.length) console.log(`    still flagged (need human sourcing):\n      - ${stillFlagged.join('\n      - ')}`);

  await notify({
    subject: `Citation Finder: ${slug} (${cited} cited, ${softened} softened, ${stillFlagged.length} unresolved)`,
    body: `${slug}: added ${cited} verified citation(s); softened ${softened} unsourceable claim(s).${stillFlagged.length ? `\nStill needing human sourcing:\n- ${stillFlagged.join('\n- ')}` : ''}`,
    status: stillFlagged.length ? 'info' : 'success',
  }).catch(() => {});
}

main().catch((err) => {
  notify({ subject: 'Citation Finder failed', body: err.message || String(err), status: 'error' }).catch(() => {});
  console.error(`  citation-finder error: ${err.message}`);
  process.exit(1);
});
