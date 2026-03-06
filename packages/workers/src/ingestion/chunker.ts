import { estimateTokens } from '@open-brain/shared'

/**
 * Maximum tokens per chunk (per task specification).
 * Embedding model accepts up to ~8192 tokens; we target 8K to stay under the limit.
 */
export const MAX_CHUNK_TOKENS = 8_000

/**
 * Overlap between consecutive chunks in tokens.
 * Ensures context continuity across chunk boundaries.
 */
export const CHUNK_OVERLAP_TOKENS = 512

export interface DocumentChunk {
  /** Zero-indexed chunk position within the document */
  index: number
  /** Total number of chunks for this document */
  total: number
  /** The text content of this chunk */
  text: string
  /** Estimated token count for this chunk */
  estimatedTokens: number
  /** Character offset where this chunk starts in the original text */
  charStart: number
  /** Character offset where this chunk ends (exclusive) in the original text */
  charEnd: number
}

/**
 * Split document text into overlapping chunks that fit within the embedding
 * model's token limit.
 *
 * Algorithm:
 * 1. If the entire document fits within MAX_CHUNK_TOKENS, return a single chunk.
 * 2. Otherwise split on paragraph boundaries (double newline) to preserve
 *    semantic coherence. Fall back to sentence boundaries (period+space) if
 *    paragraphs are too large.
 * 3. Accumulate paragraphs into chunks until the token budget is reached.
 * 4. For the next chunk, backtrack CHUNK_OVERLAP_TOKENS from the current
 *    position to create overlap — preserving context across boundaries.
 *
 * Token estimation uses the shared estimateTokens() utility (chars/4 × 1.1),
 * which is accurate within ~20% for English text and has no tokenizer dependency.
 *
 * @param text   Full document text
 * @returns      Array of DocumentChunk — always at least one element
 */
export function chunkDocument(text: string): DocumentChunk[] {
  const totalTokens = estimateTokens(text)

  // Fast path: document fits in a single chunk
  if (totalTokens <= MAX_CHUNK_TOKENS) {
    return [
      {
        index: 0,
        total: 1,
        text,
        estimatedTokens: totalTokens,
        charStart: 0,
        charEnd: text.length,
      },
    ]
  }

  // ── Split into semantic units (paragraphs first, then sentences) ──────────
  const units = splitIntoUnits(text)

  // ── Build chunks by accumulating units within the token budget ───────────
  const chunks: Omit<DocumentChunk, 'total'>[] = []

  let unitIndex = 0

  while (unitIndex < units.length) {
    const chunkUnits: typeof units = []
    let chunkTokens = 0
    let i = unitIndex

    // Accumulate units until we hit the token limit
    while (i < units.length) {
      const unitTokens = estimateTokens(units[i].text)

      // A single unit exceeds the limit — include it alone and move on
      if (chunkTokens === 0 && unitTokens > MAX_CHUNK_TOKENS) {
        chunkUnits.push(units[i])
        chunkTokens += unitTokens
        i++
        break
      }

      if (chunkTokens + unitTokens > MAX_CHUNK_TOKENS) {
        break
      }

      chunkUnits.push(units[i])
      chunkTokens += unitTokens
      i++
    }

    if (chunkUnits.length === 0) {
      // Should not happen, but guard against infinite loop
      unitIndex = i + 1
      continue
    }

    const chunkText = chunkUnits.map(u => u.text).join('')
    const charStart = chunkUnits[0].charStart
    const charEnd = chunkUnits[chunkUnits.length - 1].charEnd

    chunks.push({
      index: chunks.length,
      text: chunkText,
      estimatedTokens: chunkTokens,
      charStart,
      charEnd,
    })

    // ── Calculate overlap: backtrack from current position ─────────────────
    // Find how many units to backtrack to get ~CHUNK_OVERLAP_TOKENS worth of text.
    // This sets the start of the next chunk such that it overlaps with the tail
    // of the current chunk.
    let overlapTokens = 0
    let overlapUnitCount = 0

    for (let j = chunkUnits.length - 1; j >= 0; j--) {
      const t = estimateTokens(chunkUnits[j].text)
      overlapTokens += t
      overlapUnitCount++
      if (overlapTokens >= CHUNK_OVERLAP_TOKENS) break
    }

    // Next chunk starts at: (current chunk end units) - (overlap units)
    // i.e., we back up overlapUnitCount units from where the current chunk ended.
    const nextUnitIndex = i - overlapUnitCount

    // Guard against infinite loop (if we're not advancing)
    if (nextUnitIndex <= unitIndex) {
      unitIndex = i // skip forward to avoid infinite loop
    } else {
      unitIndex = nextUnitIndex
    }
  }

  // Inject totals
  const total = chunks.length
  return chunks.map(chunk => ({ ...chunk, total }))
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface TextUnit {
  text: string
  charStart: number
  charEnd: number
}

/**
 * Split text into semantic units for chunking.
 * Tries paragraph splits first; if any paragraph exceeds MAX_CHUNK_TOKENS,
 * falls back to sentence-level splits within that paragraph.
 */
function splitIntoUnits(text: string): TextUnit[] {
  const paragraphUnits = splitOnPattern(text, /\n\n+/)

  const result: TextUnit[] = []

  for (const para of paragraphUnits) {
    if (estimateTokens(para.text) > MAX_CHUNK_TOKENS) {
      // Paragraph is too large — split on sentence boundaries
      const sentences = splitOnPattern(para.text, /(?<=[.!?])\s+/, para.charStart)
      result.push(...sentences)
    } else {
      result.push(para)
    }
  }

  return result.length > 0 ? result : [{ text, charStart: 0, charEnd: text.length }]
}

/**
 * Split text on a regex delimiter pattern, preserving the delimiter as a suffix
 * of each segment (so joined units reconstruct the original text).
 *
 * @param text        Text to split
 * @param delimiter   Regex to split on (split points, not captured)
 * @param charOffset  Character offset of `text` in the parent document
 */
function splitOnPattern(
  text: string,
  delimiter: RegExp,
  charOffset = 0,
): TextUnit[] {
  if (!text) return []

  // Use split with a capture group to keep delimiters
  // We match the delimiter and include it as a trailing part of each segment
  const units: TextUnit[] = []
  let pos = 0

  const delim = new RegExp(delimiter.source, delimiter.flags + (delimiter.flags.includes('g') ? '' : 'g'))

  let match: RegExpExecArray | null

  while ((match = delim.exec(text)) !== null) {
    const segEnd = match.index + match[0].length
    const segText = text.slice(pos, segEnd)
    if (segText.trim()) {
      units.push({
        text: segText,
        charStart: charOffset + pos,
        charEnd: charOffset + segEnd,
      })
    }
    pos = segEnd
  }

  // Remaining text after last delimiter
  if (pos < text.length) {
    const remaining = text.slice(pos)
    if (remaining.trim()) {
      units.push({
        text: remaining,
        charStart: charOffset + pos,
        charEnd: charOffset + text.length,
      })
    }
  }

  // If no splits found, return the entire text as one unit
  if (units.length === 0) {
    return [{ text, charStart: charOffset, charEnd: charOffset + text.length }]
  }

  return units
}
