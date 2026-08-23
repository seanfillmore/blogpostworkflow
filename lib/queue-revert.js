// lib/queue-revert.js
//
// Undo an applied optimization-queue item — for real, on Shopify.
//
// The dashboard's rollback route was dead code twice over. It called
// `require('node:fs')` inside an ESM module, so every request threw
// `ReferenceError: require is not defined` and answered 500. And even with
// that fixed it only rewrote the LOCAL file `data/posts/<slug>/content.html`,
// leaving the bad content live on the storefront. A revert that leaves the live
// page unchanged is worse than no revert at all: it reports success and the
// operator stops looking.
//
// Auto-apply is only defensible if revert genuinely works, so this module owns
// both halves — what a revert would need (recorded at apply time, while the
// previous values are still knowable) and performing it.
//
// Shopify functions are injected for the same reason as in lib/queue-apply.js.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { getContentPath } from './posts.js';
import { findPostMeta } from './queue-apply.js';

/**
 * Describe what reverting this item would take, computed BEFORE it is applied.
 *
 * A metafield revert is only possible if we know the previous value, and after
 * the write we no longer do — so `previous` is captured by the caller ahead of
 * time and stamped onto the item. `null` means "this item cannot be reverted
 * automatically", which is a fact worth recording rather than hiding.
 *
 * @param {object} item
 * @param {{previous?: object}} [opts] previously-live values, read before writing
 * @returns {object|null}
 */
export function revertPlanFor(item, { previous } = {}) {
  if (!item) return null;
  const trigger = item.trigger;

  if (trigger === 'page-meta-rewrite') {
    return {
      kind: 'metafield',
      resource: 'pages',
      resource_id: item.resource_id ?? null,
      previous: previous || {
        title_tag: item.proposed_meta?.original_title ?? null,
        description_tag: item.proposed_meta?.original_description ?? null,
      },
    };
  }
  if (trigger === 'product-meta-rewrite') {
    return {
      kind: 'metafield',
      resource: 'products',
      resource_id: item.resource_id ?? null,
      previous: previous || {
        title_tag: item.proposed_meta?.original_title ?? null,
        description_tag: item.proposed_meta?.original_description ?? null,
      },
    };
  }
  if (trigger === 'collection-gap' || trigger === 'collection-content'
      || trigger === 'product-description-rewrite' || trigger === 'product-title-rewrite') {
    // Deliberately unhandled: reverting these means deleting a collection or
    // restoring a product body/handle we never captured. Say so rather than
    // stamp a plan that would fail when someone reaches for it.
    return null;
  }

  // Everything else edits a blog post body, including a seo-opportunity whose
  // executor (refresh-runner) auto-publishes.
  if (!item.backup_html_path) return null;
  return {
    kind: 'blog-html',
    slug: item.slug,
    backup_html_path: item.backup_html_path,
    note: trigger === 'seo-opportunity'
      ? 'restores the article body captured before the executor ran; any collection links the executor added are not undone'
      : 'restores the article body captured before the refresh was applied',
  };
}

/**
 * Perform the revert. Restores Shopify FIRST, then the local file — a failed
 * Shopify write must not leave local and live disagreeing in the direction that
 * makes the site look fixed when it is not.
 *
 * @param {object} item queue item carrying `revert_plan` (or enough to derive one)
 * @param {object} deps { getBlogs, updateArticle, upsertMetafield }
 * @returns {Promise<{reverted:true, kind:string, detail:string}>}
 */
export async function revertQueueItem(item, deps) {
  const plan = item?.revert_plan || revertPlanFor(item);
  if (!plan) throw new Error('This item records no way to revert it automatically — revert by hand.');

  if (plan.kind === 'metafield') {
    if (!plan.resource_id) throw new Error('No resource_id recorded — cannot revert the metafields.');
    const prev = plan.previous || {};
    if (prev.title_tag == null && prev.description_tag == null) {
      throw new Error('No previous title/description was captured — cannot revert the metafields.');
    }
    // A previously-EMPTY metafield is restored as an empty string, not skipped:
    // skipping would leave the agent's value live and report success.
    if (prev.title_tag != null) await deps.upsertMetafield(plan.resource, plan.resource_id, 'global', 'title_tag', String(prev.title_tag));
    if (prev.description_tag != null) await deps.upsertMetafield(plan.resource, plan.resource_id, 'global', 'description_tag', String(prev.description_tag));
    return { reverted: true, kind: plan.kind, detail: `restored ${plan.resource}/${plan.resource_id} SEO metafields` };
  }

  if (plan.kind === 'blog-html') {
    if (!plan.backup_html_path || !existsSync(plan.backup_html_path)) {
      throw new Error(`Backup HTML missing at ${plan.backup_html_path || '(unset)'} — nothing to restore.`);
    }
    const backup = readFileSync(plan.backup_html_path, 'utf8');
    const found = findPostMeta(plan.slug);
    if (!found?.meta?.shopify_article_id) {
      throw new Error(`No Shopify article id for "${plan.slug}" — refusing to revert only the local file, which would leave the bad content live.`);
    }
    const blogs = await deps.getBlogs();
    await deps.updateArticle(blogs[0].id, found.meta.shopify_article_id, { body_html: backup });
    writeFileSync(getContentPath(found.meta.slug || plan.slug), backup);
    return { reverted: true, kind: plan.kind, detail: `restored Shopify article ${found.meta.shopify_article_id} and data/posts/${plan.slug}/content.html` };
  }

  throw new Error(`Unknown revert plan kind "${plan.kind}".`);
}
