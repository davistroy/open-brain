import { sql } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { findSimilarPairs } from '../lib/hnsw-similarity.js'

/**
 * ADR-0003 rollback hatch: set `SIMILARITY_SCAN_LEGACY=1` to fall back to the old
 * O(N²) cosine self-join for one weekend cycle while validating the k-NN rewrite.
 */
const LEGACY_SCAN = process.env.SIMILARITY_SCAN_LEGACY === '1'

// ============================================================
// Types
// ============================================================

/**
 * A cluster of semantically similar captures identified as consolidation candidates.
 * All captures in the cluster have pairwise cosine similarity > the configured threshold.
 */
export interface ConsolidationCluster {
  /** UUIDs of captures in this cluster */
  captureIds: string[]
  /** Average pairwise cosine similarity within the cluster */
  avgSimilarity: number
  /** Minimum pairwise cosine similarity within the cluster */
  minSimilarity: number
}

/**
 * Result of the consolidation candidate query.
 */
export interface ConsolidationQueryResult {
  /** Clusters meeting the minimum size threshold, ordered by size desc then avgSimilarity desc */
  clusters: ConsolidationCluster[]
  /** Total number of similar pairs found before clustering */
  totalPairsFound: number
  /** Total number of clusters before the top-N filter */
  totalClustersFound: number
  /** Duration of the query + clustering in milliseconds */
  durationMs: number
}

// ============================================================
// Constants
// ============================================================

/** Minimum cosine similarity for two captures to be considered near-duplicates */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.92

/** Minimum number of captures in a cluster to be considered for consolidation */
export const DEFAULT_MIN_CLUSTER_SIZE = 3

/** Maximum clusters to return (LLM budget constraint) */
export const DEFAULT_MAX_CLUSTERS = 5

/** Maximum capture pairs to fetch from the database (safety limit) */
const MAX_PAIRS = 5000

// ============================================================
// Union-Find (Disjoint Set) data structure
// ============================================================

class UnionFind {
  private parent: Map<string, string> = new Map()
  private rank: Map<string, number> = new Map()

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      this.rank.set(x, 0)
    }
    // Path compression
    let root = x
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!
    }
    // Compress path
    let current = x
    while (current !== root) {
      const next = this.parent.get(current)!
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(x: string, y: string): void {
    const rootX = this.find(x)
    const rootY = this.find(y)
    if (rootX === rootY) return

    const rankX = this.rank.get(rootX)!
    const rankY = this.rank.get(rootY)!

    if (rankX < rankY) {
      this.parent.set(rootX, rootY)
    } else if (rankX > rankY) {
      this.parent.set(rootY, rootX)
    } else {
      this.parent.set(rootY, rootX)
      this.rank.set(rootX, rankX + 1)
    }
  }

  /**
   * Returns all groups (connected components) as arrays of member IDs.
   */
  groups(): Map<string, string[]> {
    const result = new Map<string, string[]>()
    for (const key of this.parent.keys()) {
      const root = this.find(key)
      if (!result.has(root)) result.set(root, [])
      result.get(root)!.push(key)
    }
    return result
  }
}

// ============================================================
// Query functions
// ============================================================

/**
 * Row shape returned by the similarity pair query.
 */
export interface SimilarityPairRow {
  capture_id_a: string
  capture_id_b: string
  similarity: string // Postgres returns numeric as string
  [key: string]: unknown // Satisfies Record<string, unknown> constraint for db.execute
}

/**
 * Find all capture pairs with cosine similarity above the threshold.
 *
 * Uses `1 - (embedding <=> embedding)` for cosine similarity
 * (the `<=>` operator returns cosine distance).
 *
 * Only considers captures that are:
 * - pipeline_status = 'complete'
 * - Not soft-deleted (deleted_at IS NULL)
 * - Have a non-null embedding
 */
export async function querySimilarPairs(
  db: Database,
  similarityThreshold: number = DEFAULT_SIMILARITY_THRESHOLD,
  candidatesSince: Date | null = null,
): Promise<SimilarityPairRow[]> {
  if (LEGACY_SCAN) {
    return querySimilarPairsLegacy(db, similarityThreshold)
  }

  // PE-H1 / ADR-0003: per-row HNSW k-NN probe instead of the O(N²) self-join.
  // Consolidation does NOT exclude source='consolidation' (it may re-cluster prior
  // reflections) — preserved via excludeConsolidationSource:false. `findSimilarPairs`
  // already logs + returns [] on error, so no extra try/catch here.
  const pairs = await findSimilarPairs(db, {
    threshold: similarityThreshold,
    maxPairs: MAX_PAIRS,
    excludeConsolidationSource: false,
    candidatesSince,
  })

  return pairs.map((p) => ({
    capture_id_a: p.capture_id_a,
    capture_id_b: p.capture_id_b,
    similarity: String(p.similarity),
  }))
}

/**
 * Legacy O(N²) cosine self-join — retained behind `SIMILARITY_SCAN_LEGACY=1` as the
 * one-weekend rollback hatch for ADR-0003. Do not call directly; routed via {@link querySimilarPairs}.
 */
