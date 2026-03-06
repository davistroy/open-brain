import { createHash } from 'node:crypto'

/**
 * Normalize text for deduplication: trim, collapse whitespace, lowercase.
 * Then SHA-256 hex hash the result.
 */
export function contentHash(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}
