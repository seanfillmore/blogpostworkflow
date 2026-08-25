// agents/dashboard/routes/performance-queue.js
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { listQueueItems, writeItem } from '../../performance-engine/lib/queue.js';
import { getBlogs, getArticle, updateArticle, getProducts, updateProduct, createCustomCollection, upsertMetafield } from '../../../lib/shopify.js';
import { buildTriggerCommand, agentForOpportunityItem } from '../lib/opportunity-trigger.js';
import { ensureLocalPostForUrl } from '../../../lib/ensure-local-post.js';
// The publish path itself lives in lib/queue-apply.js, shared with the
// unattended agents/queue-autoapply. It used to be an if/else ladder of
// private functions in this file; a second copy for the scheduled path would
// have let the collection-gap gates (2+ products, draft, spec validation) exist
// on one path and not the other.
import { applyItem, isArticleGoneError as _isArticleGoneError } from '../../../lib/queue-apply.js';
import { revertQueueItem, revertPlanFor } from '../../../lib/queue-revert.js';
// The SHARED helper, not a local copy — this module used to carry its own byte-identical
// clone, and with it the `JSON.parse('null')` process-kill fixed in lib/responses.js on
// 2026-08-17. Its one call site (the /feedback route) already destructures inside a
// try/catch, so the rejection lands as a 400 exactly as before.
import { readJsonBody } from '../lib/responses.js';

// Re-exported: tests/dashboard/blog-refresh-dead-target.test.js imports it from here.
export const isArticleGoneError = _isArticleGoneError;

// Shopify calls the shared publish/revert helpers need, injected so those
// modules stay importable without OAuth credentials.
const SHOPIFY = { getBlogs, getArticle, updateArticle, getProducts, updateProduct, createCustomCollection, upsertMetafield };

function findItem(slug) {
  return listQueueItems().find((i) => i.slug === slug) || null;
}

function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res) { respondJson(res, { ok: false, error: 'Not found' }, 404); }

// A seo-opportunity item is a recommendation, not finished content. Approving it
// kicks off the executor agent that does the work (which then surfaces concrete,
// reviewable changes / queue items). Spawns detached so the request returns fast,
// then RECONCILES the item to a terminal status when the executor exits.
//
// Without that reconciliation, `in_progress` is a write-only dead-end: nothing
// else in the codebase ever advances it, so an approved opportunity shows
// IN_PROGRESS forever — even when the executor silently failed (e.g. a slug that
// doesn't match a post dir). The exit handler runs after this synchronous block
// (Node defers 'exit'/'error' callbacks), so it always sees the in_progress write.
async function triggerOpportunity(item, ctx, res) {
  // A refresh opportunity targets a LIVE post that may have no local tracking
  // (older posts, posts created outside the pipeline). Bootstrap it from Shopify
  // so refresh-runner can operate — otherwise buildTriggerCommand throws
  // "No local post found … cannot refresh" and the action dead-ends.
  if (agentForOpportunityItem(item) === 'refresh-runner') {
    const url = item.signal_source?.page || item.target_url || '';
    let slug = null;
    try { slug = await ensureLocalPostForUrl(url); }
    catch (e) { /* non-fatal — handled below / buildTriggerCommand surfaces a clear error */ }
    // If we can't resolve a live post, the target may have been redirected or
    // removed (GSC lags weeks behind). Don't dead-end with a scary error —
    // confirm the URL is dead and retire the opportunity gracefully.
    if (!slug) {
      let status = null;
      try { status = (await fetch(url, { method: 'HEAD', redirect: 'manual' })).status; }
      catch { status = 0; }
      if (status === 0 || status >= 300) {
        item.status = 'dismissed';
        item.dismissed_reason = `Target no longer live (HTTP ${status}) — redirected or removed; opportunity retired.`;
        item.dismissed_at = new Date().toISOString();
        writeItem(item);
        return respondJson(res, { ok: true, dismissed: true, message: `Opportunity retired: ${url} is no longer live (HTTP ${status}).` });
      }
    }
  }

  let cmd;
  try {
    cmd = buildTriggerCommand(item);
  } catch (err) {
    return respondJson(res, { ok: false, error: `Cannot run opportunity: ${err.message}` }, 422);
  }
  let child;
  try {
    child = spawn('node', [join(ctx.ROOT, cmd.script), ...cmd.args], {
      cwd: ctx.ROOT,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'], // capture stderr so a failure is diagnosable
    });
  } catch (err) {
    return respondJson(res, { ok: false, error: `Failed to start ${cmd.agent}: ${err.message}` }, 500);
  }

  let stderr = '';
  if (child.stderr) child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-2000); });

  const reconcile = (ok, detail) => {
    const fresh = findItem(item.slug) || item;
    // Don't clobber a human action that landed mid-run (dismiss/feedback).
    if (fresh.status !== 'in_progress') return;
    if (ok) {
      fresh.status = 'completed';
      fresh.completed_at = new Date().toISOString();
      delete fresh.error;
    } else {
      fresh.status = 'failed';
      fresh.failed_at = new Date().toISOString();
      fresh.error = String(detail || '').trim().split('\n').slice(-3).join(' ').slice(0, 500) || 'executor failed';
    }
    writeItem(fresh);
  };
  child.on('exit', (code) => reconcile(code === 0, `exit ${code}: ${stderr}`));
  child.on('error', (err) => reconcile(false, err.message));
  child.unref();

  item.status = 'in_progress';
  item.triggered_agent = cmd.agent;
  item.triggered_at = new Date().toISOString();
  writeItem(item);
  return respondJson(res, { ok: true, triggered: cmd.agent });
}

