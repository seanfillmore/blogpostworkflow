/**
 * RSC vs Culina classifier for Amazon ASINs.
 *
 * Per CLAUDE.md: an ASIN's product title containing "culina" or
 * "cast iron" classifies it as Culina. Everything else is RSC.
 *
 * Used to filter Culina ASINs out of the keyword-index ingest at the
 * request layer — only RSC ASINs are queried for SQP and only RSC
 * search terms are kept from BA.
 */

const CULINA_PATTERNS = [/culina/i, /cast\s+iron/i];

export function classifyAsin(product) {
  const title = product?.title || '';
  if (CULINA_PATTERNS.some((re) => re.test(title))) return 'culina';
  return 'rsc';
}

export function isRsc(product) {
  return classifyAsin(product) === 'rsc';
}
