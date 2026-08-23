// One-shot: locate the Shopify article id for a live hair-post handle that
// has no local data/posts/ directory, ahead of unpublishing three hair posts
// (RSC sells no hair products). See unpublish-report.md for context.
import { getBlogs, getArticles } from '../lib/shopify.js';

const targetHandles = new Set([
  'best-hair-mask-for-dry-hair-diy-natural-options',
  'is-coconut-oil-good-for-your-hair-benefits-how-to-use-it',
  'best-diy-natural-hair-masks-for-dry-hair-that-work-1',
]);

const blogs = await getBlogs();
console.log('Blogs:', blogs.map((b) => `${b.id}:${b.handle}`).join(', '));

for (const blog of blogs) {
  let sinceId = 0;
  for (;;) {
    const articles = await getArticles(blog.id, {
      limit: 250,
      since_id: sinceId,
      fields: 'id,handle,title,published_at,status,created_at',
    });
    if (!articles.length) break;
    for (const a of articles) {
      if (targetHandles.has(a.handle)) {
        console.log(JSON.stringify({ blog: blog.id, blogHandle: blog.handle, ...a }, null, 2));
      }
    }
    sinceId = articles[articles.length - 1].id;
    if (articles.length < 250) break;
  }
}
