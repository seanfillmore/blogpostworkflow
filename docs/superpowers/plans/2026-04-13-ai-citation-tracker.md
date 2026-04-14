# AI Citation Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track how often LLMs (Perplexity, ChatGPT, Gemini, Claude, Google AI Overview) cite or mention realskincare.com when answering product queries, and surface competitor citation data.

**Architecture:** `lib/llm-clients.js` provides thin API wrappers for each LLM. `agents/ai-citation-tracker/index.js` runs prompts through all sources, detects brand mentions/citations, saves weekly snapshots. Dashboard card and daily-summary integration surface the data.

**Tech Stack:** Perplexity Sonar API, OpenAI API, Google Gemini API, Anthropic API, DataForSEO SERP API

---

### Task 1: Create the prompt configuration

**Files:**
- Create: `config/ai-citation-prompts.json`

- [ ] **Step 1: Create the config file**

```json
{
  "prompts": [
    "best natural deodorant",
    "best coconut oil toothpaste",
    "best organic body lotion",
    "natural roll on deodorant",
    "fluoride free toothpaste that works",
    "coconut oil lip balm",
    "natural bar soap for sensitive skin",
    "aluminum free deodorant for women",
    "coconut body lotion for dry skin",
    "sls free toothpaste",
    "how to stop sweating naturally",
    "is aluminum in deodorant safe",
    "why switch to natural deodorant",
    "how to whiten teeth without fluoride",
    "what is sls in toothpaste",
    "best ingredients for dry skin",
    "how to choose natural skincare",
    "is coconut oil good for skin",
    "natural deodorant vs regular deodorant",
    "coconut oil toothpaste vs regular",
    "organic lotion vs regular lotion",
    "bar soap vs liquid soap",
    "natural lip balm vs chapstick",
    "fluoride vs fluoride free toothpaste",
    "real skin care reviews",
    "is realskincare.com legit",
    "real skin care deodorant",
    "real skin care toothpaste",
    "best natural skincare brands",
    "small natural skincare companies"
  ],
  "our_brand": ["realskincare", "real skin care", "realskincare.com"],
  "competitors": {
    "native": ["native deodorant", "native"],
    "schmidts": ["schmidt's", "schmidts"],
    "primallypure": ["primally pure", "primallypure"],
    "desertessence": ["desert essence"],
    "littleseedfarm": ["little seed farm"],
    "drgingers": ["dr. ginger's", "dr gingers"],
    "tomsofmaine": ["tom's of maine", "toms of maine"],
    "burtsbees": ["burt's bees", "burts bees"],
    "ethique": ["ethique"],
    "drbronner": ["dr. bronner", "dr bronner"],
    "each_and_every": ["each & every", "each and every"]
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add config/ai-citation-prompts.json
git commit -m "feat: add AI citation prompt list and competitor brands"
```

---

### Task 2: Create LLM client module

**Files:**
- Create: `lib/llm-clients.js`

- [ ] **Step 1: Create the module**

