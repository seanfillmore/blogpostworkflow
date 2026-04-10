// agents/performance-engine/prompts.js
export function buildSummaryPrompt({ slug, trigger, signal, originalHtml, refreshedHtml }) {
  return `You are summarizing a content refresh that was just performed on a Shopify blog post for a natural skincare brand (Real Skin Care). The post was picked up by our automated SEO engine based on a specific signal, then rewritten or adjusted by the content-refresher agent.

Your job: produce a short, plain-English summary that a busy founder can read in 10 seconds and decide whether to approve or give feedback. No jargon. No hedging. Write it as if you were the editor telling the founder exactly what just happened.

POST: ${slug}
TRIGGER: ${trigger}
SIGNAL: ${JSON.stringify(signal, null, 2)}

ORIGINAL HTML (truncated):
${originalHtml.slice(0, 6000)}

REFRESHED HTML (truncated):
${refreshedHtml.slice(0, 6000)}

Respond with EXACTLY this JSON shape, no markdown fence, no commentary:

{
  "what_changed": "1-2 sentences describing the specific edits (sections rewritten, things added, things removed).",
  "why": "1-2 sentences connecting the edits to the signal that triggered the refresh.",
  "projected_impact": "1-2 sentences with a concrete expected outcome, or the string 'unclear' if you can't predict a specific impact."
}`;
}
