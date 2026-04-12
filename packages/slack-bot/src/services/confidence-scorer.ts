/**
 * Confidence scoring for auto-response candidates.
 * Produces a composite score (0.0-1.0) from 5 signals:
 *   search_score (0.30), entity_match (0.25), recency (0.20),
 *   corroboration (0.15), source_diversity (0.10).
 */

import { logger } from '@open-brain/shared'
import type { SearchResult } from '../lib/core-api-types.js'

export interface ConfidenceFactors {
  /** Normalized top search score (0-1) */
  searchScore: number
  /** Fraction of question entities found in retrieved captures (0-1) */
  entityMatch: number
  /** How many results are above a relevance threshold */
  relevantResultCount: number
  /** Average age of results in days (lower = more recent = better) */
  avgAgeDays: number
  /** Source diversity score (0-1) based on distinct source types in top results */
  sourceDiversity: number
  /** Final composite confidence */
  composite: number
}

/** Signal weights per PRD-UNIFIED Section 8.6 */
const WEIGHTS = {
  searchScore: 0.30,
  entityMatch: 0.25,
  recency: 0.20,
  corroboration: 0.15,
  sourceDiversity: 0.10,
} as const

/** Stop words excluded from entity matching in the query */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'about', 'up',
  'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'if', 'then', 'than',
  'that', 'this', 'these', 'those', 'it', 'its', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'what',
  'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'any', 'all',
  'each', 'every', 'no', 'some', 'more', 'most', 'other', 'just',
  'also', 'very', 'too', 'only', 'own', 'same', 'both', 'few', 'many',
  'much', 'such', 'there', 'here', 'know', 'anyone', 'someone', 'does',
])

/**
 * Extract significant terms from a query string (lowercased, stop-words removed).
 * These are matched against entity names from search results.
 */
export function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
}

/**
 * Compute entity match ratio: fraction of query terms that appear in
 * entity names from search result pre_extracted data.
 *
 * Returns 0 when there are no query terms or no entities in results.
 */
export function computeEntityMatchRatio(query: string, results: SearchResult[]): number {
  const queryTerms = extractQueryTerms(query)
  if (queryTerms.length === 0) return 0

  // Collect all unique entity names from results (lowercased)
  const entityNames = new Set<string>()
  for (const r of results) {
    if (r.pre_extracted?.entities) {
      for (const e of r.pre_extracted.entities) {
        entityNames.add(e.name.toLowerCase())
      }
    }
  }

  if (entityNames.size === 0) return 0

  // Count query terms that appear in any entity name (substring match)
  let matches = 0
  for (const term of queryTerms) {
    for (const name of entityNames) {
      if (name.includes(term) || term.includes(name)) {
        matches++
        break
      }
    }
  }

  return matches / queryTerms.length
}

/**
 * Compute source diversity score from distinct source types in top results.
 * 3+ distinct sources = 1.0, 2 = 0.7, 1 = 0.3, 0 = 0.0.
 */
export function computeSourceDiversity(results: SearchResult[]): number {
  if (results.length === 0) return 0

  const sources = new Set(results.slice(0, 10).map(r => r.source))
  const count = sources.size

  if (count >= 3) return 1.0
  if (count === 2) return 0.7
  return 0.3
}

/**
 * Compute a composite confidence score from search results and query text.
 *
 * Five signals (PRD-UNIFIED Section 8.6):
 *   0.30 search_score      — top search score (is the best match good?)
 *   0.25 entity_match      — fraction of query entities found in results
 *   0.20 recency           — recent captures more likely accurate
 *   0.15 corroboration     — more relevant results = more independent confirmation
 *   0.10 source_diversity  — multi-source answers are more trustworthy
 */
export function scoreConfidence(results: SearchResult[], query?: string): ConfidenceFactors {
  if (results.length === 0) {
    return {
      searchScore: 0,
      entityMatch: 0,
      relevantResultCount: 0,
      avgAgeDays: 999,
      sourceDiversity: 0,
      composite: 0,
    }
  }

  // Signal 1: Top search score (already 0-1 from the API)
  const topScore = Math.min(results[0].score, 1)

  // Signal 2: Entity match ratio (requires query text)
  const entityMatch = query ? computeEntityMatchRatio(query, results) : 0

  // Signal 3: Recency — average age in days, mapped to 0-1 (0 days = 1.0, 90+ days = 0.0)
  const now = Date.now()
  const ages = results.slice(0, 5).map(r => {
    const created = new Date(r.created_at).getTime()
    return (now - created) / (1000 * 60 * 60 * 24) // days
  })
  const avgAge = ages.reduce((a, b) => a + b, 0) / ages.length
  const recencyScore = Math.max(0, 1 - avgAge / 90)

  // Signal 4: Corroboration — count results with score > 0.3, cap at 5
  const relevant = results.filter(r => r.score > 0.3)
  const corroborationScore = Math.min(relevant.length / 5, 1)

  // Signal 5: Source diversity
  const sourceDiversityScore = computeSourceDiversity(results)

  const composite =
    WEIGHTS.searchScore * topScore +
    WEIGHTS.entityMatch * entityMatch +
    WEIGHTS.recency * recencyScore +
    WEIGHTS.corroboration * corroborationScore +
    WEIGHTS.sourceDiversity * sourceDiversityScore

  logger.debug(
    {
      topScore,
      entityMatch,
      recencyScore,
      corroborationScore,
      sourceDiversityScore,
      composite,
      resultCount: results.length,
    },
    '[confidence] score computed',
  )

  return {
    searchScore: topScore,
    entityMatch,
    relevantResultCount: relevant.length,
    avgAgeDays: Math.round(avgAge * 10) / 10,
    sourceDiversity: sourceDiversityScore,
    composite: Math.round(composite * 1000) / 1000,
  }
}
