/**
 * LLM client module for AI citation tracking.
 *
 * All live-answer sources route through the DataForSEO AI Optimization
 * (LLM Responses) API under the single DATAFORSEO_PASSWORD credential — one key
 * instead of four (Perplexity / OpenAI / Gemini / Anthropic), and the spend is
 * now visible in the DataForSEO balance instead of scattered across providers
 * (the old raw-fetch Anthropic path bypassed lib/anthropic.js metering entirely).
 *
 * Each function returns { text, citations, error } — the same contract the
 * ai-citation-tracker has always consumed, so nothing downstream changes.
 * Google AI Overview stays on the DataForSEO SERP endpoint (unchanged).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const DFS_AUTH = env.DATAFORSEO_PASSWORD || process.env.DATAFORSEO_PASSWORD;

function fail(error) {
  return { text: null, citations: [], error };
}

// ---------- DataForSEO LLM Responses (shared transport) ----------

/**
 * Run a prompt live through a DataForSEO-brokered LLM and normalize the result.
 * The response is a list of `sections`; text sections carry the answer body and
 * `annotations[].url` carry the web-search citations.
 *
 * @param {string} provider - DataForSEO path segment: chat_gpt | gemini | perplexity | claude
 * @param {string} model - model_name for that provider
 * @param {string} prompt
 * @param {object} opts - { webSearch } — enables the web-search tool loop (needed
 *   for citations). Left OFF for claude-haiku: it emits only a "let me search…"
 *   preamble instead of completing the loop through DataForSEO. Without search it
 *   answers from training (mention-only), matching the old Claude client's behavior.
 */
async function queryLlmResponse(provider, model, prompt, { webSearch = true } = {}) {
  if (!DFS_AUTH) return fail('DATAFORSEO_PASSWORD not set');
  try {
    const res = await fetch(`https://api.dataforseo.com/v3/ai_optimization/${provider}/llm_responses/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${DFS_AUTH}` },
      body: JSON.stringify([{
        user_prompt: prompt,
        model_name: model,
        web_search: webSearch,
        max_output_tokens: 600,
      }]),
    });
    if (!res.ok) return fail(`DataForSEO ${provider} ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.status_code !== 20000) return fail(`DataForSEO ${provider}: ${data.status_message}`);
    const task = data.tasks?.[0];
    if (task?.status_code !== 20000) return fail(`DataForSEO ${provider}: ${task?.status_message}`);
    const item = task.result?.[0]?.items?.[0] || task.result?.[0];
    const sections = item?.sections || [];
    const text = sections
      .filter((s) => s.type === 'text' && s.text)
      .map((s) => s.text)
      .join('\n\n')
      .trim() || null;
    const citations = [...new Set(
      sections.flatMap((s) => (s.annotations || []).map((a) => a.url)).filter(Boolean)
    )];
    return { text, citations, error: null };
  } catch (e) {
    return fail(`DataForSEO ${provider} error: ${e.message}`);
  }
}

// ---------- Per-provider wrappers ----------
// Model choices favor cheap models that support web_search (needed for citations).

export function queryPerplexity(prompt) {
  return queryLlmResponse('perplexity', 'sonar', prompt);
}

export function queryChatGPT(prompt) {
  return queryLlmResponse('chat_gpt', 'gpt-4o-mini', prompt);
}

export function queryGemini(prompt) {
  return queryLlmResponse('gemini', 'gemini-2.5-flash', prompt);
}

export function queryClaude(prompt) {
  // web_search off — see queryLlmResponse note. For real Claude citations, switch
  // to model 'claude-sonnet-4-6' with webSearch:true (~28× the cost per call).
  return queryLlmResponse('claude', 'claude-haiku-4-5', prompt, { webSearch: false });
}

// ---------- Google AI Overview (via DataForSEO SERP) ----------

export async function queryGoogleAIOverview(prompt) {
  const key = env.DATAFORSEO_PASSWORD || process.env.DATAFORSEO_PASSWORD;
  if (!key) return fail('DATAFORSEO_PASSWORD not set');
  try {
    const res = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/advanced', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${key}`,
      },
      body: JSON.stringify([{
        keyword: prompt,
        location_code: 2840,
        language_code: 'en',
        depth: 10,
        load_async_ai_overview: true,
      }]),
    });
    if (!res.ok) return fail(`DataForSEO API ${res.status}: ${await res.text()}`);
    const data = await res.json();

    const items = data.tasks?.[0]?.result?.[0]?.items || [];
    const aiItem = items.find(it => it.type === 'ai_overview');
    if (!aiItem) return { text: null, citations: [], error: null };

    const markdown = aiItem.markdown || '';
    // Strip markdown syntax for plain text
    const text = markdown
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // [text](url) → text
      .replace(/[#*_~`>]/g, '')                   // strip markdown chars
      .replace(/\n{3,}/g, '\n\n')                 // collapse blank lines
      .trim();

    // Extract URLs from markdown, filtering out dataforseo.com
    const urlMatches = markdown.match(/https?:\/\/[^\s)>\]]+/g) || [];
    const citations = [...new Set(urlMatches)]
      .filter(u => !u.includes('dataforseo.com'));

    return { text, citations, error: null };
  } catch (e) {
    return fail(`DataForSEO error: ${e.message}`);
  }
}

// ---------- Export ----------

export const ALL_SOURCES = [
  { name: 'perplexity', fn: queryPerplexity },
  { name: 'chatgpt', fn: queryChatGPT },
  { name: 'gemini', fn: queryGemini },
  { name: 'claude', fn: queryClaude },
  { name: 'google_ai_overview', fn: queryGoogleAIOverview },
];