```js
/**
 * LLM API clients for citation tracking.
 * Each function takes a prompt string, returns { text, citations, error }.
 * citations is an array of URLs (empty if the source doesn't provide them).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSerpResults } from './dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();

export async function queryPerplexity(prompt) {
  const key = env.PERPLEXITY_API || process.env.PERPLEXITY_API;
  if (!key) return { text: null, citations: [], error: 'PERPLEXITY_API not set' };
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }),
    });
    if (!res.ok) return { text: null, citations: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      citations: data.citations || [],
      error: null,
    };
  } catch (err) {
    return { text: null, citations: [], error: err.message };
  }
}

export async function queryChatGPT(prompt) {
  const key = env.CHATGPT_API || process.env.CHATGPT_API;
  if (!key) return { text: null, citations: [], error: 'CHATGPT_API not set' };
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }),
    });
    if (!res.ok) return { text: null, citations: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || '',
      citations: [],
      error: null,
    };
  } catch (err) {
    return { text: null, citations: [], error: err.message };
  }
}

export async function queryGemini(prompt) {
  const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return { text: null, citations: [], error: 'GEMINI_API_KEY not set' };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 500 },
        }),
      },
    );
    if (!res.ok) return { text: null, citations: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
      citations: [],
      error: null,
    };
  } catch (err) {
    return { text: null, citations: [], error: err.message };
  }
}

export async function queryClaude(prompt) {
  const key = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return { text: null, citations: [], error: 'ANTHROPIC_API_KEY not set' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return { text: null, citations: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      text: data.content?.[0]?.text || '',
      citations: [],
      error: null,
    };
  } catch (err) {
    return { text: null, citations: [], error: err.message };
  }
}

export async function queryGoogleAIOverview(prompt) {
  try {
    const { result } = await (await import('./dataforseo.js')).default_api_post(
      '/serp/google/organic/live/advanced',
      { keyword: prompt, location_code: 2840, language_code: 'en', depth: 10, load_async_ai_overview: true },
    );
    // Fallback: use the exported getSerpResults but we need raw items
    // Actually, call the API directly for AI overview data
    const dfEnv = loadEnv();
    const AUTH = dfEnv.DATAFORSEO_PASSWORD;
    const res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([{
        keyword: prompt,
        location_code: 2840,
        language_code: 'en',
        depth: 10,
        load_async_ai_overview: true,
      }]),
    });
    if (!res.ok) return { text: null, citations: [], error: `HTTP ${res.status}` };
    const data = await res.json();
    const items = data.tasks?.[0]?.result?.[0]?.items || [];
    const aiItem = items.find((i) => i.type === 'ai_overview');
    if (!aiItem) return { text: '', citations: [], error: null };

    const markdown = aiItem.markdown || '';
    // Extract URLs from markdown links: [text](url)
    const urlRe = /\bhttps?:\/\/[^\s)>"]+/g;
    const citations = [...new Set((markdown.match(urlRe) || []).filter((u) => !u.includes('dataforseo.com')))];
    // Strip markdown to plain text
    const text = markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[#*_`>]/g, '').trim();

    return { text, citations, error: null };
  } catch (err) {
    return { text: null, citations: [], error: err.message };
  }
}

export const ALL_SOURCES = [
  { name: 'perplexity', fn: queryPerplexity },
  { name: 'chatgpt', fn: queryChatGPT },
  { name: 'gemini', fn: queryGemini },
  { name: 'claude', fn: queryClaude },
  { name: 'google_ai_overview', fn: queryGoogleAIOverview },
];
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "import('./lib/llm-clients.js').then(() => console.log('OK'))"`

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add lib/llm-clients.js
git commit -m "feat: add LLM client module for citation tracking"
```

---

### Task 3: Create the AI Citation Tracker agent

**Files:**
- Create: `agents/ai-citation-tracker/index.js`

- [ ] **Step 1: Create the agent directory and file**

```bash
mkdir -p agents/ai-citation-tracker
```

Create `agents/ai-citation-tracker/index.js`:

