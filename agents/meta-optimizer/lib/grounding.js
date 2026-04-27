/**
 * Build the optional grounding object passed to rewriteMeta. Returns null
 * when there is no index entry for the candidate keyword (preserves the
 * original prompt byte-for-byte). When present, surfaces the validation
 * tag, the Amazon conversion share (when available), and up to N
 * cluster-mate keywords for the rewriter to weave into the title/meta.
 */
export function buildPromptGrounding(indexEntry, clusterMates) {
  if (!indexEntry) return null;
  return {
    validationTag: indexEntry.validation_source ?? null,
    conversionShare: indexEntry.amazon?.conversion_share ?? null,
    clusterMateKeywords: (clusterMates || []).map((m) => m.keyword).filter(Boolean),
  };
}
