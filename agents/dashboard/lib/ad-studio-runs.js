// agents/dashboard/lib/ad-studio-runs.js
//
// Read layer for the Ad Studio judging screen.
//
// The agent already writes everything this needs — `run.json` per run, `copy.json` per
// concept, `proof.json` per variation, and the images beside them. Nothing here computes a
// verdict or re-derives one; it assembles what is on disk into the shape the screen wants.
// A dashboard that disagreed with proof.json about whether a frame passed would be a
// second source of truth, and the wrong one.
//
// ── Why this is a lib and not inline in the route ───────────────────────────────────
//
// The interesting parts — pairing a plate with its comp, turning a proof into sentences,
// deciding what "kept" means — are pure and worth testing. Route handlers in this app are
// request plumbing; putting the logic there makes it reachable only over HTTP.

import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

/** A plate's filename and its comp's differ by one token. */
function compFor(plateName) {
  return plateName.replace('-plate-', '-comp-');
}

function readJsonOr(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

/**
 * Every run on disk, newest first, cheap enough to call on every page load.
 *
 * A directory with no readable `run.json` is a run that crashed before finalizeRunReport.
 * It is listed rather than hidden — its images exist and are often the ones worth looking
 * at, and silently dropping a failed run is how an operator concludes nothing happened.
 *
 * @param {string} rootDir data/creatives/ad-studio
 */
export function listRuns(rootDir) {
  if (!rootDir || !existsSync(rootDir)) return [];
  return readdirSync(rootDir)
    .filter(name => {
      try { return statSync(join(rootDir, name)).isDirectory(); } catch { return false; }
    })
    .filter(name => name !== 'format-refs')
    .map(runId => {
      const report = readJsonOr(join(rootDir, runId, 'run.json'), null);
      const artifacts = report?.totals?.artifacts || null;
      return {
        runId,
        generatedAt: report?.generatedAt || null,
        product: report?.product || null,
        // Null, not zero, when there is no report — "we do not know" and "none" are
        // different answers and a dash reads differently from a 0 on the screen.
        artifacts,
        cost: report?.cost || null,
        concepts: (report?.results || []).map(r => r.conceptSlug),
        rejectedConcepts: (report?.rejectedConcepts || []).map(c => c.conceptSlug),
        incomplete: !report,
      };
    })
    .sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

/**
 * Why a frame was rejected, as sentences.
 *
 * The agent's `reasons[]` are already written for a human — "product volume marking is
 * WRONG — the render shows ..." — so this does not translate them, it classifies them, so
 * the screen can style a gate rejection differently from an API failure. Those two call
 * for opposite responses and conflating them sends the operator hunting a quality problem
 * that is not there.
 *
 * @param {object} proofEntry one artifact's entry from proof.json
 */
export function classifyOutcome(proofEntry) {
  if (!proofEntry) return { state: 'missing', label: 'No proof recorded', reasons: [] };
  if (proofEntry.error) {
    return {
      state: 'errored',
      label: 'API error — not a quality judgement',
      reasons: [String(proofEntry.error)],
    };
  }
  if (proofEntry.ok) return { state: 'accepted', label: 'Accepted', reasons: [] };
  return {
    state: 'rejected',
    label: 'Rejected by the gate',
    reasons: Array.isArray(proofEntry.reasons) ? proofEntry.reasons : [],
  };
}

/**
 * The checks that ran on one frame, flattened for display.
 *
 * Everything is surfaced even when it passed — an operator overriding a rejection needs to
 * see what else was checked, and "the gate looked at the product and agreed" is
 * information. Absent checks are omitted rather than shown as failures.
 */
export function summariseChecks(proofEntry) {
  if (!proofEntry) return [];
  const out = [];
  const p = proofEntry;

  if (p.volume?.status) {
    out.push({
      check: 'Volume marking',
      ok: Boolean(p.volume.ok),
      detail: p.volume.status === 'illegible'
        ? 'Too small to read — allowed'
        : `${p.volume.status}${p.volume.read ? ` — read "${p.volume.read}"` : ''}`,
    });
  }
  if (p.fidelity?.status && p.fidelity.status !== 'no-reference') {
    out.push({
      check: 'Product fidelity',
      ok: Boolean(p.fidelity.ok),
      detail: (p.fidelity.mismatches || []).map(m => `${m.attribute}: ${m.detail}`).join('; ')
        || p.fidelity.status,
    });
  }
  if (p.inventory?.status && p.inventory.status !== 'not-applicable') {
    const strays = (p.inventory.strays || []).map(s => s.object);
    const unresolved = (p.inventory.unresolved || []).map(s => s.object);
    out.push({
      check: 'Scene inventory',
      ok: Boolean(p.inventory.ok),
      detail: [
        `${(p.inventory.units || []).length}/${p.inventory.expectedUnits} product unit(s)`,
        strays.length ? `objects in frame: ${strays.join(', ')}` : '',
        // Shown, but flagged as not counted — otherwise a human reads it as a defect the
        // gate ignored, when in fact the gate deliberately treats it as background.
        unresolved.length ? `not resolvable (not counted): ${unresolved.join(', ')}` : '',
      ].filter(Boolean).join(' · '),
    });
  }
  if (Array.isArray(p.defects) && p.defects.length) {
    out.push({
      check: 'Stray text',
      ok: false,
      detail: p.defects.map(d => `"${d.text}"${d.detail ? ` — ${d.detail}` : ''}`).join('; '),
    });
  }
  if (Array.isArray(p.missing) && p.missing.length) {
    out.push({ check: 'Expected text', ok: false, detail: `missing: ${p.missing.join(', ')}` });
  }
  return out;
}

/**
 * One run, assembled for the judging screen.
 *
 * Targets carry BOTH the plate and its comp. The plate is the compositing base and the
 * comp is the layout reference the operator rebuilds from — judging plates alone judges
 * the wrong artifact (Sean, 2026-08-16). `compTrusted: false` is not decoration: the comp
 * is a second generative pass and it drifts the product, so a verified 236ml plate has
 * produced a 230ml comp. The screen has to say which one is the base.
 *
 * @param {string} rootDir
 * @param {string} runId
 */
export function readRun(rootDir, runId) {
  const runDir = join(rootDir, runId);
  if (!existsSync(runDir)) return null;

  const report = readJsonOr(join(runDir, 'run.json'), null);
  const judgement = readJudgement(runDir);

  const conceptDirs = readdirSync(runDir).filter(name => {
    try { return statSync(join(runDir, name)).isDirectory(); } catch { return false; }
  });

  const concepts = conceptDirs.map(conceptSlug => {
    const conceptDir = join(runDir, conceptSlug);
    const copy = readJsonOr(join(conceptDir, 'copy.json'), null);

    const variations = readdirSync(conceptDir)
      .filter(n => /^v\d+$/.test(n))
      .sort()
      .map(vName => {
        const vDir = join(conceptDir, vName);
        const proof = readJsonOr(join(vDir, 'proof.json'), {});
        const files = readdirSync(vDir).filter(f => IMAGE_RE.test(f));
        const plates = files.filter(f => f.includes('-plate-')).sort();

        const targets = plates.map(plateName => {
          const comp = compFor(plateName);
          const entry = proof[plateName] || proof[basename(plateName, '.jpg') + '.png'] || null;
          const key = `${conceptSlug}/${vName}/${plateName}`;
          return {
            key,
            ratio: (plateName.match(/-(\d+x\d+|1_91x1)\./) || [])[1] || '',
            platform: plateName.split('-')[0],
            plate: plateName,
            comp: files.includes(comp) ? comp : null,
            compTrusted: false,
            attempts: entry?.attempts ?? null,
            outcome: classifyOutcome(entry),
            checks: summariseChecks(entry),
            decision: judgement.decisions[key] || null,
          };
        });

        return { name: vName, targets };
      });

    return {
      conceptSlug,
      copy: copy?.zones || null,
      claims: copy?.claims || [],
      variations,
    };
  });

  // A concept rejected by a gate never reached render, so it has no directory and would
  // otherwise vanish from the screen entirely — the operator would see a run that quietly
  // produced fewer concepts than asked for, with no reason anywhere.
  const gateRejected = (report?.rejectedConcepts || []).map(c => ({
    conceptSlug: c.conceptSlug,
    error: c.error || '',
    violations: c.violations || [],
  }));

  return {
    runId,
    generatedAt: report?.generatedAt || null,
    product: report?.product || null,
    totals: report?.totals || null,
    cost: report?.cost || null,
    budget: report?.budget || null,
    incomplete: !report,
    concepts,
    gateRejected,
    keptCount: Object.values(judgement.decisions).filter(d => d?.keep).length,
  };
}

/**
 * Operator decisions live in a SIDECAR, never in proof.json.
 *
 * The spec is explicit and the reason is that proof.json is the gate's record of what it
 * found. An override says "I am shipping this anyway", which is a different fact from "the
 * gate passed it", and writing one into the other destroys the only evidence of the
 * disagreement.
 */
export function readJudgement(runDir) {
  const path = join(runDir, 'judgement.json');
  const raw = readJsonOr(path, null);
  return {
    decisions: (raw && typeof raw.decisions === 'object' && raw.decisions) || {},
    updatedAt: raw?.updatedAt || null,
  };
}

/**
 * @param {string} runDir
 * @param {string} key  `${concept}/${variation}/${plateFilename}`
 * @param {{keep?:boolean, override?:boolean, note?:string}} decision
 * @param {string} [now] ISO timestamp; injected so tests are deterministic
 */
export function writeDecision(runDir, key, decision, now = new Date().toISOString()) {
  if (!existsSync(runDir)) throw new Error(`ad-studio: no such run directory: ${runDir}`);
  const current = readJudgement(runDir);
  const next = {
    decisions: {
      ...current.decisions,
      [key]: {
        keep: Boolean(decision?.keep),
        // Recorded separately from `keep`: keeping an ACCEPTED frame is routine, keeping a
        // REJECTED one is a deliberate disagreement with the gate and has to be visible as
        // one later. The route sets this, not the operator.
        override: Boolean(decision?.override),
        note: typeof decision?.note === 'string' ? decision.note.slice(0, 500) : '',
        decidedAt: now,
      },
    },
    updatedAt: now,
  };
  writeFileSync(join(runDir, 'judgement.json'), JSON.stringify(next, null, 2));
  return next;
}
