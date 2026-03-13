/**
 * Create / update the author page on Shopify.
 *
 * Builds a bio page for the blog author with:
 *   - Human-written or Claude-generated HTML bio
 *   - Person JSON-LD schema (E-E-A-T signal for Google)
 *
 * The page is created at /pages/<author.slug> (e.g. /pages/sean-fillmore).
 * If a page with that handle already exists it is updated in place.
 *
 * Bio content priority:
 *   1. config.author.bio  (set this in config/site.json for full control)
 *   2. Claude-generated   (uses brand description + author name)
 *
 * Usage:
 *   node scripts/create-author-page.js            # create/update live
 *   node scripts/create-author-page.js --dry-run  # print HTML, no Shopify call
 *
 * After running, add the author page to your Shopify nav and link to it
 * from the blog template (author byline).
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getPages, createPage, updatePage } from '../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

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
const dryRun = process.argv.includes('--dry-run');

// ── schema builder ────────────────────────────────────────────────────────────

function buildPersonSchema(author) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    'name': author.name,
    'url': `${config.url}/pages/${author.slug}`,
    'jobTitle': author.title,
    'worksFor': {
      '@type': 'Organization',
      'name': config.name,
      'url': config.url,
    },
  };
  if (author.sameAs && author.sameAs.length > 0) {
    schema.sameAs = author.sameAs;
  }
  return schema;
}

// ── bio generator ─────────────────────────────────────────────────────────────

async function generateBio(author) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY in .env');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Write a short, credible author bio page for ${author.name}, ${author.title} of ${config.name}, a ${config.brand_description}.

The bio should:
- Be written in third person
- Be 3–4 short paragraphs
- Establish expertise and first-hand experience with natural personal care
- Mention the types of products the brand makes (${config.brand_description})
- Sound warm and human, not corporate
- Be optimised for E-E-A-T (show real experience, not just credentials)
- NOT include placeholder text like [insert credentials] — write genuine, plausible content

Output ONLY the HTML body content (use <h1>, <p> tags). No <html>/<body>/<head> wrappers.
Start with: <h1>${author.name}</h1>`,
    }],
  });

  return msg.content[0].text.trim();
}

// ── page builder ──────────────────────────────────────────────────────────────

function buildPageHtml(bioHtml, author) {
  const schema = buildPersonSchema(author);
  const schemaBlock = `<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`;
  return `${schemaBlock}\n${bioHtml}`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const author = config.author;
  if (typeof author !== 'object') {
    console.error('config.author must be an object. Update config/site.json.');
    process.exit(1);
  }

  console.log(`\nAuthor Page — ${author.name} (${config.name})`);
  console.log(`Target: ${config.url}/pages/${author.slug}\n`);

  // Generate or use existing bio
  let bioHtml;
  if (author.bio && author.bio.trim()) {
    console.log('  Using bio from config/site.json');
    bioHtml = author.bio;
  } else {
    process.stdout.write('  Generating bio with Claude... ');
    bioHtml = await generateBio(author);
    console.log('done');
    console.log('\n  ── Generated bio preview ──────────────────────────────────');
    console.log(bioHtml.slice(0, 500) + (bioHtml.length > 500 ? '...' : ''));
    console.log('  ────────────────────────────────────────────────────────────\n');
    console.log('  Tip: copy the bio into config.author.bio in site.json to lock it in.\n');
  }

  const pageHtml = buildPageHtml(bioHtml, author);

  if (dryRun) {
    console.log('  DRY RUN — full page HTML:');
    console.log('─'.repeat(60));
    console.log(pageHtml);
    console.log('─'.repeat(60));
    return;
  }

  // Find existing page with this handle
  process.stdout.write('  Checking for existing Shopify page... ');
  const pages = await getPages();
  const existing = pages.find((p) => p.handle === author.slug);

  const pageFields = {
    title: `About ${author.name}`,
    handle: author.slug,
    body_html: pageHtml,
    published: true,
  };

  if (existing) {
    console.log(`found (id: ${existing.id})`);
    process.stdout.write('  Updating page... ');
    await updatePage(existing.id, pageFields);
    console.log('done');
    console.log(`\n  Updated: ${config.url}/pages/${author.slug}`);
  } else {
    console.log('not found');
    process.stdout.write('  Creating page... ');
    await createPage(pageFields);
    console.log('done');
    console.log(`\n  Created: ${config.url}/pages/${author.slug}`);
  }

  console.log('\n  Next steps:');
  console.log('  1. Review the page at the URL above');
  console.log('  2. Add a profile photo via Shopify admin → Pages → ' + `About ${author.name}`);
  console.log('  3. Add LinkedIn/social URLs to config.author.sameAs in site.json, then re-run');
  console.log('  4. Link to this page from your blog post author byline in the Shopify theme');
  console.log('  5. Run `npm run schema -- --all --apply` to update Article schema on all posts');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
