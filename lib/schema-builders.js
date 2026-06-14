// lib/schema-builders.js
// Pure JSON-LD builders shared by schema-injector (articles) and the collection
// agents (Project C). No I/O.

export function buildArticleSchema(meta, url, config) {
  const author = config.author;
  const authorName = typeof author === 'object' ? author.name : author;
  const authorUrl = typeof author === 'object' ? `${config.url}/pages/${author.slug}` : config.url;
  const published = meta.published_at || meta.shopify_publish_at || meta.uploaded_at || null;
  const modified = meta.last_refreshed_at || meta.updated_at || meta.uploaded_at || published || null;
  const image = meta.shopify_image_url || meta.image_url || null;
  const kws = [meta.target_keyword, ...(meta.semantic_keywords || [])].filter(Boolean);

  const s = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: (meta.title || meta.recommended_title || '').slice(0, 110),
    description: (meta.meta_description || meta.summary || '').slice(0, 300),
    author: { '@type': 'Person', name: authorName, url: authorUrl },
    publisher: { '@type': 'Organization', name: config.name, url: config.url },
    url,
    mainEntityOfPage: url,
  };
  if (published) s.datePublished = published;
  if (modified) s.dateModified = modified;
  if (image) s.image = [image];
  if (kws.length) s.keywords = kws.join(', ');
  return s;
}

export function buildBreadcrumb(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items || []).map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}