```js
/**
 * AI Citation Tracker
 *
 * Runs target prompts through 5 LLM sources, detects brand mentions
 * and citations, saves weekly snapshots for trend tracking.
 *
 * Usage:
 *   node agents/ai-citation-tracker/index.js
 *   node agents/ai-citation-tracker/index.js --limit 5   # test with fewer prompts
 *
 * Output:
 *   data/reports/ai-citations/YYYY-MM-DD.json
 *   data/reports/ai-citations/latest.json
 *   data/reports/ai-citations/ai-citation-report.md
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SOURCES } from '../../lib/llm-clients.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ai-citations');
const CONFIG_PATH = join(ROOT, 'config', 'ai-citation-prompts.json');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const promptConfig = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

// ── Detection ────────────────────────────────────────────────────────────────

function detectBrandMention(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return promptConfig.our_brand.some((term) => lower.includes(term.toLowerCase()));
}

function detectCitation(citations) {
  return citations.some((url) => url.toLowerCase().includes('realskincare.com'));
}

function detectCompetitors(text) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const found = [];
  for (const [key, terms] of Object.entries(promptConfig.competitors)) {
    if (terms.some((t) => lower.includes(t.toLowerCase()))) {
      found.push(key);
    }
  }
  return found;
}

// ── Report ───────────────────────────────────────────────────────────────────

function loadPreviousSnapshot() {
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  // Skip today's file if it exists
  const today = new Date().toISOString().slice(0, 10);
  const prev = files.find((f) => f !== `${today}.json`);
  if (!prev) return null;
  try { return JSON.parse(readFileSync(join(REPORTS_DIR, prev), 'utf8')); } catch { return null; }
}

function buildMarkdownReport(snapshot, prev) {
  const lines = [];
  lines.push(`# AI Citation Report — ${config.name}`);
  lines.push(`**Date:** ${snapshot.date}`);
  lines.push(`**Prompts:** ${snapshot.prompts_run} | **Sources:** ${snapshot.sources.join(', ')}`);
  lines.push('');

  // Summary table
  lines.push('## Citation & Mention Rates\n');
  lines.push('| Source | Cited | Mentioned | Prev Mentioned |');
  lines.push('|--------|-------|-----------|----------------|');
  for (const source of snapshot.sources) {
    const citRate = snapshot.summary.citation_rate[source];
    const menRate = snapshot.summary.mention_rate[source];
    const prevRate = prev?.summary?.mention_rate?.[source];
    const citStr = citRate != null ? `${(citRate * 100).toFixed(0)}%` : 'n/a';
    const menStr = `${(menRate * 100).toFixed(0)}%`;
    const prevStr = prevRate != null ? `${(prevRate * 100).toFixed(0)}%` : '—';
    lines.push(`| ${source} | ${citStr} | ${menStr} | ${prevStr} |`);
  }
  lines.push('');

  // Top competitor mentions
  lines.push('## Top Competitor Mentions\n');
  const sorted = Object.entries(snapshot.summary.top_competitor_mentions)
    .sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    lines.push('No competitor mentions detected.\n');
  } else {
    lines.push('| Competitor | Mentions |');
    lines.push('|------------|----------|');
    for (const [comp, count] of sorted.slice(0, 15)) {
      lines.push(`| ${comp} | ${count} |`);
    }
    lines.push('');
  }

  // Per-prompt details (only prompts where we were cited/mentioned)
  const cited = snapshot.results.filter((r) =>
    Object.values(r.responses).some((resp) => resp.cited || resp.mentioned),
  );
  if (cited.length > 0) {
    lines.push('## Prompts Where We Appear\n');
    for (const r of cited) {
      const sources = Object.entries(r.responses)
        .filter(([, resp]) => resp.cited || resp.mentioned)
        .map(([s, resp]) => `${s}${resp.cited ? ' (cited)' : ' (mentioned)'}`);
      lines.push(`- **"${r.prompt}"** — ${sources.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nAI Citation Tracker — ${config.name}\n`);

  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) : null;

  const prompts = limit ? promptConfig.prompts.slice(0, limit) : promptConfig.prompts;
  console.log(`  Prompts: ${prompts.length} | Sources: ${ALL_SOURCES.length}`);

  mkdirSync(REPORTS_DIR, { recursive: true });

  const results = [];

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    process.stdout.write(`  [${i + 1}/${prompts.length}] "${prompt.slice(0, 50)}"...`);

    const responses = {};
    for (const { name, fn } of ALL_SOURCES) {
      const { text, citations, error } = await fn(prompt);
      if (error) {
        responses[name] = { cited: null, mentioned: false, citations: [], competitor_mentions: [], error };
      } else {
        const cited = citations.length > 0 ? detectCitation(citations) : null;
        const mentioned = detectBrandMention(text);
        const competitor_mentions = detectCompetitors(text);
        const citationDomains = citations.map((u) => {
          try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
        });
        responses[name] = { cited, mentioned, citations: citationDomains, competitor_mentions };
      }
    }

    results.push({ prompt, responses });
    console.log(' done');
  }

  // Build summary
  const sourceNames = ALL_SOURCES.map((s) => s.name);
  const citationRate = {};
  const mentionRate = {};
  for (const source of sourceNames) {
    const valid = results.filter((r) => r.responses[source] && !r.responses[source].error);
    const cited = valid.filter((r) => r.responses[source].cited === true);
    const mentioned = valid.filter((r) => r.responses[source].mentioned);
    citationRate[source] = valid.some((r) => r.responses[source].cited != null)
      ? cited.length / (valid.length || 1)
      : null;
    mentionRate[source] = mentioned.length / (valid.length || 1);
  }

  const compCounts = {};
  for (const r of results) {
    for (const resp of Object.values(r.responses)) {
      for (const comp of resp.competitor_mentions || []) {
        compCounts[comp] = (compCounts[comp] || 0) + 1;
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = {
    date: today,
    prompts_run: prompts.length,
    sources: sourceNames,
    results,
    summary: {
      citation_rate: citationRate,
      mention_rate: mentionRate,
      top_competitor_mentions: compCounts,
    },
  };

  // Save snapshot
  const snapshotPath = join(REPORTS_DIR, `${today}.json`);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  copyFileSync(snapshotPath, join(REPORTS_DIR, 'latest.json'));
  console.log(`\n  Snapshot: ${snapshotPath}`);

  // Build report
  const prev = loadPreviousSnapshot();
  const report = buildMarkdownReport(snapshot, prev);
  writeFileSync(join(REPORTS_DIR, 'ai-citation-report.md'), report);
  console.log(`  Report:   data/reports/ai-citations/ai-citation-report.md`);

  // Summary output
  const totalMentions = results.filter((r) =>
    Object.values(r.responses).some((resp) => resp.cited || resp.mentioned),
  ).length;
  const topComp = Object.entries(compCounts).sort((a, b) => b[1] - a[1])[0];
  console.log(`\n  Mentioned/cited in ${totalMentions}/${prompts.length * sourceNames.length} responses`);
  if (topComp) console.log(`  Top competitor: ${topComp[0]} (${topComp[1]} mentions)`);

  // Notify
  await notify({
    subject: `AI Citations: mentioned in ${totalMentions} responses, top competitor: ${topComp?.[0] || 'none'}`,
    body: `Prompts: ${prompts.length}\nSources: ${sourceNames.join(', ')}\nMentioned/cited: ${totalMentions}\nTop competitor: ${topComp ? `${topComp[0]} (${topComp[1]})` : 'none'}`,
    status: totalMentions > 0 ? 'success' : 'warning',
  });

  console.log('\nDone.');
}

main().catch((err) => {
  notify({ subject: 'AI Citation Tracker failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add agents/ai-citation-tracker/index.js
git commit -m "feat: add AI citation tracker agent"
```

---

### Task 4: Add to scheduler and daily summary

**Files:**
- Modify: `scheduler.js`
- Modify: `agents/daily-summary/index.js`

- [ ] **Step 1: Add to scheduler**

In `scheduler.js`, find the weekly Sunday section. After the cannibalization-resolver step (around line 197), add:

```js
  // Step 8b: AI citation tracking across LLMs
  runStep('ai-citation-tracker', `"${NODE}" agents/ai-citation-tracker/index.js`, { indent: '    ' });
```

- [ ] **Step 2: Add to daily summary**

In `agents/daily-summary/index.js`, find where the HTML body is assembled (look for the section that builds `seoSection` or the SEO & Rankings section). After the existing SEO section content, add a block that reads the AI citation report:

Find the line that builds the SEO section (around line 327):
```js
    ? `<div class="section"><div class="section-title">SEO &amp; Rankings</div>${renderEntries(groups.seo)}</div>` : '';
```

After the `seoSection` variable assignment, add:

```js
  // AI Citation summary (weekly — show if report exists and is < 8 days old)
  let aiCitationSection = '';
  try {
    const citPath = join(ROOT, 'data', 'reports', 'ai-citations', 'latest.json');
    if (existsSync(citPath)) {
      const cit = JSON.parse(readFileSync(citPath, 'utf8'));
      const age = (Date.now() - new Date(cit.date).getTime()) / (1000 * 60 * 60 * 24);
      if (age < 8) {
        const totalResponses = cit.prompts_run * cit.sources.length;
        const mentioned = cit.results.filter(r => Object.values(r.responses).some(resp => resp.cited || resp.mentioned)).length;
        const topComp = Object.entries(cit.summary.top_competitor_mentions).sort((a, b) => b[1] - a[1])[0];
        aiCitationSection = `<div class="section"><div class="section-title">&#129302; AI Citations</div>` +
          `<p>Mentioned in <strong>${mentioned}</strong> of ${totalResponses} LLM responses across ${cit.sources.length} sources.</p>` +
          (topComp ? `<p>Top competitor: <strong>${topComp[0]}</strong> (${topComp[1]} mentions)</p>` : '') +
          `</div>`;
      }
    }
  } catch { /* skip */ }
```

Then include `aiCitationSection` in the final HTML body assembly — find where `seoSection` is concatenated and add `aiCitationSection` after it.

- [ ] **Step 3: Commit**

```bash
git add scheduler.js agents/daily-summary/index.js
git commit -m "feat: add AI citation tracker to weekly scheduler and daily summary"
```

---

### Task 5: Add dashboard card

**Files:**
- Modify: `agents/dashboard/lib/data-loader.js`
- Modify: `agents/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Load citation data in data-loader**

In `agents/dashboard/lib/data-loader.js`, after the cannibalization data loading (around line 228), add:

```js
  const aiCitations = readJsonIfExists(join(REPORTS_DIR, 'ai-citations', 'latest.json'));
```

Then add `aiCitations` to the returned object (find the return statement and add it alongside the other fields).

- [ ] **Step 2: Add the dashboard card**

In `agents/dashboard/public/js/dashboard.js`, add the render function (before `renderPerformanceQueueCard`):

```js
function renderAICitationCard(d) {
  var c = d.aiCitations;
  if (!c || !c.results) return '';
  var sources = c.sources || [];
  var mentionRows = sources.map(function(s) {
    var menRate = c.summary.mention_rate[s];
    var citRate = c.summary.citation_rate[s];
    var menPct = (menRate * 100).toFixed(0) + '%';
    var citPct = citRate != null ? (citRate * 100).toFixed(0) + '%' : 'n/a';
    return '<tr><td>' + esc(s) + '</td><td>' + citPct + '</td><td>' + menPct + '</td></tr>';
  }).join('');

  var compEntries = Object.entries(c.summary.top_competitor_mentions || {}).sort(function(a, b) { return b[1] - a[1]; });
  var compRows = compEntries.slice(0, 8).map(function(e) {
    return '<tr><td>' + esc(e[0]) + '</td><td>' + e[1] + '</td></tr>';
  }).join('');

  return '<div class="card"><div class="card-header accent-purple"><h2>AI Citations</h2>' +
    '<span class="card-subtitle">' + c.prompts_run + ' prompts across ' + sources.length + ' LLMs &mdash; ' + esc(c.date) + '</span></div>' +
    '<div class="card-body">' +
    '<h3 style="font-size:12px;text-transform:uppercase;color:var(--muted);margin:0 0 8px">Our Visibility</h3>' +
    '<table class="data-table"><thead><tr><th>Source</th><th>Cited</th><th>Mentioned</th></tr></thead><tbody>' + mentionRows + '</tbody></table>' +
    (compRows ? '<h3 style="font-size:12px;text-transform:uppercase;color:var(--muted);margin:16px 0 8px">Top Competitor Mentions</h3>' +
    '<table class="data-table"><thead><tr><th>Competitor</th><th>Mentions</th></tr></thead><tbody>' + compRows + '</tbody></table>' : '') +
    '</div></div>';
}
```

- [ ] **Step 3: Wire the card into the Optimize tab**

Find where the Optimize tab cards are assembled (around line 421):

```js
  document.getElementById('tab-optimize').innerHTML =
    renderPerformanceQueueCard(d) +
    renderCannibalizationCard(d) +
```

Add `renderAICitationCard(d) +` after `renderCannibalizationCard(d) +`:

```js
  document.getElementById('tab-optimize').innerHTML =
    renderPerformanceQueueCard(d) +
    renderCannibalizationCard(d) +
    renderAICitationCard(d) +
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/lib/data-loader.js agents/dashboard/public/js/dashboard.js
git commit -m "feat: add AI citation dashboard card"
```

---

### Task 6: Run initial test and deploy

- [ ] **Step 1: Test locally with 3 prompts**

```bash
node agents/ai-citation-tracker/index.js --limit 3
```

Expected: runs 3 prompts through 5 sources, saves snapshot and report. Check `data/reports/ai-citations/latest.json` exists.

- [ ] **Step 2: Push, sync env, deploy**

```bash
git push
scp .env root@137.184.119.230:~/seo-claude/.env
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 3: Run full 30-prompt scan on server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/ai-citation-tracker/index.js'
```

Expected: ~2-3 minutes for 150 API calls. Snapshot + report saved. Dashboard shows the AI Citations card on the Optimize tab.
