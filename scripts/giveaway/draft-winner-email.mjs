#!/usr/bin/env node
/**
 * Draft the winner notification. DOES NOT SEND.
 *
 * §8 requires notification within 48 hours of the drawing and gives the winner 7
 * days to respond. Nothing auto-sends a $536.40 prize notification: a human
 * reads this and sends it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RESULT = join(ROOT, 'data', 'giveaway', 'draw-result.json');
const OUT = join(ROOT, 'data', 'giveaway', 'winner-email-draft.md');

if (!existsSync(RESULT)) {
  console.error('Refusing: data/giveaway/draw-result.json does not exist. Run draw.mjs --apply first.');
  process.exit(1);
}

const result = JSON.parse(readFileSync(RESULT, 'utf8'));
const deadline = new Date(Date.parse(result.drawnAt) + 7 * 864e5).toISOString().slice(0, 10);

const draft = `# Winner notification — DRAFT, NOT SENT

Drawn: ${result.drawnAt}
Seed: ${result.seed}
Snapshot: ${result.snapshotBlob}
Winner: **${result.winner}**
Referral prize: ${result.referralPrize.awarded ? `**${result.referralPrize.email}**` : 'NOT AWARDED'} — ${result.referralPrize.reason}

Respond-by (§8, 7 days): **${deadline}**
If no response by then, the next name in the committed ordering is the alternate.
No new draw is needed — the ordering was fixed by the seed:
${result.ordering.slice(1, 4).map((e, i) => `  alternate ${i + 1}: ${e}`).join('\n')}

---

## To: ${result.winner}
## Subject: You won the Real Skin Care soap giveaway

Hi,

You've been drawn as the winner of our Pure Unscented soap giveaway.

Your prize is 36 bars of Pure Unscented Moisturizing Coconut Soap, shipped over
three years in three shipments a year of four bars each, plus three Sensitive
Skin Moisturizing Sets, one a year alongside that year's first soap shipment.

To claim it, just reply to this email by **${deadline}**. If we don't hear from
you by then we'll need to draw an alternate, which we'd rather not do.

The drawing was conducted from a frozen list of all entries, shuffled using the
Dow Jones closing value on September 15, 2026 — the method we published on the
giveaway page before entries closed.

Congratulations,
Real Skin Care
`;

writeFileSync(OUT, draft);
console.log(`Wrote ${OUT}`);
console.log('READ IT, then send by hand. Nothing here sends email.');
