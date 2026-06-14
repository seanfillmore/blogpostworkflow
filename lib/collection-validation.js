// lib/collection-validation.js
// Pure validation of an LLM-generated collection spec before it is created/queued.
// Closes the bug class where a spec with title "DISQUALIFIED" (or thin/placeholder
// body) was published verbatim because nothing validated the model's JSON output.

const SENTINELS = new Set(['disqualified', 'not approved', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd']);
const MIN_BODY_WORDS = 300;

function slugify(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
function wordCount(html) { return String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length; }

/**
 * @param {object} spec  { title, handle, seo_title, meta_description, body_html }
 * @param {{existingHandles?:Set<string>}} ctx
 * @returns {{ ok:boolean, errors:string[] }}
 */
export function validateCollectionSpec(spec, { existingHandles } = {}) {
  const errors = [];
  const s = spec || {};
  const title = String(s.title || '').trim();
  if (!title) errors.push('title is empty');
  else if (SENTINELS.has(title.toLowerCase())) errors.push(`title is a sentinel/non-title value: "${title}"`);
  else if (title.length > 120) errors.push(`title too long (${title.length} > 120)`);

  const handle = slugify(s.handle);
  if (!handle) errors.push('handle is empty or unslugifiable');
  else if (existingHandles && existingHandles.has(handle)) errors.push(`handle already exists: "${handle}"`);

  const seo = String(s.seo_title || '').trim();
  if (!seo) errors.push('seo_title is empty');
  else if (seo.length > 70) errors.push(`seo_title too long (${seo.length} > 70)`);

  const meta = String(s.meta_description || '').trim();
  if (!meta) errors.push('meta_description is empty');
  else if (meta.length < 40 || meta.length > 165) errors.push(`meta_description length out of range (${meta.length}, want 40-165)`);

  if (!s.body_html) errors.push('body_html missing');
  else {
    const wc = wordCount(s.body_html);
    if (wc < MIN_BODY_WORDS) errors.push(`body_html too thin (${wc} words < ${MIN_BODY_WORDS})`);
  }

  return { ok: errors.length === 0, errors };
}

export { MIN_BODY_WORDS };
