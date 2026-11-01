// agents/ad-concepts/shots.js
//
// The take loop (render, verify, write each take as it is checked) and the unit-count block
// plates.js puts in every product scene prompt.

export function unitBlock(unitCount) {
  const n = Number(unitCount);
  return `EXACTLY ${n} UNIT${n === 1 ? '' : 'S'} OF OUR PRODUCT. Any other object the scene describes is a different object and must not resemble our product in shape, colour or label.`;
}

// onTake runs as soon as a take is verified, so a throw on a LATER take (or later in the
// concept) cannot lose a render that was already paid for and checked.
export async function runConceptTakes({ concept, prompt, render, verify, budget, takes = 3, retryTakes = 2, onTake = null, fallbackPrompt = null, primaryTakes = 2, fallbackTakes = 2 }) {
  const all = [];
  let budgetStopped = false;
  const review = concept.people !== 'none' ? ['anatomy'] : [];

  const shoot = async (count, p) => {
    for (let i = 0; i < count; i++) {
      if (!budget.take()) { budgetStopped = true; return; }
      const buffer = await render(p);
      const { mediaType, proof } = await verify(buffer);
      const take = { n: all.length + 1, buffer, mediaType, proof, needsHumanReview: review };
      all.push(take);
      if (onTake) await onTake(take);
    }
  };

  if (fallbackPrompt) {
    // Structure pipeline: primary scene, then the fallback scene; no repair round.
    await shoot(primaryTakes, prompt);
    if (!budgetStopped && !all.some(t => t.proof.ok)) await shoot(fallbackTakes, fallbackPrompt);
    return { takes: all, passed: all.filter(t => t.proof.ok), budgetStopped, repaired: false, usedFallback: all.length > primaryTakes };
  }

  await shoot(takes, prompt);
  let repaired = false;
  if (!budgetStopped && !all.some(t => t.proof.ok)) {
    repaired = true;
    const reasons = [...new Set(all.flatMap(t => t.proof.reasons || []))].slice(0, 12);
    await shoot(retryTakes, `${prompt}\n\nPREVIOUS TAKES FAILED these checks. Fix them:\n${reasons.map(r => `- ${r}`).join('\n')}`);
  }
  return { takes: all, passed: all.filter(t => t.proof.ok), budgetStopped, repaired };
}
