#!/usr/bin/env node
/**
 * Content Remediator
 *
 * The "improve the content" repair for the editorial gate. When the editor
 * flags CONTENT-substance blockers (ingredient accuracy, brand voice, topical
 * relevance, factual concerns, overall quality) that the mechanical repair
 * agents (link-repair, schema-injector, faq-rewriter) can't fix, this revises
 * data/posts/<slug>/content.html via Claude to address exactly those issues,
 * then leaves it for the caller to re-run the editor. Only the blockers the
 * editor named are touched — links, schema, and structure are preserved.
 *
 * Backs up the original to backups/ before writing. Throws (does not save) on
 * truncated output (see lib/html-output-guards.js) so a half-written post never
 * reaches Shopify.
 *
 * Usage:
 *   node agents/content-remediator/index.js --slug <slug>
 */

import Anthropic from '../../lib/anthropic.js';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getContentPath, getEditorReportPath, getBackupsDir, ensurePostDir, ROOT,
} from '../../lib/posts.js';
import { parseEditorBlockers, contentBlockers, formatBlockersForPrompt } from '../../lib/editor-remediation.js';
import { reviseWithLinkGuard } from '../../lib/content-revision.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : null;
}

function loadJson(p, fallback) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  const slug = arg('--slug');
  if (!slug) {
    console.error('Usage: node agents/content-remediator/index.js --slug <slug>');
    process.exit(1);
  }

  const contentPath = getContentPath(slug);
  const reportPath = getEditorReportPath(slug);
  const original = readFileSync(contentPath, 'utf8');
  const report = readFileSync(reportPath, 'utf8');

  // content-remediator revises PROSE SUBSTANCE. Two section types are NOT its job
  // and it must not attempt them:
  //   - Factual concerns / citations: owned by citation-finder (cite or soften).
  //     Asking the reviser to "fix unsourced claims" makes it add citation links,
  //     which trips the externalLinksAdded guard below → throws (exit 1) and, via
  //     the dashboard's remediate-live-post.js, crashes the whole Fix-blockers run.
  //   - Overall Quality: a SUMMARY, not a concrete issue — it resolves once the
  //     underlying sections do (and reconcileOverallQuality clears a stale one).
  const NOT_PROSE = /factual|citation|uncited|unsourced|credibility|overall quality/i;
  const blockers = contentBlockers(parseEditorBlockers(report)).filter((b) => !NOT_PROSE.test(b.section));
  if (blockers.length === 0) {
    console.log(`  content-remediator: no prose-substance blockers for "${slug}" (citation/overall are handled by citation-finder / gate reconciliation) — nothing to revise.`);
    return;
  }
  console.log(`  content-remediator: ${blockers.length} content blocker(s) for "${slug}": ${blockers.map((b) => b.section).join(', ')}`);

  const env = loadEnv();
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const config = loadJson(join(ROOT, 'config', 'site.json'), {});
  const ingredients = loadJson(join(ROOT, 'config', 'ingredients.json'), {});
  const writerRules = (() => {
    try { return readFileSync(join(ROOT, 'data', 'context', 'writer-standing-rules.md'), 'utf8'); } catch { return ''; }
  })();

  const prompt = `You are revising a Real Skin Care blog post to fix specific issues an editor flagged. Real Skin Care: ${config.brand_description || 'natural skincare and personal care brand'}.

EDITOR BLOCKERS TO FIX (fix ONLY these):
${formatBlockersForPrompt(blockers)}

PRODUCT/INGREDIENT REFERENCE (use for ingredient-accuracy fixes):
${JSON.stringify(ingredients).slice(0, 4000)}

${writerRules ? `WRITER STANDING RULES:\n${writerRules.slice(0, 2000)}\n` : ''}
HARD CONSTRAINTS — violating these makes the revision unusable:
- Return ONLY the complete revised HTML. No preamble, no explanation, no code fences.
- Preserve EVERY <a href="..."> link and its anchor text exactly. Do not add, remove, or change links (broken links are repaired by a different tool).
- Preserve all <script type="application/ld+json"> schema blocks unchanged.
- Preserve the overall HTML structure, heading hierarchy, and approximate length (±10%).
- Change ONLY what is needed to resolve the flagged blockers. Do not rewrite passages that are fine.
- Keep the brand voice: warm, conversational, plain language, short sentences.

ORIGINAL POST HTML:
${original}`;

  // The revise → validate loop lives in lib/content-revision.js so it is testable
  // without a network call. The guards are unchanged and still FATAL — a revision
  // that drops a link, fabricates a source or comes back truncated is never
  // saved. The one thing that changed: a dropped link now earns exactly ONE more
  // attempt, with the missing anchors named in the prompt. On 2026-08-21
  // "Revision dropped links (16 < 19) — refusing to save" reached the digest as a
  // failure; the guard was right, but the model had never been told what it lost.
  const nowDate = new Date();
  const { revised, attempts } = await reviseWithLinkGuard({
    original,
    basePrompt: prompt,
    now: { year: nowDate.getFullYear(), month: nowDate.getMonth() + 1 },
    callModel: async (p) => {
      const res = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: p }],
      });
      return {
        text: (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''),
        stopReason: res.stop_reason,
      };
    },
  });

  // Back up the original, then write the revision.
  ensurePostDir(slug);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  copyFileSync(contentPath, join(getBackupsDir(slug), `content-${stamp}.html`));
  writeFileSync(contentPath, revised);

  console.log(`  content-remediator: revised "${slug}" (${blockers.length} blocker(s) addressed in ${attempts} attempt(s); backup saved).`);
  await notify({
    subject: `Content remediated: ${slug}`,
    body: `Revised ${slug} to address editor blockers: ${blockers.map((b) => b.section).join(', ')}.`,
    status: 'success',
  }).catch(() => {});
}

// Only run when invoked directly — importing this module must not start a live
// revision (it writes content.html and can exit the host process).
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    notify({ subject: 'Content Remediator failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error(`  content-remediator error: ${err.message}`);
    process.exit(1);
  });
}
