/**
 * Founder notes: pure selection, prompt block and usage detection.
 * No I/O. Notes are Sean's emailed answers to weekly questions.
 */

export const MAX_USES = 2;
export const DEFAULT_NOTE_LIMIT = 3;

export function selectFounderNotes(notes, { clusters = [], ref = null, surface, limit = DEFAULT_NOTE_LIMIT } = {}) {
  if (surface !== 'editorial' && surface !== 'commercial') {
    throw new Error(`selectFounderNotes: surface must be 'editorial' or 'commercial', got ${JSON.stringify(surface)}`);
  }
  const wanted = new Set(clusters);
  const groups = [[], [], []];
  for (const n of notes || []) {
    if (n.redaction !== 'ok') continue;
    if (n.gate?.[surface] !== 'ok') continue;
    if ((n.uses || []).length >= MAX_USES) continue;
    const nc = n.clusters || [];
    if (ref != null && n.source?.ref === ref) groups[0].push(n);
    else if (nc.some((c) => wanted.has(c))) groups[1].push(n);
    else if (n.source?.type === 'general' && nc.length === 0) groups[2].push(n);
  }
  const t = (n) => Date.parse(n.answered_at) || 0;
  return groups.flatMap((g) => g.sort((a, b) => t(b) - t(a))).slice(0, limit);
}

export function founderNotesBlock(notes, { surface } = {}) {
  if (!notes || notes.length === 0) return '';
  const lines = ["FOUNDER NOTES (Sean's own words, gathered by email)"];
  notes.forEach((n, i) => {
    lines.push(`${i + 1}. Question: ${n.question}`);
    lines.push(`   Answer: ${n.answer}`);
  });
  lines.push('');
  lines.push('Rules for using these notes:');
  lines.push('- Use a note only where it genuinely fits.');
  lines.push('- You may paraphrase or quote.');
  lines.push('- Never name a customer or any private person.');
  lines.push('- Never turn an anecdote into a claim that a product treats, heals, cures or prevents anything.');
  lines.push('- Never add detail the note does not contain.');
  if (surface === 'editorial') {
    lines.push('- When attribution helps the reader, attribute it to Sean, Co-Founder of Real Skin Care; otherwise weave it in without a name.');
  } else if (surface === 'commercial') {
    lines.push('- Write it in first person: Sean is the sender. Use any number only exactly as written.');
  }
  return lines.join('\n');
}

const STOPWORDS = new Set((
  'about above after again also always among because been before being below between both could does doing down during each ' +
  'even ever every from further have having here hers herself himself into itself just like make many more most much must ' +
  'myself never only other ours ourselves over same should since some such than that their theirs them themselves then there ' +
  'these they this those through under until upon very want wants was were what when where whether which while whom whose ' +
  'will with within without would your yours yourself yourselves really quite still thing things'
).split(/\s+/));

function contentWords(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function bigrams(words) {
  const out = [];
  for (let i = 0; i < words.length - 1; i++) out.push(`${words[i]} ${words[i + 1]}`);
  return out;
}

export function notesUsedIn(text, notes) {
  const textWords = contentWords(text);
  const textBigrams = new Set(bigrams(textWords));
  const textJoined = ` ${textWords.join(' ')} `;
  const used = [];
  for (const n of notes || []) {
    const words = contentWords(n.answer);
    if (words.length === 0) continue;
    const nb = new Set(bigrams(words));
    if (nb.size === 0) {
      if (textJoined.includes(` ${words.join(' ')} `)) used.push(n.id);
      continue;
    }
    const need = Math.min(words.length < 8 ? 2 : 3, nb.size);
    let hits = 0;
    for (const b of nb) if (textBigrams.has(b)) hits++;
    if (hits >= need) used.push(n.id);
  }
  return used;
}
