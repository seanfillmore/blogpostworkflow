// Pure text helpers for the recipe-link import on the competitor page: they turn the
// server's recipe object into the Dish name, Ingredients and Recipe field values.
// No DOM here, so tests/dashboard/contest-recipe-text.test.js can import it in Node.

export const CAP_INGREDIENTS = 2000;
export const CAP_RECIPE = 8000;
export const CAP_NAME = 80;

/** A dish name from a recipe title: "Smoked Turkey Recipe" → "Smoked Turkey". Never empties it. */
export function dishNameFrom(title) {
  const t = typeof title === 'string' ? title.trim() : '';
  const stripped = t.replace(/\s+recipe$/i, '').trim();
  return (stripped || t).slice(0, CAP_NAME);
}

/** Join lines into at most `max` characters, cutting only between lines. */
export function fitLines(lines, max) {
  let text = '';
  let cut = false;
  for (const line of lines) {
    const next = text ? `${text}\n${line}` : line;
    if (next.length > max) {
      cut = true;
      if (!text) text = line.slice(0, max); // one giant line: hard cut
      break;
    }
    text = next;
  }
  return { text, cut };
}

export function servesLine(y) {
  if (!y) return null;
  if (/^\d+$/.test(y)) return `Serves ${y}`;
  const m = y.match(/^(\d+(?:\s*(?:to|-|–)\s*\d+)?)\s+(?:servings?|people|persons?|portions?)$/i);
  return m ? `Serves ${m[1]}` : `Makes ${y}`;
}

export function timeLine(minutes) {
  if (!minutes || minutes < 1) return null;
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  if (!h) return `About ${r} min`;
  return r ? `About ${hours} ${r} min` : `About ${hours}`;
}

/** "Serves N · About X" line, numbered steps with section headings kept, then the source. */
export function buildRecipeText(recipe, sourceUrl) {
  const head = [servesLine(recipe.recipeYield), timeLine(recipe.totalMinutes)].filter(Boolean).join(' · ');
  const headingSet = new Set(recipe.headings || []);
  const stepLines = [];
  let n = 0;
  (recipe.steps || []).forEach((step, i) => {
    if (headingSet.has(i)) {
      if (stepLines.length) stepLines.push('');
      stepLines.push(step);
    } else {
      n += 1;
      stepLines.push(`${n}. ${step}`);
    }
  });
  const source = `Source: ${sourceUrl}`;
  const prefix = head ? [head, ''] : [];
  const room = CAP_RECIPE - source.length - 2; // "\n\n" before the source line
  const body = fitLines([...prefix, ...stepLines], room);
  return { text: `${body.text}\n\n${source}`, cut: body.cut, steps: n };
}
