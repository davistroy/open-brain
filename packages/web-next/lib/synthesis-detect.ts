/**
 * Synthesis request detection — ported from packages/web/src/pages/Search.tsx.
 *
 * Determines whether a search query should trigger LLM synthesis
 * in addition to regular hybrid search. Mirrors the same patterns
 * used by the Slack bot's isSynthesisRequest() function.
 *
 * Patterns: 15 regex checks covering question words, summarization
 * requests, interrogative phrases, and trailing question marks.
 */

const SYNTHESIS_PATTERNS: RegExp[] = [
  /\bsummar(y|iz(e|ing))\b/i,
  /\bsynthesi(s|z(e|ing))\b/i,
  /\brecap\b/i,
  /\brundown\b/i,
  /\bbreakdown\b/i,
  /\boverview\b/i,
  /\bwhat('s| is| are) (the |my )?(patterns?|themes?|trends?)\b/i,
  /\bwhat (have|did|do) I\b/i,
  /\bwhat('s| is) my\b/i,
  /^(what|how|why|when|who|where|which)\b/i,
  /\?\s*$/,
  /\bgive me\b/i,
  /\btell me\b/i,
  /\bexplain\b/i,
  /\bdescribe\b/i,
];

/**
 * Returns true if the query looks like a synthesis/question request
 * rather than a keyword search. When true, the search page fires a
 * parallel POST /api/v1/synthesize call and renders the result above
 * the search results.
 */
export function isSynthesisRequest(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return SYNTHESIS_PATTERNS.some((p) => p.test(trimmed));
}
