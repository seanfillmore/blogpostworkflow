// agents/dashboard/lib/chat-transcript.js
//
// Lets the dashboard's two chats run on the Claude SUBSCRIPTION instead of the
// per-token API.
//
// Why: lib/claude-subscription.js carries one user turn per CLI call, with no
// tools. A multi-turn history or a tool definition therefore took the direct
// API, and the server's ANTHROPIC_API_KEY has been invalid (401) since at least
// 2026-10-03, so both chats answered "API key is invalid" to every message. The
// fix is not a new key: it is to stop needing one. The history becomes a single
// transcript turn, and the ads chat's three actions become one tagged JSON line
// that the route parses and validates itself. Pure; no I/O.

/** Characters kept per message, matching the tab chat's existing cap. */
const MAX_MESSAGE_CHARS = 4000;

const SPEAKER = { user: 'User', assistant: 'Assistant' };

/**
 * One user turn carrying the whole conversation.
 *
 * @param {{role: string, content?: string, tool?: string}[]} history
 *   user / assistant entries, plus `action` entries ({ role: 'action', content })
 *   recording something the app did, rendered as a bracketed note.
 */
export function transcriptPrompt(history) {
  const lines = [];
  for (const m of history || []) {
    const text = String(m?.content ?? '').slice(0, MAX_MESSAGE_CHARS).trim();
    if (!text) continue;
    if (m.role === 'action') lines.push(`[Action taken by the app: ${text}]`);
    else lines.push(`${SPEAKER[m.role] || 'User'}: ${text}`);
  }
  return [
    'Below is the conversation so far, oldest first. Reply to the user\'s latest message as the Assistant. Write only your reply: no "Assistant:" prefix, and do not continue the conversation past your own turn.',
    '',
    '<conversation>',
    lines.join('\n\n'),
    '</conversation>',
  ].join('\n');
}

// ── Ads chat actions ──────────────────────────────────────────────────────────

export const ACTIONS = ['approve_suggestion', 'reject_suggestion', 'update_suggestion'];
const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'];

/** What the model is told about the actions, replacing the old tool definitions. */
export function actionInstructions(suggestionType, allowedFields) {
  return [
    'ACTIONS: you can change this suggestion, but ONLY when the user has explicitly signalled a decision in their latest message, never speculatively. To act, end your reply with exactly one line:',
    '<ACTION>{"tool": "<name>", "input": {...}}</ACTION>',
    '- approve_suggestion: approve as-is. input {}',
    '- reject_suggestion: reject it. input {}',
    `- update_suggestion: change fields and approve. Valid fields for this ${suggestionType} suggestion: ${allowedFields.length ? allowedFields.join(', ') : 'none'} (proposedCpcMicros is an integer in micros; matchType is EXACT, PHRASE or BROAD).`,
    'Write your reply as if the action has been carried out. With no decision from the user, write no ACTION line.',
  ].join('\n');
}

/**
 * Pull an action out of a reply. Returns the reply text with the tag removed and
 * either a validated action or null. An unparseable or unknown action is
 * reported in `rejected`, never applied: the failure direction is "nothing
 * changed", the same rule as every other write guard in this repo.
 */
export function parseAction(text, allowedFields = []) {
  const raw = String(text || '');
  const tags = [...raw.matchAll(/<ACTION>([\s\S]*?)<\/ACTION>/g)];
  const clean = raw.replace(/<ACTION>[\s\S]*?<\/ACTION>/g, '').trim();
  if (!tags.length) return { text: clean, action: null, rejected: null };
  if (tags.length > 1) return { text: clean, action: null, rejected: 'more than one ACTION line' };
  let obj;
  try { obj = JSON.parse(tags[0][1].trim()); } catch { return { text: clean, action: null, rejected: 'ACTION was not valid JSON' }; }
  if (!obj || !ACTIONS.includes(obj.tool)) return { text: clean, action: null, rejected: `unknown action "${obj?.tool}"` };
  const input = {};
  if (obj.tool === 'update_suggestion') {
    const given = obj.input && typeof obj.input === 'object' ? obj.input : {};
    for (const field of allowedFields) {
      if (given[field] === undefined) continue;
      const v = given[field];
      if (field === 'proposedCpcMicros' && !(Number.isInteger(v) && v > 0)) return { text: clean, action: null, rejected: 'proposedCpcMicros must be a positive integer' };
      if (field === 'matchType' && !MATCH_TYPES.includes(v)) return { text: clean, action: null, rejected: `matchType must be one of ${MATCH_TYPES.join(', ')}` };
      if ((field === 'keyword' || field === 'suggestedCopy') && (typeof v !== 'string' || !v.trim())) return { text: clean, action: null, rejected: `${field} must be non-empty text` };
      input[field] = v;
    }
  }
  return { text: clean, action: { tool: obj.tool, input }, rejected: null };
}
