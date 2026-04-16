/**
 * Product Verifier
 *
 * Verifies whether a branded product exists before the editor's LLM-based
 * factual-concerns check can hallucinate non-existence. Given a brand
 * and product category, does a SERP lookup and checks whether the brand's
 * authoritative domain (from config/ai-citation-prompts.json) appears in
 * the top organic results.
 *
 * Produces a structured verdict: { exists, confidence, canonical_url,
 * evidence }. Editor consumes this to ground the factual review with
 * "VERIFIED PRODUCTS" context so the LLM can't claim they don't exist.
 *
 * Usage:
 *   node agents/product-verifier/index.js "Dr. Bronner's" toothpaste
 *   node agents/product-verifier/index.js --post best-dr-bronner-s-toothpaste-alternatives-2025
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPostMeta, getContentPath, ROOT } from '../../lib/posts.js';
import { getSerpResults } from '../../lib/dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const citationConfig = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));
const COMPETITORS = citationConfig.competitors || [];

// Path fragments that indicate a product/shop page (high confidence of existence)
const PRODUCT_PATH_HINTS = ['/products/', '/product/', '/shop/', '/collections/', '/store/', '/buy/'];

function findCompetitorByName(rawBrand) {
  const q = rawBrand.toLowerCase().trim();
  for (const c of COMPETITORS) {
    if (c.name.toLowerCase() === q) return c;
    for (const alias of c.aliases || []) {
      if (alias.toLowerCase() === q) return c;
    }
  }
  // Fuzzy: does any alias appear as substring?
  for (const c of COMPETITORS) {
    for (const alias of c.aliases || []) {
      if (q.includes(alias.toLowerCase())) return c;
    }
  }
  return null;
}

function hostMatches(url, domain) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return host === domain || host.endsWith('.' + domain);
  } catch { return false; }
}

/**
 * Verify whether {brand} makes a {category} product. Returns a verdict.
 */
export async function verifyProduct(brand, category) {
  const competitor = findCompetitorByName(brand);
  const query = `${brand} ${category}`.trim();

  let organic = [];
  try {
    const res = await getSerpResults(query, 10);
    organic = res.organic || [];
  } catch (e) {
    return { exists: null, confidence: 'unknown', error: `SERP lookup failed: ${e.message}`, query };
  }

  // If we know the brand's authoritative domain, check whether it appears.
  if (competitor?.domain) {
    const match = organic.slice(0, 5).find((r) => hostMatches(r.url, competitor.domain));
    if (match) {
      const isProductPath = PRODUCT_PATH_HINTS.some((p) => match.url.includes(p));
      return {
        exists: true,
        confidence: isProductPath ? 'high' : 'medium',
        canonical_url: match.url,
        evidence: `${competitor.domain} ranks #${match.position} for "${query}"${isProductPath ? ' with a product URL path' : ''}`,
        brand: competitor.name,
        query,
      };
    }
    // No authoritative domain in top 5 — still check for any product-looking result
    const productResult = organic.slice(0, 3).find((r) =>
      PRODUCT_PATH_HINTS.some((p) => r.url.includes(p))
    );
    if (productResult) {
      return {
        exists: true,
        confidence: 'low',
        canonical_url: productResult.url,
        evidence: `${competitor.domain} not in top 5 but ${productResult.domain} ranks #${productResult.position} with a product path`,
        brand: competitor.name,
        query,
      };
    }
    return {
      exists: false,
      confidence: 'medium',
      evidence: `Neither ${competitor.domain} nor any product-path result appeared in top 5 for "${query}"`,
      brand: competitor.name,
      query,
    };
  }

  // Unknown brand — fall back to pure SERP signal.
  const productResult = organic.slice(0, 3).find((r) =>
    PRODUCT_PATH_HINTS.some((p) => r.url.includes(p))
  );
  if (productResult) {
    return {
      exists: true,
      confidence: 'low',
      canonical_url: productResult.url,
      evidence: `Unknown brand; top result ${productResult.domain} ranks #${productResult.position} with a product path`,
      brand,
      query,
    };
  }

  return {
    exists: null,
    confidence: 'unknown',
    evidence: `Unknown brand and no product-path results in top 3 for "${query}"`,
    brand,
    query,
  };
}

/**
 * Extract competitor brand mentions from HTML. Returns brands that appear
 * in the visible text (not inside href/img attributes).
 */
export function extractBrandMentions(html) {
  const visible = (html || '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  const lower = visible.toLowerCase();
  const found = new Set();
  for (const c of COMPETITORS) {
    for (const alias of c.aliases || []) {
      if (lower.includes(alias.toLowerCase())) {
        found.add(c.name);
        break;
      }
    }
  }
  return Array.from(found);
}

async function verifyPost(slug) {
  const meta = getPostMeta(slug);
  if (!meta) throw new Error(`No metadata for ${slug}`);
  const contentPath = getContentPath(slug);
  if (!existsSync(contentPath)) throw new Error(`No content file for ${slug}`);
  const html = readFileSync(contentPath, 'utf8');

  const brands = extractBrandMentions(html);
  if (brands.length === 0) {
    console.log(`  No competitor brands mentioned in ${slug}`);
    return { slug, verifications: [] };
  }

  // Infer category from target_keyword (last-word heuristic for common cases;
  // falls back to the bare keyword)
  const keyword = (meta.target_keyword || meta.title || '').toLowerCase();
  let category = 'product';
  for (const c of ['toothpaste', 'deodorant', 'lotion', 'soap', 'lip balm', 'cream']) {
    if (keyword.includes(c)) { category = c; break; }
  }

  console.log(`  Verifying ${brands.length} brand(s) in ${slug} (category: ${category}):\n`);
  const verifications = [];
  for (const brand of brands) {
    const verdict = await verifyProduct(brand, category);
    verifications.push(verdict);
    const existsLabel = verdict.exists === true ? '✓ EXISTS' : verdict.exists === false ? '✗ NOT FOUND' : '? UNKNOWN';
    console.log(`  ${existsLabel} [${verdict.confidence}] ${brand} ${category}`);
    if (verdict.canonical_url) console.log(`     → ${verdict.canonical_url}`);
    if (verdict.evidence) console.log(`     (${verdict.evidence})`);
  }
  return { slug, category, verifications };
}

async function main() {
  const args = process.argv.slice(2);
  const postIdx = args.indexOf('--post');

  if (postIdx !== -1) {
    const slug = args[postIdx + 1];
    if (!slug) { console.error('Usage: --post <slug>'); process.exit(1); }
    console.log('\nProduct Verifier\n');
    const result = await verifyPost(slug);
    mkdirSync(join(ROOT, 'data', 'reports', 'product-verifier'), { recursive: true });
    const out = join(ROOT, 'data', 'reports', 'product-verifier', `${slug}.json`);
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(`\n  Report: ${out}`);
    return;
  }

  const [brand, ...rest] = args;
  const category = rest.join(' ').trim() || 'product';
  if (!brand) {
    console.error('Usage: node agents/product-verifier/index.js "<brand>" <category>');
    console.error('       node agents/product-verifier/index.js --post <slug>');
    process.exit(1);
  }
  console.log('\nProduct Verifier\n');
  const verdict = await verifyProduct(brand, category);
  console.log(JSON.stringify(verdict, null, 2));
}

// Only run main() when invoked directly, not when imported as a module.
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('agents/product-verifier/index.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
