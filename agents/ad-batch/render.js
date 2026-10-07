// agents/ad-batch/render.js
//
// Image generation. OpenAI gpt-image-2 is primary (2026-10-06 spike: 29/29 exact
// headline and label text); Gemini 3 Pro Image is the fallback (as good-looking, but
// 2 of 5 label slips in the same spike). Network calls take injected fetch/clients.

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { CREATIVE_MODELS } from '../../config/creative-models.js';

export const OPENAI_IMAGE_MODEL = CREATIVE_MODELS.adBatch.imageGen;
export const GEMINI_IMAGE_MODEL = CREATIVE_MODELS.adBatch.fallbackImageGen;
// 4:5 at Meta's recommended feed size; gpt-image-2 accepts custom sizes in multiples of 16.
export const OPENAI_SIZE = '1088x1360';

// USD per 1M image tokens. developers.openai.com/api/docs/pricing (read 2026-10-06)
// lists gpt-image-2 at $4 in / $15 out under BATCH; the standard rate is assumed to be
// double, as it is for every sibling model on that page. An estimate, labelled as one.
export const OPENAI_USD_PER_M = { input: 8, output: 30 };
export const GEMINI_USD_PER_RENDER = 0.13;

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export function openAiCostUsd(usage) {
  if (!usage) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  return (inTok * OPENAI_USD_PER_M.input + outTok * OPENAI_USD_PER_M.output) / 1e6;
}

export async function renderOpenAI({ apiKey, prompt, refs, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('no OPENAI_API_KEY');
  const fd = new FormData();
  fd.append('model', OPENAI_IMAGE_MODEL);
  fd.append('prompt', prompt);
  fd.append('size', OPENAI_SIZE);
  fd.append('quality', 'high');
  for (const p of refs) {
    fd.append('image[]', new Blob([readFileSync(p)], { type: MIME[extname(p).toLowerCase()] || 'image/jpeg' }), p.split('/').pop());
  }
  const r = await fetchImpl('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${j?.error?.message || 'request failed'}`);
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return { buffer: Buffer.from(b64, 'base64'), model: OPENAI_IMAGE_MODEL, costUsd: openAiCostUsd(j.usage), usage: j.usage || null };
}

export async function renderGemini({ gemini, prompt, refs }) {
  if (!gemini) throw new Error('no GEMINI_API_KEY');
  const parts = refs.map(p => ({ inlineData: { data: readFileSync(p).toString('base64'), mimeType: MIME[extname(p).toLowerCase()] || 'image/jpeg' } }));
  parts.push({ text: prompt });
  const res = await gemini.models.generateContent({
    model: GEMINI_IMAGE_MODEL,
    contents: [{ role: 'user', parts }],
    config: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { imageSize: '2K', aspectRatio: '4:5' } },
  });
  const img = res?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!img) throw new Error('Gemini returned no image');
  return { buffer: Buffer.from(img.inlineData.data, 'base64'), model: GEMINI_IMAGE_MODEL, costUsd: GEMINI_USD_PER_RENDER, usage: null };
}

/** Attempt plan: two OpenAI tries, then one Gemini try. */
export const ATTEMPTS = ['openai', 'openai', 'gemini'];
