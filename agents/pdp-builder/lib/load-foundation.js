// agents/pdp-builder/lib/load-foundation.js
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(__dirname, '..', '..', '..');

/**
 * Loads the foundation content from disk.
 *
 * Returns:
 *   {
 *     voice:                string  // raw markdown of data/brand/voice-and-pov.md
 *     clusterPOVs:          string  // raw markdown of data/brand/cluster-povs.md
 *     ingredientStories:    object  // parsed JSON of data/brand/ingredient-stories.json
 *     comparisonFramework:  string  // raw markdown of data/brand/comparison-framework.md
 *     founderNarrative:     string  // raw markdown of data/brand/founder-narrative.md
 *     ingredientsByCluster: object  // parsed JSON of config/ingredients.json (existing source-of-truth)
 *   }
 *
 * Throws (loud failure) if any required file is missing or malformed.
 * The caller never publishes without the foundation in hand — falling back
 * to defaults would let mass-market copy slip through.
 */
export function loadFoundation({ root = DEFAULT_ROOT } = {}) {
  const required = [
    { path: join(root, 'data', 'brand', 'voice-and-pov.md'),         key: 'voice',               type: 'text' },
    { path: join(root, 'data', 'brand', 'cluster-povs.md'),          key: 'clusterPOVs',         type: 'text' },
    { path: join(root, 'data', 'brand', 'ingredient-stories.json'),  key: 'ingredientStories',   type: 'json' },
    { path: join(root, 'data', 'brand', 'comparison-framework.md'),  key: 'comparisonFramework', type: 'text' },
    { path: join(root, 'data', 'brand', 'founder-narrative.md'),     key: 'founderNarrative',    type: 'text' },
    { path: join(root, 'config', 'ingredients.json'),                key: 'ingredientsByCluster', type: 'json' },
  ];

  const out = {};
  for (const file of required) {
    if (!existsSync(file.path)) {
      throw new Error(`Foundation missing: ${file.path}`);
    }
    let raw;
    try {
      raw = readFileSync(file.path, 'utf8');
    } catch (e) {
      throw new Error(`Foundation unreadable (${file.path}): ${e.message}`);
    }
    if (file.type === 'json') {
      try {
        out[file.key] = JSON.parse(raw);
      } catch (e) {
        throw new Error(`Foundation malformed (${file.path}): ${e.message}`);
      }
    } else {
      out[file.key] = raw;
    }
  }
  return out;
}