async function querySimilarPairsLegacy(
  db: Database,
  similarityThreshold: number,
): Promise<SimilarityPairRow[]> {
  try {
    const rows = await db.execute<SimilarityPairRow>(sql`
      SELECT
        a.id::text AS capture_id_a,
        b.id::text AS capture_id_b,
        (1 - (a.embedding <=> b.embedding))::text AS similarity
      FROM captures a
      JOIN captures b ON a.id < b.id
      WHERE a.pipeline_status = 'complete'
        AND b.pipeline_status = 'complete'
        AND a.deleted_at IS NULL
        AND b.deleted_at IS NULL
        AND a.embedding IS NOT NULL
        AND b.embedding IS NOT NULL
        AND (1 - (a.embedding <=> b.embedding)) > ${similarityThreshold}
      ORDER BY (1 - (a.embedding <=> b.embedding)) DESC
      LIMIT ${MAX_PAIRS}
    `)

    return rows.rows as SimilarityPairRow[]
  } catch (err) {
    logger.error({ err }, '[memory-consolidation] failed to query similar pairs (legacy)')
    return []
  }
}

// ============================================================
// Clustering
// ============================================================

/**
 * Build clusters from similar pairs using union-find, then filter and rank.
 *
 * The similarity map is used to compute per-cluster statistics
 * (average and minimum pairwise similarity).
 */
export function buildClusters(
  pairs: SimilarityPairRow[],
  minClusterSize: number = DEFAULT_MIN_CLUSTER_SIZE,
  maxClusters: number = DEFAULT_MAX_CLUSTERS,
): ConsolidationCluster[] {
  if (pairs.length === 0) return []

  const uf = new UnionFind()

  // Build a map of pair similarities for cluster statistics
  const pairSimilarities = new Map<string, number>()

  for (const pair of pairs) {
    uf.union(pair.capture_id_a, pair.capture_id_b)
    // Store similarity keyed by canonical pair (a < b guaranteed by SQL ORDER)
    const key = `${pair.capture_id_a}|${pair.capture_id_b}`
    pairSimilarities.set(key, parseFloat(pair.similarity))
  }

  // Extract groups and filter by minimum size
  const groups = uf.groups()
  const clusters: ConsolidationCluster[] = []

  for (const [, members] of groups) {
    if (members.length < minClusterSize) continue

    // Compute cluster-level similarity statistics from known pairs
    const clusterPairSims: number[] = []
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        // Ensure canonical ordering (smaller UUID first)
        const [a, b] = members[i] < members[j]
          ? [members[i], members[j]]
          : [members[j], members[i]]
        const key = `${a}|${b}`
        const sim = pairSimilarities.get(key)
        if (sim !== undefined) {
          clusterPairSims.push(sim)
        }
      }
    }

    const avgSimilarity = clusterPairSims.length > 0
      ? clusterPairSims.reduce((sum, s) => sum + s, 0) / clusterPairSims.length
      : 0
    const minSimilarity = clusterPairSims.length > 0
      ? Math.min(...clusterPairSims)
      : 0

    clusters.push({
      captureIds: members.sort(), // Deterministic ordering
      avgSimilarity,
      minSimilarity,
    })
  }

  // Sort: largest clusters first, then highest average similarity
  clusters.sort((a, b) => {
    if (b.captureIds.length !== a.captureIds.length) {
      return b.captureIds.length - a.captureIds.length
    }
    return b.avgSimilarity - a.avgSimilarity
  })

  return clusters.slice(0, maxClusters)
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Find candidate clusters for memory consolidation.
 *
 * 1. Query capture pairs with cosine similarity > threshold
 * 2. Build clusters using union-find
 * 3. Filter by minimum cluster size
 * 4. Return top N clusters
 */
export async function findConsolidationCandidates(
  db: Database,
  options: {
    similarityThreshold?: number
    minClusterSize?: number
    maxClusters?: number
    /** Incremental scoping: only captures created after this are candidates (null = full scan). */
    candidatesSince?: Date | null
  } = {},
): Promise<ConsolidationQueryResult> {
  const start = Date.now()
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
  const minSize = options.minClusterSize ?? DEFAULT_MIN_CLUSTER_SIZE
  const maxClusters = options.maxClusters ?? DEFAULT_MAX_CLUSTERS
  const candidatesSince = options.candidatesSince ?? null

  logger.info(
    { threshold, minSize, maxClusters, incremental: candidatesSince !== null },
    '[memory-consolidation] querying consolidation candidates',
  )

  // Step 1: Query similar pairs
  const pairs = await querySimilarPairs(db, threshold, candidatesSince)
  logger.info(
    { pairsFound: pairs.length },
    '[memory-consolidation] similar pairs found',
  )

  // Step 2-3: Build and filter clusters
  // Build all clusters (with minSize=1 temporarily) to get totalClustersFound
  const allClusters = buildClusters(pairs, 1, Number.MAX_SAFE_INTEGER)
  const totalClustersFound = allClusters.filter(c => c.captureIds.length >= minSize).length

  // Step 4: Build final clusters with proper filtering and limit
  const clusters = buildClusters(pairs, minSize, maxClusters)

  const durationMs = Date.now() - start
  logger.info(
    { clusters: clusters.length, totalClustersFound, durationMs },
    '[memory-consolidation] consolidation query complete',
  )

  return {
    clusters,
    totalPairsFound: pairs.length,
    totalClustersFound,
    durationMs,
  }
}
