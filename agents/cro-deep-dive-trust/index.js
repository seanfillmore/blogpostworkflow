#!/usr/bin/env node
/**
 * CRO Deep Dive — Trust & Conversion
 *
 * Analyzes a blog post's above-the-fold value prop, social proof signals,
 * product link framing, CTA copy specificity, and urgency/specificity claims.
 *
 * Usage:
 *   node agents/cro-deep-dive-trust/index.js --handle <handle> --item "<title>"
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, getProducts, getCustomCollections, getMetafields } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'cro', 'deep-dive');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const handleIdx = args.indexOf('--handle');
const handle = handleIdx !== -1 ? args[handleIdx + 1] : undefined;
const itemIdx = args.indexOf('--item');
const item = itemIdx !== -1 ? args[itemIdx + 1] : undefined;

if (!handle || !item) {
  console.error('Usage: node index.js --handle <handle> --item "<item title>"');
  process.exit(1);
}

// ── env loading ───────────────────────────────────────────────────────────────
function loadEnv() {
  try {
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
  } catch { return {}; }
}

const env = loadEnv();
const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

const client = new Anthropic({ apiKey });

// ── Shopify fetch ─────────────────────────────────────────────────────────────
async function fetchArticle(handle) {
  const blogs    = await getBlogs();
  const blog     = blogs.find(b => b.handle === 'news');
  if (!blog) throw new Error('Blog "news" not found');
  const articles = await getArticles(blog.id, { limit: 250 });
  const article  = articles.find(a => a.handle === handle);
  if (!article) throw new Error(`Article not found: ${handle}`);
  return article;
}

// ── Snapshot loading ──────────────────────────────────────────────────────────
function loadLatestSnapshot(subdir) {
  const dir = join(ROOT, 'data', 'snapshots', subdir);
  try {
    const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8'));
  } catch {
    return null;
  }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── Analysis step 1: above-the-fold proxy (first 200 words) ──────────────────
function extractFirstWords(html, wordLimit) {
  const text = stripTags(html);
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, wordLimit).join(' ');
}

// ── Analysis step 2: social proof signals ────────────────────────────────────
function scanSocialProof(html) {
  const text = stripTags(html);

  // Star ratings: ★ chars or patterns like "4.8★" or "4.8 stars" or "250 reviews"
  const starMatches = (html.match(/[\u2605\u2606]|\d+\.\d+[ ]*[\u2605\u2606]|\d+[ ]*stars?/gi) || []).length;
  const reviewMentions = (text.match(/\d+[ ]*reviews?/gi) || []).length;

  // Testimonial blockquotes
  const blockquoteCount = (html.match(/<blockquote[^>]*>/gi) || []).length;

  // Certification mentions
  const certKeywords = ['certified', 'organic', 'cruelty-free', 'cruelty free', 'vegan'];
  const certMatches = certKeywords.filter(kw => text.toLowerCase().includes(kw));

  return {
    starRatingMentions: starMatches,
    reviewMentions,
    blockquoteCount,
    certificationMentions: certMatches,
  };
}

// ── Analysis step 3: internal product/collection links ───────────────────────
function extractLinkedHandles(html) {
  const productHandles = new Set();
  const collectionHandles = new Set();
  const genericAnchors = [];
  const genericTerms = ['click here', 'shop now', 'here', 'learn more'];

  const anchorPattern = /<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorPattern.exec(html)) !== null) {
    const href = m[1];
    const anchorHtml = m[2];
    const anchorText = stripTags(anchorHtml).trim().toLowerCase();

    const productMatch = href.match(/\/products\/([^/?#"]+)/);
    const collectionMatch = href.match(/\/collections\/([^/?#"]+)/);

    if (productMatch) {
      productHandles.add(productMatch[1]);
      // Check for generic anchor text (no product noun = just a generic term)
      const isGeneric = genericTerms.some(t => anchorText === t);
      if (isGeneric) {
        genericAnchors.push({ href, anchorText, type: 'product' });
      }
    } else if (collectionMatch) {
      collectionHandles.add(collectionMatch[1]);
      const isGeneric = genericTerms.some(t => anchorText === t);
      if (isGeneric) {
        genericAnchors.push({ href, anchorText, type: 'collection' });
      }
    }
  }

  return {
    productHandles: [...productHandles],
    collectionHandles: [...collectionHandles],
    genericAnchors,
  };
}

// ── Analysis step 4: CTA copy audit ──────────────────────────────────────────
function auditCtaCopy(html) {
  const results = [];

  // Simpler approach: find each rsc-cta-block and extract text
  let searchFrom = 0;
  while (true) {
    const idx = html.indexOf('rsc-cta-block', searchFrom);
    if (idx === -1) break;
    // Find the enclosing div end — look ahead up to 800 chars
    const snippet = html.slice(idx, idx + 800);
    const text = stripTags(snippet).trim();
    // Take first 100 chars as representative CTA text
    const ctaText = text.slice(0, 100);
    const lower = ctaText.toLowerCase();
    // Flag if text is only generic "shop now" without any product noun
    // A product noun = any word that isn't in the generic set
    const genericOnly = /^shop now\.?$/i.test(ctaText.trim()) ||
      /^shop now\s*$/.test(ctaText.trim());
    results.push({ ctaText: ctaText.trim(), genericOnly });
    searchFrom = idx + 1;
  }

  return results;
}

// ── Analysis step 5: specificity vs vagueness ────────────────────────────────
function analyzeSpecificity(html) {
  const text = stripTags(html);
  // Split into sentences
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 10);

  const specificPatterns = [
    /\d+%/,
    /\d+\s*(days?|weeks?|months?|hours?)/i,
    // ingredient name pattern: capitalized word(s) that could be ingredient
    /\b(hyaluronic acid|retinol|niacinamide|vitamin [a-z]|glycolic acid|salicylic acid|zinc|peptide|ceramide|collagen|aloe vera|tea tree|jojoba|shea butter|argan oil)\b/i,
  ];

  const vagueAdjectives = ['effective', 'natural', 'clean', 'gentle', 'safe', 'pure', 'healthy'];
  const vaguePattern = new RegExp('\\b(' + vagueAdjectives.join('|') + ')\\b', 'i');
  const specificQualifierPattern = /\d+|percent|formula|proven|tested|clinically/i;

  let specificCount = 0;
  let vagueOnlyCount = 0;

  for (const sentence of sentences) {
    const hasSpecific = specificPatterns.some(p => p.test(sentence));
    const hasVague = vaguePattern.test(sentence);
    const hasQualifier = specificQualifierPattern.test(sentence);

    if (hasSpecific) {
      specificCount++;
    } else if (hasVague && !hasQualifier) {
      vagueOnlyCount++;
    }
  }

  return { totalSentences: sentences.length, specificCount, vagueOnlyCount };
}

// ── Analysis step 6: first paragraph benefit check ───────────────────────────
function checkFirstParagraph(html) {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (!m) return { found: false, hasSpecificBenefit: false, text: '' };

  const text = stripTags(m[1]);
  const hasNumber = /\d/.test(text);
  const hasNamedIngredient = /\b(hyaluronic acid|retinol|niacinamide|vitamin [a-z]|glycolic acid|salicylic acid|zinc|peptide|ceramide|collagen|aloe vera|tea tree|jojoba|shea butter|argan oil)\b/i.test(text);
  const hasMeasurableClaim = /\d+%|\d+\s*(days?|weeks?)/i.test(text);

  return {
    found: true,
    hasSpecificBenefit: hasNumber || hasNamedIngredient || hasMeasurableClaim,
    text: text.slice(0, 200),
  };
}

// ── Fetch review metafields for a product ────────────────────────────────────
async function fetchProductReviewData(productHandle) {
  try {
    const products = await getProducts({ handle: productHandle });
    const p = products?.[0];
    if (!p) return { found: false, handle: productHandle };

    const metafields = await getMetafields('products', p.id);
    const reviewNamespaces = ['judgeme', 'yotpo', 'okendo'];
    const reviewKeys = ['product_widget', 'main_widget', 'reviews_widget'];

    const reviewMf = metafields?.find(mf =>
      reviewNamespaces.includes(mf.namespace) && reviewKeys.includes(mf.key)
    );

    return {
      found: true,
      handle: productHandle,
      title: p.title,
      hasReviewMetafield: !!reviewMf,
      reviewNamespace: reviewMf?.namespace || null,
    };
  } catch (e) {
    console.warn(`  Could not fetch product "${productHandle}": ${e.message}`);
    return { found: false, handle: productHandle, error: e.message };
  }
}

async function fetchCollectionReviewData(collectionHandle) {
  try {
    const collections = await getCustomCollections({ handle: collectionHandle });
    const c = collections?.[0];
    if (!c) return { found: false, handle: collectionHandle };

    const metafields = await getMetafields('custom_collections', c.id);
    const reviewNamespaces = ['judgeme', 'yotpo', 'okendo'];
    const reviewKeys = ['product_widget', 'main_widget', 'reviews_widget'];

    const reviewMf = metafields?.find(mf =>
      reviewNamespaces.includes(mf.namespace) && reviewKeys.includes(mf.key)
    );

    return {
      found: true,
      handle: collectionHandle,
      title: c.title,
      hasReviewMetafield: !!reviewMf,
      reviewNamespace: reviewMf?.namespace || null,
    };
  } catch (e) {
    console.warn(`  Could not fetch collection "${collectionHandle}": ${e.message}`);
    return { found: false, handle: collectionHandle, error: e.message };
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('CRO Deep Dive — Trust & Conversion\n');
  console.log('  Handle:', handle);
  console.log('  Item:  ', item);
  console.log();

  console.log('  Fetching article from Shopify...');
  const article = await fetchArticle(handle);
  const html = article.body_html || '';
  const pageUrl = `https://www.realskincare.com/blogs/news/${handle}`;
  console.log('  Article:', article.title);

  // Step 1: Above-the-fold proxy
  console.log('  Extracting above-the-fold text...');
  const aboveFoldText = extractFirstWords(html, 200);

  // Step 2: Social proof scan
  console.log('  Scanning social proof signals...');
  const socialProof = scanSocialProof(html);

  // Step 3: Linked product/collection handles
  console.log('  Extracting linked product/collection handles...');
  const linkData = extractLinkedHandles(html);
  console.log(`  Products linked: ${linkData.productHandles.length}, Collections linked: ${linkData.collectionHandles.length}`);
  console.log(`  Generic anchor texts: ${linkData.genericAnchors.length}`);

  // Fetch review metafields for linked products/collections
  const productReviews = [];
  for (const ph of linkData.productHandles) {
    console.log(`  Fetching metafields for product: ${ph}`);
    const data = await fetchProductReviewData(ph);
    productReviews.push(data);
  }

  const collectionReviews = [];
  for (const ch of linkData.collectionHandles) {
    console.log(`  Fetching metafields for collection: ${ch}`);
    const data = await fetchCollectionReviewData(ch);
    collectionReviews.push(data);
  }

  // Step 4: CTA copy audit
  console.log('  Auditing CTA copy...');
  const ctaFindings = auditCtaCopy(html);

  // Step 5: Specificity analysis
  console.log('  Analyzing claim specificity...');
  const specificity = analyzeSpecificity(html);

  // Step 6: First paragraph check
  console.log('  Checking first paragraph...');
  const firstPara = checkFirstParagraph(html);

  // GSC per-page keyword data
  console.log('  Fetching GSC keywords for this page...');
  let gscData = null;
  try {
    const { getPageKeywords } = await import('../../lib/gsc.js');
    const keywords = await getPageKeywords(pageUrl, 5, 90);
    gscData = keywords;
    console.log(`  GSC keywords: ${gscData.length} found`);
  } catch (e) {
    console.warn('  GSC unavailable:', e.message);
  }

  // Load latest Shopify snapshot
  console.log('  Loading Shopify snapshot...');
  const shopifySnapshot = loadLatestSnapshot('shopify');
  let snapshotNote = 'Shopify snapshot unavailable';
  if (shopifySnapshot) {
    const keys = Object.keys(shopifySnapshot);
    snapshotNote = `Shopify snapshot loaded (keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''})`;
  }
  console.log(' ', snapshotNote);

  // ── Build findings summary ────────────────────────────────────────────────
  const lines = [
    `Article: "${article.title}"`,
    `URL: ${pageUrl}`,
    '',
    '--- Above-the-Fold Value Prop (first 200 words) ---',
    aboveFoldText || '(no text found)',
    '',
    '--- Social Proof Signals ---',
    `Star rating mentions (★ or "X.X★" patterns): ${socialProof.starRatingMentions}`,
    `Review count mentions (e.g. "250 reviews"): ${socialProof.reviewMentions}`,
    `Blockquote/testimonial elements: ${socialProof.blockquoteCount}`,
    `Certification mentions: ${socialProof.certificationMentions.length > 0 ? socialProof.certificationMentions.join(', ') : 'none'}`,
    '',
    '--- Product/Collection Link Framing ---',
  ];

  if (linkData.productHandles.length === 0 && linkData.collectionHandles.length === 0) {
    lines.push('No internal product or collection links found.');
  } else {
    if (linkData.genericAnchors.length === 0) {
      lines.push('No generic anchor text issues found (all anchors appear descriptive).');
    } else {
      lines.push(`Generic anchor text issues (${linkData.genericAnchors.length}):`);
      linkData.genericAnchors.forEach(a => {
        lines.push(`  - "${a.anchorText}" linking to ${a.href}`);
      });
    }

    lines.push('', 'Review data for linked products:');
    if (productReviews.length === 0) {
      lines.push('  No products linked.');
    } else {
      productReviews.forEach(pr => {
        if (!pr.found) {
          lines.push(`  - ${pr.handle}: not found or error${pr.error ? ' (' + pr.error + ')' : ''}`);
        } else if (pr.hasReviewMetafield) {
          lines.push(`  - ${pr.title} (${pr.handle}): review widget found (namespace: ${pr.reviewNamespace})`);
        } else {
          lines.push(`  - ${pr.title} (${pr.handle}): review data unavailable — no judgeme/yotpo/okendo metafield`);
        }
      });
    }

    lines.push('Review data for linked collections:');
    if (collectionReviews.length === 0) {
      lines.push('  No collections linked.');
    } else {
      collectionReviews.forEach(cr => {
        if (!cr.found) {
          lines.push(`  - ${cr.handle}: not found or error${cr.error ? ' (' + cr.error + ')' : ''}`);
        } else if (cr.hasReviewMetafield) {
          lines.push(`  - ${cr.title} (${cr.handle}): review widget found (namespace: ${cr.reviewNamespace})`);
        } else {
          lines.push(`  - ${cr.title} (${cr.handle}): review data unavailable — no judgeme/yotpo/okendo metafield`);
        }
      });
    }
  }

  lines.push('', '--- CTA Copy Audit (rsc-cta-block elements) ---');
  if (ctaFindings.length === 0) {
    lines.push('No rsc-cta-block CTA elements found.');
  } else {
    ctaFindings.forEach((cta, i) => {
      const flag = cta.genericOnly ? ' ⚠ GENERIC — no product noun' : '';
      lines.push(`CTA ${i + 1}: "${cta.ctaText}"${flag}`);
    });
  }

  lines.push('', '--- Claim Specificity Analysis ---');
  lines.push(`Total sentences analyzed: ${specificity.totalSentences}`);
  lines.push(`Sentences with specific claims (%, ingredient, timeframe): ${specificity.specificCount}`);
  lines.push(`Sentences with only vague adjectives (effective/natural/clean/gentle/etc.): ${specificity.vagueOnlyCount}`);

  lines.push('', '--- First Paragraph Benefit Check ---');
  if (!firstPara.found) {
    lines.push('No opening paragraph found.');
  } else if (firstPara.hasSpecificBenefit) {
    lines.push(`First paragraph contains a specific, concrete benefit. Preview: "${firstPara.text}"`);
  } else {
    lines.push(`First paragraph lacks specific/concrete benefit (no number, named ingredient, or measurable claim). Preview: "${firstPara.text}"`);
  }

  lines.push('', '--- GSC Performance (top 5 queries, 90 days) ---');
  if (!gscData || gscData.length === 0) {
    lines.push('GSC data unavailable for this page.');
  } else {
    gscData.forEach((k, i) => {
      const ctrPct = (k.ctr * 100).toFixed(1);
      lines.push(`${i + 1}. "${k.keyword}" — ${k.impressions} impressions, #${k.position?.toFixed(1)} avg position, ${ctrPct}% CTR`);
    });
  }

  lines.push('', '--- Shopify Snapshot Context ---');
  lines.push(snapshotNote);

  const findingsSummary = lines.join('\n');
  console.log('\nFindings summary:\n' + findingsSummary);

  // ── Claude report generation ──────────────────────────────────────────────
  console.log('\n  Generating report with Claude...');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a senior CRO analyst specializing in trust signals and conversion optimization for skincare e-commerce.

You have been given structured findings from an automated analysis of a blog post. Your job is to write a concise deep-dive report focused on trust signals and conversion optimization.

ACTION ITEM BEING ANALYZED: "${item}"

AUTOMATED FINDINGS:
${findingsSummary}

Write the report in this exact format:

## Trust & Conversion Deep Dive — ${article.title}
**Page:** ${pageUrl}
**Action Item Analyzed:** ${item}
**Data sources:** Shopify HTML, Shopify product data, GSC

### What We Found
[3-6 bullet points. Be specific — cite exact numbers and text from the findings above. Cover: above-the-fold value prop quality, social proof gaps or strengths, link framing issues, CTA copy weaknesses, specificity ratio, first paragraph effectiveness. Only flag real issues.]

### Action Plan
1. [Specific, actionable recommendation with exact copy or example where applicable]
2. [...]
3. [...]
[3-5 items total. Each action must be specific: name what to change, where, and what the new copy or element should say/look like. For CTAs, provide example revised copy. For social proof, say exactly what to add and where. For vague adjectives, provide example rewrites using specific claims.]

Keep recommendations tight and grounded in the data. Do not invent issues not present in the findings.`,
    }],
  });

  if (!response.content?.[0]?.text) throw new Error('Claude returned empty content');
  const report = response.content[0].text;

  // ── Save report ───────────────────────────────────────────────────────────
  mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const reportPath = join(REPORTS_DIR, `${today}-trust-${handle}.md`);
  writeFileSync(reportPath, report);
  console.log('\n  Report saved:', reportPath);
  console.log('\n' + report);

  await notify({
    subject: `CRO Deep Dive Trust: ${handle}`,
    body: report,
    status: 'success',
  }).catch(() => {});

  console.log('\n  Done.');
}

main().catch(async err => {
  console.error('Error:', err.message);
  await notify({
    subject: `CRO Deep Dive Trust failed: ${handle}`,
    body: err.message,
    status: 'error',
  }).catch(() => {});
  process.exit(1);
});
