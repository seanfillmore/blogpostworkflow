// lib/positional-arg.js
//
// Find the positional argument in an argv list, skipping the VALUES of
// value-taking flags.
//
// `args.find((a) => !a.startsWith('--'))` looks correct and is not: given
// `['--limit', '10']` it returns `'10'`, because a flag's value does not start
// with `--`. agents/blog-post-verifier read that as a slug and died with
// "No article found matching slug: 10" on every scheduled run — 35 times,
// daily from 2026-04-12, while its own header documented `--limit 10` as valid
// usage. The scheduler logged "Command failed" and the pipeline carried on.

/**
 * @param {string[]} args              argv tail (process.argv.slice(2))
 * @param {string[]} flagsTakingValue  flags whose NEXT token is a value, not a positional
 * @returns {string|undefined} the first true positional, or undefined
 */
export function positionalArg(args, flagsTakingValue = []) {
  const takesValue = new Set(flagsTakingValue);
  const list = Array.isArray(args) ? args : [];
  for (let i = 0; i < list.length; i++) {
    const tok = list[i];
    if (typeof tok !== 'string') continue;
    if (tok.startsWith('--')) {
      // `--flag=value` carries its value inline, so it consumes no extra token.
      if (takesValue.has(tok) && !tok.includes('=')) i++;
      continue;
    }
    return tok;
  }
  return undefined;
}
