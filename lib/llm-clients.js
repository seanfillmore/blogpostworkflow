/**
 * LLM client module for AI citation tracking.
 * Thin API wrappers for 5 LLM sources.
 * Each function returns { text, citations, error }.
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

function fail(error) {
  return { text: null, citations: [], error };
}

// ---------- Perplexity ----------

export async function queryPerplexity(prompt) {
  const key = env.PERPLEXITY_API || process.env.PERPLEXITY_API;
  if (!key) return fail('PERPLEXITY_API not set');
  try {
    const res = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }),
    });
    if (!res.ok) return fail(`Perplexity API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || null,
      citations: Array.isArray(data.citations) ? data.citations : [],
      error: null,
    };
  } catch (e) {
    return fail(`Perplexity error: ${e.message}`);
  }
}

// ---------- ChatGPT ----------

export async function queryChatGPT(prompt) {
  const key = env.CHATGPT_API || process.env.CHATGPT_API;
  if (!key) return fail('CHATGPT_API not set');
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500,
      }),
    });
    if (!res.ok) return fail(`ChatGPT API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.choices?.[0]?.message?.content || null,
      citations: [],
      error: null,
    };
  } catch (e) {
    return fail(`ChatGPT error: ${e.message}`);
  }
}

// ---------- Gemini ----------

export async function queryGemini(prompt) {
  const key = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  if (!key) return fail('GEMINI_API_KEY not set');
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 500 },
      }),
    });
    if (!res.ok) return fail(`Gemini API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.candidates?.[0]?.content?.parts?.[0]?.text || null,
      citations: [],
      error: null,
    };
  } catch (e) {
    return fail(`Gemini error: ${e.message}`);
  }
}

// ---------- Claude ----------

export async function queryClaude(prompt) {
  const key = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!key) return fail('ANTHROPIC_API_KEY not set');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return fail(`Claude API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return {
      text: data.content?.[0]?.text || null,
      citations: [],
      error: null,
    };
  } catch (e) {
    return fail(`Claude error: ${e.message}`);
  }
}

// ---------- Google AI Overview (via DataForSEO) ----------

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
