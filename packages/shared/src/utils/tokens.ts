/**
 * Estimate token count from a string.
 * Uses chars/4 with a 10% safety margin (no tokenizer dependency).
 * Accurate within ~20% of tiktoken for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil((text.length / 4) * 1.1)
}
