/**
 * Upload a blog post (HTML + image) to Shopify
 *
 * Usage:
 *   node scripts/upload-post.js data/posts/<slug>.json              # publish now
 *   node scripts/upload-post.js data/posts/<slug>.json --draft      # save as draft
 *   node scripts/upload-post.js data/posts/<slug>.json --schedule 2026-03-15
 *   node scripts/upload-post.js data/posts/<slug>.json --schedule "2026-03-15 09:00"
 *
 * Reads:  data/posts/<slug>.json  — metadata (title, tags, meta_description, image_path)
 *         data/posts/<slug>.html  — post body HTML
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, createArticle, STORE } from '../lib/shopify.js';
import { getContentPath, ROOT } from '../lib/posts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
if (!args[0]) {
  console.error('Usage: node scripts/upload-post.js data/posts/<slug>.json [--draft | --schedule YYYY-MM-DD]');
  process.exit(1);
}

// Parse flags
const isDraft = args.includes('--draft');
const scheduleIdx = args.indexOf('--schedule');
const scheduleArg = scheduleIdx !== -1 ? args[scheduleIdx + 1] : null;

// Validate and parse schedule date
let scheduledAt = null;
if (scheduleArg) {
  // Accept "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" — default time to 09:00 if omitted
  const raw = scheduleArg.includes(' ') ? scheduleArg : `${scheduleArg} 09:00`;
  scheduledAt = new Date(raw);
  if (isNaN(scheduledAt.getTime())) {
    console.error(`Invalid --schedule date: "${scheduleArg}". Use YYYY-MM-DD or "YYYY-MM-DD HH:MM"`);
    process.exit(1);
  }
  if (scheduledAt <= new Date()) {
    console.error(`--schedule date must be in the future (got: ${scheduledAt.toISOString()})`);
    process.exit(1);
  }
}

const jsonPath = join(ROOT, args[0]);
const meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
const slug = meta.slug || basename(jsonPath, '.json');
const htmlPath = getContentPath(slug);
const bodyHtml = readFileSync(htmlPath, 'utf8');

// Determine status label
const statusLabel = isDraft
  ? 'draft'
  : scheduledAt
    ? `scheduled for ${scheduledAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'published now';

console.log('\nShopify Upload — Real Skin Care\n');
console.log(`  Post:   "${meta.title}"`);
console.log(`  Status: ${statusLabel}`);

// Find the "news" blog
process.stdout.write('  Finding blog... ');
const blogs = await getBlogs();
const blog = blogs.find(b => b.handle === 'news') ?? blogs[0];
if (!blog) throw new Error('No blogs found on this store');
console.log(`${blog.title} (id: ${blog.id})`);

// Build article fields
/** @type {Record<string, any>} */
const fields = {
  title: meta.title,
  body_html: bodyHtml,
  tags: (meta.tags ?? []).join(', '),
  published: !isDraft,
};

// Scheduled post: set published_at to the future date
// Shopify publishes the article automatically at that time
if (scheduledAt) {
  fields.published_at = scheduledAt.toISOString();
}

// Attach meta description as excerpt
if (meta.meta_description) {
  fields.summary_html = `<p>${meta.meta_description}</p>`;
}

// Attach image if available
if (meta.image_path) {
  const imgPath = meta.image_path.match(/^(\/|[A-Z]:)/) ? meta.image_path : join(ROOT, meta.image_path);
  process.stdout.write('  Encoding image... ');
  const imgBuffer = readFileSync(imgPath);
  fields.image = {
    attachment: imgBuffer.toString('base64'),
    filename: basename(imgPath),
    alt: meta.title,
  };
  console.log('done');
}

// Upload
process.stdout.write('  Creating article... ');
const article = await createArticle(blog.id, fields);
console.log(`done (id: ${article.id})`);

const url = `https://${STORE}/blogs/${blog.handle}/${article.handle}`;

if (scheduledAt) {
  console.log(`\n  Scheduled: ${url}`);
  console.log(`  Publishes: ${scheduledAt.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}\n`);
} else if (isDraft) {
  console.log(`\n  Draft saved: ${url}\n`);
} else {
  console.log(`\n  Published: ${url}\n`);
}

// Save metadata back to JSON
meta.shopify_blog_id = blog.id;
meta.shopify_article_id = article.id;
meta.shopify_url = url;
meta.shopify_status = isDraft ? 'draft' : scheduledAt ? 'scheduled' : 'published';
if (scheduledAt) meta.shopify_scheduled_at = scheduledAt.toISOString();
meta.uploaded_at = new Date().toISOString();
writeFileSync(jsonPath, JSON.stringify(meta, null, 2));
console.log(`  Metadata saved to ${args[0]}\n`);