// collection-content items carry generated body_html + meta and are published
// by the collection-content-optimizer's own --publish-approved path (which
// prepends CollectionPage + BreadcrumbList JSON-LD — no FAQPage since
// 2026-08-24, when Google's removal of the FAQ rich result retired it —
// updates the collection, and opens a meta A/B test).
// Reuse it rather than duplicate that logic: mark approved, then spawn it.
function publishCollectionContent(item, ctx, res) {
  item.status = 'approved';
  item.approved_at = new Date().toISOString();
  writeItem(item);
  try {
    spawn('node', [join(ctx.ROOT, 'agents/collection-content-optimizer/index.js'), '--publish-approved'], {
      cwd: ctx.ROOT,
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (err) {
    return respondJson(res, { ok: false, error: `Failed to start publish: ${err.message}` }, 500);
  }
  return respondJson(res, { ok: true, publishing: true });
}

export default [
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/approve$/.test(url),
    async handler(req, res, ctx) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);

      // These item types aren't "publish pre-made content to Shopify" — they
      // delegate to the responsible agent, which responds for itself and returns.
      if (item.trigger === 'seo-opportunity') return await triggerOpportunity(item, ctx, res);
      if (item.trigger === 'collection-content') return publishCollectionContent(item, ctx, res);

      // Record how this would be undone BEFORE it is applied — after the write
      // the previous values are gone. See lib/queue-revert.js.
      const revertPlan = revertPlanFor(item);

      try {
        const result = await applyItem(item, SHOPIFY);
        if (result?.dismissed) {
          item.status = 'dismissed';
          item.dismissed_reason = result.reason;
          item.dismissed_at = new Date().toISOString();
          writeItem(item);
          return respondJson(res, { ok: true, dismissed: true, message: result.reason });
        }
      } catch (err) {
        // 422 (not 502) — these are user-state errors (post not on Shopify yet,
        // refreshed HTML missing, etc.). Cloudflare/proxies in front of the
        // tunnel intercept 5xx responses and serve their own HTML error page,
        // which the dashboard then fails to JSON.parse. 4xx passes through.
        return respondJson(res, { ok: false, error: `Publish failed: ${err.message}` }, 422);
      }

      item.status = 'published';
      item.approved_at = new Date().toISOString();
      item.published_at = new Date().toISOString();
      if (revertPlan) item.revert_plan = revertPlan;
      writeItem(item);

      respondJson(res, { ok: true, published: true, revertible: !!revertPlan });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/feedback$/.test(url),
    async handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);
      try {
        const { feedback } = await readJsonBody(req);
        if (typeof feedback !== 'string' || !feedback.trim()) {
          return respondJson(res, { ok: false, error: 'feedback must be a non-empty string' }, 400);
        }
        item.feedback = feedback.trim();
        item.status = 'pending';
        item.approved_at = null;
        writeItem(item);
        respondJson(res, { ok: true });
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 400);
      }
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/dismiss$/.test(url),
    handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);
      item.status = 'dismissed';
      writeItem(item);
      respondJson(res, { ok: true });
    },
  },
  {
    method: 'POST',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/rollback$/.test(url),
    // Two live defects fixed here, both of which made this route a lie:
    //   1. It called `require('node:fs')` inside an ESM module, so EVERY
    //      request threw `ReferenceError: require is not defined` and answered
    //      500. `writeFileSync` was already imported at the top of the file.
    //   2. Even with that fixed it only rewrote the local
    //      data/posts/<slug>/content.html and never touched Shopify — the live
    //      article kept serving the content being rolled back, while the UI
    //      reported success. Reverting for real is what makes auto-apply
    //      acceptable, so it is now the shared lib/queue-revert.js path.
    // `return`ed so the router's dispatch() guard can attach to the rejection.
    handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item) return notFound(res);
      return revertQueueItem(item, SHOPIFY).then(
        (result) => {
          item.status = 'dismissed';
          item.rolled_back_at = new Date().toISOString();
          item.rolled_back_detail = result.detail;
          writeItem(item);
          respondJson(res, { ok: true, ...result });
        },
        // 422 for the same reason as the approve route: a 5xx through the
        // tunnel is replaced by an HTML error page the dashboard can't parse.
        (err) => respondJson(res, { ok: false, error: `Rollback failed: ${err.message}` }, 422),
      );
    },
  },
  {
    method: 'GET',
    match: (url) => /^\/api\/performance-queue\/[^/]+\/html$/.test(url),
    handler(req, res) {
      const slug = req.url.split('/')[3];
      const item = findItem(slug);
      if (!item || !existsSync(item.refreshed_html_path)) return notFound(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(item.refreshed_html_path));
    },
  },
];
