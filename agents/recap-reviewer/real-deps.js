/**
 * The production wiring for runReview(). Everything with a side effect lives
 * here so agents/recap-reviewer/index.js stays testable with fakes.
 *
 * lib/shopify.js and lib/post-kill.js throw at import time without OAuth
 * credentials, so they are imported lazily, only when a step needs them.
 */
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, readdirSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { LLM_MODELS } from '../../config/llm-models.js';
import { notify } from '../../lib/notify.js';
import { loadState, saveState, REVIEWER_DIR } from '../../lib/recap-reviewer-state.js';
import { readLockState } from '../../lib/post-lock.js';
import { ctrProtectedHandles } from '../../lib/ctr-protected.js';
import { getPostMeta, writePostMeta, POSTS_DIR } from '../../lib/posts.js';
import { isLiveOrScheduled } from '../../lib/post-publish-state.js';
import { createFixCheckout, runFixSession } from '../../lib/fix-session.js';
import { shipFix, deployServer } from '../../lib/fix-ship.js';
import { gatherGrowthInputs, generateGrowthRecs } from '../../lib/growth-recs.js';
import { MAX_GATE_ATTEMPTS } from '../../lib/queue-autoapply.js';
import { readCalendar, backupCalendar, archiveItems, writeCalendarItems } from '../../lib/calendar-item-archive.js';
import { daysBetween } from '../../lib/digest-window.js';
import { REARM_GATE_ATTEMPTS } from './decisions.js';
import { makeExec } from './exec.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = 'https://www.realskincare.com';
const UA = 'Mozilla/5.0 (compatible; RSC-recap-reviewer/1.0)';
const SCHEDULER_LOG = join(ROOT, 'data', 'reports', 'scheduler', 'scheduler.log');
const DIGEST_DIR = join(ROOT, 'data', 'reports', 'daily-summary');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');
const BACKUP_DIR = join(ROOT, 'data', 'backups', 'removed-posts');
// removeDir may only ever touch the fix-session scratch areas.
const REMOVABLE = ['/srv/recap-fix/', '/root/recap-ship/'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function readTail(path, maxBytes = 256 * 1024) {
  try {
    const buf = readFileSync(path);
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  } catch { return ''; }
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

async function fetchStatus(path, { method = 'HEAD' } = {}) {
  for (let i = 0; i < 3; i += 1) {
    try {
      const r = await fetch(`${ORIGIN}${path}`, { method, redirect: 'manual', headers: { 'user-agent': UA } });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      return { status: r.status, location: r.headers.get('location') || '' };
    } catch { await sleep(3000 * (i + 1)); }
  }
  return { status: null, location: '' };
}

/**
 * Why a blocked draft must NOT be archived, or null. A post with a Shopify
 * article id has (or had) a live page: moving its directory out of
 * data/posts/ would orphan that page from every agent that maintains it.
 */
export function archiveRefusal(meta) {
  if (meta?.shopify_article_id) return 'post has a Shopify article; refusing to archive it';
  if (meta && isLiveOrScheduled(meta)) return 'post is live or scheduled; refusing to archive it';
  return null;
}

const FIX_BASE = '/srv/recap-fix';

export async function realDeps() {
  const exec = makeExec({ root: ROOT });
  const env = loadEnv();
  let client;
  const shopify = () => import('../../lib/shopify.js');

  return {
    reportPath: (apply) => join(REVIEWER_DIR, apply ? 'latest.json' : 'dry-run.json'),
    exec,
    loadState: () => loadState(),
    saveState: (s) => saveState(s),
    notify,

    async collectInputs() {
      const { collectDigestInputs } = await import('../daily-summary/index.js');
      return collectDigestInputs();
    },
    async readCrontab() {
      const r = await exec('crontab', ['-l'], { timeout: 15_000 });
      return r.code === 0 ? r.stdout : '';
    },

    // ── heartbeat
    async heartbeat() {
      const r = await exec('node', ['scripts/check-scheduler-heartbeat.mjs', '--json'], { timeout: 60_000 });
      if (r.code !== 0) throw new Error(`heartbeat check exited ${r.code}: ${r.stderr.slice(-300)}`);
      return JSON.parse(r.stdout);
    },
    async lastSchedulerLogAt() {
      let last = null;
      for (const line of readTail(SCHEDULER_LOG).split('\n')) {
        const m = /^\[([^\]]+)\]/.exec(line);
        const t = m ? Date.parse(m[1]) : NaN;
        if (Number.isFinite(t)) last = t;
      }
      return last;
    },
    kill: async (pid, sig) => process.kill(pid, sig),

    // ── re-run verification
    async readRowsSince(iso) {
      const rows = [];
      for (const day of daysBetween(iso.slice(0, 10), new Date().toISOString().slice(0, 10))) {
        const f = join(DIGEST_DIR, `${day}.jsonl`);
        if (!existsSync(f)) continue;
        for (const l of readFileSync(f, 'utf8').split('\n')) {
          if (!l.trim()) continue;
          try { const r = JSON.parse(l); if (String(r.ts || '') > iso) rows.push(r); } catch { /* skip */ }
        }
      }
      return rows;
    },
    async healthTitles() {
      const { checkSystemHealth } = await import('../daily-summary/index.js');
      return checkSystemHealth().map((i) => i.title);
    },
    async isBlocked(slug) {
      const { findBlockedPosts } = await import('../daily-summary/index.js');
      return findBlockedPosts().some((b) => b.slug === slug);
    },

    // ── needs_decision close-outs (producer files)
    async rearmQueueItem(slug) {
      const p = join(QUEUE_DIR, `${slug}.json`);
      const item = JSON.parse(readFileSync(p, 'utf8'));
      if (item.status !== 'pending') throw new Error(`queue item is "${item.status}", not pending`);
      item.autoapply = { ...(item.autoapply || {}), gate_attempts: Math.min(REARM_GATE_ATTEMPTS, MAX_GATE_ATTEMPTS - 1), recap_retry_at: new Date().toISOString(), recap_retry_by: 'recap-reviewer' };
      item.updated_at = new Date().toISOString();
      writeAtomic(p, item);
      return item.autoapply;
    },
    async dismissQueueItem(slug, reason) {
      const p = join(QUEUE_DIR, `${slug}.json`);
      const item = JSON.parse(readFileSync(p, 'utf8'));
      if (item.status !== 'pending') throw new Error(`queue item is "${item.status}", not pending`);
      const at = new Date().toISOString();
      Object.assign(item, {
        status: 'dismissed', dismissed_reason: reason, dismissed_by: 'recap-reviewer', dismissed_at: at,
        closed_by: 'recap-reviewer', updated_at: at,
      });
      writeAtomic(p, item);
      return { status: 'dismissed' };
    },
    stampPostState: async (slug, fields) => writePostMeta(slug, fields),

    // ── blocked drafts: move, never delete
    async archiveDraft(slug, reason) {
      const refusal = archiveRefusal(getPostMeta(slug));
      if (refusal) throw new Error(refusal);
      const src = join(POSTS_DIR, slug);
      if (!existsSync(src)) throw new Error(`no post directory at data/posts/${slug}`);
      const arcRoot = join(POSTS_DIR, '_orphaned');
      mkdirSync(arcRoot, { recursive: true });
      let name = slug;
      for (let n = 2; existsSync(join(arcRoot, name)) || existsSync(join(arcRoot, `${name}.orphan.json`)); n += 1) name = `${slug}--${n}`;

      // Calendar first (archive record, then the write), per lib/calendar-item-archive.js.
      let calendar = 'not on the calendar';
      try {
        const cal = readCalendar(ROOT);
        const index = cal.items.findIndex((i) => i?.slug === slug);
        if (index !== -1) {
          backupCalendar({ root: ROOT, label: 'recap-reviewer' });
          const item = cal.items[index];
          const { archived, failed } = archiveItems({
            root: ROOT, droppedBy: 'agents/recap-reviewer/index.js',
            drops: [{ slug, keyword: item.keyword, reason, item, index, source: 'agents/recap-reviewer' }],
          });
          if (archived.length) {
            writeCalendarItems({ root: ROOT, calendar: cal, items: cal.items.filter((_, i) => i !== index) });
            calendar = `moved to data/calendar/_dropped/${archived[0].archivedFile}`;
          } else calendar = `calendar archive failed: ${failed[0]?.error}`;
        }
      } catch (e) { calendar = `calendar unchanged: ${e.message}`; }

      renameSync(src, join(arcRoot, name));
      writeFileSync(join(arcRoot, `${name}.orphan.json`), `${JSON.stringify({
        slug,
        archived_at: new Date().toISOString(),
        archived_by: 'agents/recap-reviewer/index.js',
        action: 'archive',
        reason,
        resolved_target: null,
        refresh_mtime: null,
        rehomed_to: null,
        cause: 'hard-blocked draft still blocked after one content-remediator pass',
        restore: `mv data/posts/_orphaned/${name} data/posts/${slug}`,
      }, null, 2)}\n`);
      return { moved_to: `data/posts/_orphaned/${name}`, calendar };
    },

    // ── removal
    async getAllOrders() {
      const { getAllOrders } = await shopify();
      const { orders, truncated } = await getAllOrders('2015-01-01T00:00:00Z', new Date().toISOString(), { maxPages: 400 });
      if (truncated) throw new Error('order history truncated');
      return orders;
    },
    async getAllRedirects() { return (await shopify()).getAllRedirects(); },
    ctrHandles: () => ctrProtectedHandles(ROOT),
    cannibalizationReport: () => readJson(join(ROOT, 'data', 'reports', 'cannibalization', 'latest.json')),
    lockStateFor: (handle) => readLockState(handle).state,
    async loadInventory() {
      const s = await shopify();
      const now = Date.now();
      const live = (p) => p && Date.parse(p) <= now;
      const inv = { articles: [], products: [], collections: [] };
      for (const b of await s.getBlogs()) {
        for (const a of await s.getArticles(b.id, { limit: 250 })) {
          if (live(a.published_at)) inv.articles.push({ path: `/blogs/${b.handle}/${a.handle}`, title: a.title });
        }
      }
      for (const p of await s.getProducts({ limit: 250 })) {
        if (p.status === 'active' && p.published_at) inv.products.push({ path: `/products/${p.handle}`, title: p.title });
      }
      for (const c of [...await s.getCustomCollections({ limit: 250 }), ...await s.getSmartCollections({ limit: 250 })]) {
        if (live(c.published_at)) inv.collections.push({ path: `/collections/${c.handle}`, title: c.title });
      }
      return inv;
    },
    async findArticle(handle) {
      const { findArticleByHandle } = await import('../../lib/post-kill.js');
      return findArticleByHandle(handle);
    },
    async askFast(prompt) {
      client = client || new Anthropic();
      const res = await client.messages.create({ model: LLM_MODELS.fast, max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
      if (res.stop_reason === 'max_tokens') throw new Error('model reply truncated at max_tokens');
      return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    },
    headStatus: async (path) => (await fetchStatus(path)).status,
    checkRedirect: (path) => fetchStatus(path),
    async articleBackup(article) {
      const s = await shopify();
      const full = await s.getArticle(article.blogId, article.id);
      const metafields = await s.getMetafields('articles', article.id);
      return {
        id: full.id, blog_id: article.blogId, handle: full.handle, title: full.title, tags: full.tags,
        author: full.author, published_at: full.published_at, summary_html: full.summary_html,
        body_html: full.body_html, image: full.image || null, metafields,
      };
    },
    async writeBackup(slug, date, data) {
      mkdirSync(BACKUP_DIR, { recursive: true });
      let p = join(BACKUP_DIR, `${slug}-${date}.json`);
      for (let n = 2; existsSync(p); n += 1) p = join(BACKUP_DIR, `${slug}-${date}--${n}.json`);
      writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
      if (statSync(p).size === 0) throw new Error('backup file is empty');
      return p;
    },
    // killPost resolves the article from these ids (both needed); removal.js checks they match.
    postArticleRef: async (slug) => {
      const m = getPostMeta(slug);
      return m ? { articleId: m.shopify_article_id ?? null, blogId: m.shopify_blog_id ?? null } : null;
    },
    async killPost(slug, opts) {
      const { killPost } = await import('../../lib/post-kill.js');
      return killPost(slug, opts);
    },

    // ── fix session
    async logTail(source) {
      if (!source) return '';
      const r = await exec('crontab', ['-l'], { timeout: 15_000 });
      const line = String(r.stdout || '').split('\n').find((l) => !l.trim().startsWith('#') && l.includes(source));
      const m = line && line.match(/(data\/[^\s"'>]+\.log)/);
      if (!m) return '';
      return readTail(join(ROOT, m[1]), 128 * 1024).split('\n').slice(-200).join('\n');
    },
    createFixCheckout: (name) => createFixCheckout(name, { exec, baseDir: FIX_BASE }),
    // Kill every process the unprivileged fix user still has. Exit 1 = none left.
    async reapFixUser() {
      await exec('pkill', ['-u', 'recapfix'], { timeout: 60_000 });
    },
    async listFixCheckouts() {
      if (!existsSync(FIX_BASE)) return [];
      return readdirSync(FIX_BASE).filter((n) => n.startsWith('fix-')).map((n) => {
        const path = `${FIX_BASE}/${n}`;
        try { return { path, mtimeMs: statSync(path).mtimeMs }; } catch { return null; }
      }).filter(Boolean);
    },
    runFixSession: (args) => runFixSession(args),
    shipFix: (args) => shipFix({ ...args, exec, deploy: () => deployServer({ exec }), token: env.GITHUB_TOKEN }),
    async removeDir(path) {
      const abs = resolve(path);
      if (!REMOVABLE.some((p) => abs.startsWith(p)) || abs.split('/').includes('..')) throw new Error(`refusing to remove ${abs}`);
      rmSync(abs, { recursive: true, force: true });
    },

    // ── growth
    gatherGrowthInputs: async () => gatherGrowthInputs(ROOT),
    generateGrowthRecs: (inputs) => generateGrowthRecs({ inputs }),

    // ── output
    async writeReport(report) {
      // Apply runs only (runReview routes a dry run to writeDryRun).
      writeAtomic(join(REVIEWER_DIR, 'latest.json'), report);
      writeAtomic(join(REVIEWER_DIR, `${report.date}.json`), report);
    },
    writeDryRun: async (report) => writeAtomic(join(REVIEWER_DIR, 'dry-run.json'), report),
    writeDone: async (done) => writeAtomic(join(REVIEWER_DIR, 'done.json'), done),
  };
}
