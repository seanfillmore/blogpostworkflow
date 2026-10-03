// agents/ad-concepts/occlusion.js
//
// Occlusion check on a FINISHED image: is any part of our product covered by the overlay
// type (or the sand caption strip) or cut off by the frame edge?
//
// Why it exists: the first live run (2026-10-03, coconut-soap / nourishing-tea-tree) shipped
// a "caption" final whose sand strip sat over the top of the soap bar and clipped the logo,
// and Ad Studio's critiqueArtifact scored it 4 and passed it. The critique judges the TYPE;
// nothing judged what the type was sitting on. This is that question, asked on its own.
//
// Fails CLOSED: an answer that is not a parseable JSON object with three real booleans is
// not ok. A check that cannot be read has not been passed.

const textOf = (msg) => (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

export function buildOcclusionPrompt({ productDescription, band }) {
  const where = band === 'bottom' ? 'bottom' : 'top';
  return `This is a finished static ad image. Our product appears in it: ${String(productDescription || 'our product').trim()}
Overlay type has been set across the ${where} quarter of the frame, sometimes on a solid sand-coloured caption strip.

Check ONLY our product, nothing else in the scene:
  - productVisible: is our product in the frame at all?
  - productCovered: is ANY part of our product (its body, lid, cap, wrapper, label or logo) covered or overlapped by the overlay type or the caption strip? Even a small overlap counts.
  - productCutOffByFrame: is any part of our product cut off by the edge of the frame?
Look closely at where the overlay meets the product. Do not assume it is fine.

Return ONLY: {"productVisible":true,"productCovered":false,"productCutOffByFrame":false,"detail":"one sentence naming what is covered or cut off, empty if nothing"}`;
}

export function parseOcclusionResponse(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  let o = null;
  if (a !== -1 && b > a) { try { o = JSON.parse(s.slice(a, b + 1)); } catch { o = null; } }
  const bools = o && ['productVisible', 'productCovered', 'productCutOffByFrame'].every(k => typeof o[k] === 'boolean');
  if (!bools) return { ok: false, detail: `occlusion check unparseable, treated as a failure: ${s.slice(0, 160)}` };
  const detail = String(o.detail || '').trim();
  if (!o.productVisible) return { ok: false, detail: detail || 'our product is not visible in the final image' };
  if (o.productCovered || o.productCutOffByFrame) {
    return { ok: false, detail: detail || (o.productCovered ? 'the overlay covers part of our product' : 'the frame edge cuts off part of our product') };
  }
  return { ok: true, detail };
}

export async function checkOcclusion({ anthropic, model, buffer, mediaType, productDescription, band }) {
  const msg = await anthropic.messages.create({
    model,
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: buildOcclusionPrompt({ productDescription, band }) },
      ],
    }],
  });
  if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: the occlusion check was cut off at the token limit');
  return parseOcclusionResponse(textOf(msg));
}
