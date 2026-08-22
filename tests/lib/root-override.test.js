// tests/lib/root-override.test.js
//
// lib/posts.js, lib/calendar-store.js and agents/dashboard/lib/paths.js each resolve
// a module-scope ROOT from __dirname. A test that imports them normally is reaching
// the REAL repo root — that's how a test in the hardening branch reached a live
// killPost() (real Shopify DELETE) and how another wrote real files into
// data/creative-sessions/. SEO_CLAUDE_ROOT lets a test redirect all three at a scratch
// directory instead.
//
// ESM caches modules by resolved URL (including query string), so importing the same
// specifier twice returns the same cached instance regardless of what SEO_CLAUDE_ROOT
// is set to at the second import. Each import below uses a unique cache-busting query
// so it is evaluated fresh, picking up whatever SEO_CLAUDE_ROOT is set to at that
// moment.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REAL_ROOT = resolve(new URL('../..', import.meta.url).pathname);

test('lib/posts.js ROOT/POSTS_DIR follow SEO_CLAUDE_ROOT when set', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'seo-claude-root-override-'));
  const prev = process.env.SEO_CLAUDE_ROOT;
  process.env.SEO_CLAUDE_ROOT = scratch;
  try {
    const mod = await import(`../../lib/posts.js?override=${Date.now()}-${Math.random()}`);
    assert.equal(mod.ROOT, scratch, 'ROOT should be exactly the scratch dir, not joined onto it');
    assert.equal(mod.POSTS_DIR, join(scratch, 'data', 'posts'));
    assert.notEqual(mod.ROOT, REAL_ROOT, 'must not resolve to the real repo');
  } finally {
    if (prev === undefined) delete process.env.SEO_CLAUDE_ROOT; else process.env.SEO_CLAUDE_ROOT = prev;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('lib/posts.js falls back to the real repo root when SEO_CLAUDE_ROOT is unset', async () => {
  const prev = process.env.SEO_CLAUDE_ROOT;
  delete process.env.SEO_CLAUDE_ROOT;
  try {
    const mod = await import(`../../lib/posts.js?override=${Date.now()}-${Math.random()}`);
    assert.equal(mod.ROOT, REAL_ROOT);
  } finally {
    if (prev !== undefined) process.env.SEO_CLAUDE_ROOT = prev;
  }
});

test('lib/calendar-store.js CALENDAR_DIR follows SEO_CLAUDE_ROOT when set', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'seo-claude-root-override-'));
  const prev = process.env.SEO_CLAUDE_ROOT;
  process.env.SEO_CLAUDE_ROOT = scratch;
  try {
    const mod = await import(`../../lib/calendar-store.js?override=${Date.now()}-${Math.random()}`);
    assert.equal(mod.CALENDAR_DIR, join(scratch, 'data', 'calendar'));
    assert.equal(mod.CALENDAR_JSON_PATH, join(scratch, 'data', 'calendar', 'calendar.json'));
    assert.equal(mod.CALENDAR_MD_PATH, join(scratch, 'data', 'reports', 'content-strategist', 'content-calendar.md'));
  } finally {
    if (prev === undefined) delete process.env.SEO_CLAUDE_ROOT; else process.env.SEO_CLAUDE_ROOT = prev;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('agents/dashboard/lib/paths.js ROOT and its derived dirs follow SEO_CLAUDE_ROOT when set', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'seo-claude-root-override-'));
  const prev = process.env.SEO_CLAUDE_ROOT;
  process.env.SEO_CLAUDE_ROOT = scratch;
  try {
    const mod = await import(`../../agents/dashboard/lib/paths.js?override=${Date.now()}-${Math.random()}`);
    assert.equal(mod.ROOT, scratch, 'the override is the root itself, not something to join onto');
    assert.equal(mod.POSTS_DIR, join(scratch, 'data', 'posts'));
    // creatives-store.js's session/creative dirs come from this same module — proving
    // ROOT redirects means every downstream dir (including the ones the report calls
    // out: data/creative-sessions/) is redirected too, without touching that call site.
    assert.equal(mod.CREATIVE_SESSIONS_DIR, join(scratch, 'data', 'creative-sessions'));
    assert.equal(mod.CREATIVES_DIR, join(scratch, 'data', 'creatives'));
  } finally {
    if (prev === undefined) delete process.env.SEO_CLAUDE_ROOT; else process.env.SEO_CLAUDE_ROOT = prev;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('agents/dashboard/lib/paths.js falls back to the real three-level walk when SEO_CLAUDE_ROOT is unset', async () => {
  const prev = process.env.SEO_CLAUDE_ROOT;
  delete process.env.SEO_CLAUDE_ROOT;
  try {
    const mod = await import(`../../agents/dashboard/lib/paths.js?override=${Date.now()}-${Math.random()}`);
    assert.equal(mod.ROOT, REAL_ROOT);
  } finally {
    if (prev !== undefined) process.env.SEO_CLAUDE_ROOT = prev;
  }
});
