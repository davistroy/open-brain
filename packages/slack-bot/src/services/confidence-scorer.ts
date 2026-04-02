/**
 * Confidence scoring for auto-response candidates.
 * Produces a composite score (0.0-1.0) from search quality metrics.
 */

import { logger } from '@open-brain/shared'
import type { SearchResult } from '../lib/core-api-types.js'

export interface ConfidenceFactors {
  /** Normalized top search score (0-1) */
  searchScore: number
  /** How many results are above a relevance threshold */
  relevantResultCount: number
  /** Average age of results in days (lower = more recent = better) */
  avgAgeDays: number
  /** Final composite confidence */
  composite: number
}

/**
 * Compute a composite confidence score from search results.
 *
 * Weights:
 * - 0.5: Top search score (most important -- is the best match good?)
 * - 0.3: Result coverage (more relevant results = more corroboration)
 * - 0.2: Recency (recent captures are more likely to be accurate)
 */
export function scoreConfidence(results: SearchResult[]): ConfidenceFactors {
  if (results.length === 0) {
    return { searchScore: 0, relevantResultCount: 0, avgAgeDays: 999, composite: 0 }
  }

  // Top search score (already 0-1 from the API)
  const topScore = Math.min(results[0].score, 1)

  // Count results with score > 0.3 (relevance threshold)
  const relevant = results.filter(r => r.score > 0.3)
  const coverageScore = Math.min(relevant.length / 5, 1) // cap at 5 results

  // Recency: average age in days, mapped to 0-1 (0 days = 1.0, 90+ days = 0.0)
  const now = Date.now()
  const ages = results.slice(0, 5).map(r => {
    const created = new Date(r.created_at).getTime()
    return (now - created) / (1000 * 60 * 60 * 24) // days
  })
  const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length
  const recencyScore = Math.max(0, 1 - avgAge / 90)

  const composite = 0.5 * topScore + 0.3 * coverageScore + 0.2 * recencyScore

  logger.debug(
    { topScore, coverageScore, recencyScore, composite, resultCount: results.length },
    '[confidence] score computed',
  )

  return {
    searchScore: topScore,
    relevantResultCount: relevant.length,
    avgAgeDays: Math.round(avgAge * 10) / 10,
    composite: Math.round(composite * 1000) / 1000,
  }
}
