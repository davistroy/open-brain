#!/usr/bin/env node
/**
 * scripts/benchmark-search.mjs
 *
 * Benchmark hybrid_search() latency and recall across ef_search values.
 * Connects directly to Postgres (not through the HTTP API) to measure
 * raw SQL function performance. Does NOT call the OpenAI embedding API --
 * uses a pre-computed query vector or a normalized random vector for
 * structural benchmarking.
 *
 * Usage:
 *   # Structural benchmark (random vector -- latency only, recall not meaningful):
 *   PGURL=postgres://openbrain:openbrain@localhost:5432/openbrain \
 *     node scripts/benchmark-search.mjs
 *
 *   # Recall benchmark (real query vector from file):
 *   PGURL=postgres://openbrain:openbrain@homeserver.k4jda.net:5432/openbrain \
 *   QUERY_VECTOR_FILE=./tmp/query-vector.json \
 *     node scripts/benchmark-search.mjs
 *
 * Output:
 *   - CSV to stdout: ef_search,iteration,latency_ms,result_overlap_vs_100
 *   - Summary table to stderr: best ef_search, p50/p95 latency, recall
 *
 * Memory ceiling: loads one 768-dim query vector (~6KB) + at most 40 result rows.
 * Well within the 1.5GB constraint.
 *
 * Benchmark does NOT modify any data -- all SQL calls are STABLE function reads.
 */

import pg from 'pg'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PGURL = process.env.PGURL ?? 'postgres://openbrain:openbrain@localhost:5432/openbrain'
const QUERY_VECTOR_FILE = process.env.QUERY_VECTOR_FILE ?? null
const EF_SEARCH_VALUES = [40, 60, 80, 100]
const ITERATIONS = 10
const MATCH_COUNT = 10
const WARMUP_ITERATIONS = 3

// ---------------------------------------------------------------------------
// Query vector loading
// ---------------------------------------------------------------------------

/**
 * Load query vector from file, or generate a normalized random vector.
 * Random vector is valid for latency benchmarking but recall results
 * are not meaningful (it won't match real captures' content).
 */
function loadQueryVector() {
  if (QUERY_VECTOR_FILE && existsSync(QUERY_VECTOR_FILE)) {
    const raw = JSON.parse(readFileSync(QUERY_VECTOR_FILE, 'utf8'))
    if (!Array.isArray(raw) || raw.length !== 768) {
      throw new Error(`QUERY_VECTOR_FILE must contain a JSON array of 768 floats, got ${Array.isArray(raw) ? raw.length : typeof raw}`)
    }
    process.stderr.write(`[benchmark] Using real query vector from ${QUERY_VECTOR_FILE}\n`)
    return raw
  }

  // Generate a normalized random unit vector for structural benchmarking
  process.stderr.write('[benchmark] No QUERY_VECTOR_FILE -- using normalized random vector (latency only; recall not meaningful)\n')
  const vec = Array.from({ length: 768 }, () => Math.random() * 2 - 1)
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0))
  return vec.map(v => v / magnitude)
}

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

/**
 * Run hybrid_search() once at the given ef_search value.
 * Returns { latencyMs, captureIds } -- captureIds used for recall comparison.
 */
async function runOnce(client, queryVectorStr, efSearch) {
  const start = performance.now()

  await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`)
  const result = await client.query(
    `SELECT capture_id::text
     FROM hybrid_search($1, $2::vector(768), $3, 1.0, 1.0,
       NULL::text[], NULL::text[], NULL::timestamptz, NULL::timestamptz)`,
    ['benchmark query', queryVectorStr, MATCH_COUNT],
  )

  const latencyMs = performance.now() - start
  const captureIds = result.rows.map(r => r.capture_id)
  return { latencyMs, captureIds }
}

/**
 * Compute recall: fraction of baseline results present in candidate results.
 * baseline = ef_search=100 results (used as ground truth).
 */
function computeRecall(baseline, candidate) {
  if (baseline.length === 0) return 1.0
  const baselineSet = new Set(baseline)
  const overlap = candidate.filter(id => baselineSet.has(id)).length
  return overlap / baseline.length
}

/**
 * Compute percentile from sorted array.
 */
function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { Pool } = pg

  process.stderr.write(`[benchmark] Connecting to ${PGURL.replace(/:[^:@]+@/, ':***@')}\n`)
  process.stderr.write(`[benchmark] ef_search values: ${EF_SEARCH_VALUES.join(', ')}\n`)
  process.stderr.write(`[benchmark] Iterations: ${ITERATIONS} (+ ${WARMUP_ITERATIONS} warmup)\n`)
  process.stderr.write(`[benchmark] match_count: ${MATCH_COUNT}\n\n`)

  const pool = new Pool({ connectionString: PGURL, max: 1 })
  const client = await pool.connect()

  // Verify the corpus is queryable
  const corpusResult = await client.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE embedding IS NOT NULL) AS embedded
    FROM captures
    WHERE deleted_at IS NULL
  `)
  const { total, embedded } = corpusResult.rows[0]
  process.stderr.write(`[benchmark] Corpus: ${embedded} embedded captures (${total} total, excluding soft-deleted)\n\n`)

  const queryVector = loadQueryVector()
  const queryVectorStr = `[${queryVector.join(',')}]`

  // Results storage: ef_search -> { latencies, recallVs100 }
  const results = {}
  for (const ef of EF_SEARCH_VALUES) {
    results[ef] = { latencies: [], recallVs100: [] }
  }

  // Warmup (discard results)
  process.stderr.write('[benchmark] Warming up...\n')
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    for (const ef of EF_SEARCH_VALUES) {
      await runOnce(client, queryVectorStr, ef)
    }
  }

  // Baseline: collect ef_search=100 results for recall computation
  process.stderr.write('[benchmark] Collecting baseline (ef_search=100)...\n')
  const baselineResults = []
  for (let i = 0; i < ITERATIONS; i++) {
    const { captureIds } = await runOnce(client, queryVectorStr, 100)
    baselineResults.push(captureIds)
  }
  // Use first result set as baseline (consistent random vector -> same results)
  const baseline = baselineResults[0]

  // Main benchmark
  process.stderr.write('[benchmark] Running benchmark...\n\n')
  process.stdout.write('ef_search,iteration,latency_ms,result_overlap_vs_100\n')

  for (const ef of EF_SEARCH_VALUES) {
    for (let i = 0; i < ITERATIONS; i++) {
      const { latencyMs, captureIds } = await runOnce(client, queryVectorStr, ef)
      const recall = computeRecall(baseline, captureIds)
      results[ef].latencies.push(latencyMs)
      results[ef].recallVs100.push(recall)
      process.stdout.write(`${ef},${i + 1},${latencyMs.toFixed(2)},${recall.toFixed(4)}\n`)
    }
  }

  client.release()
  await pool.end()

  // ---------------------------------------------------------------------------
  // Summary table (stderr)
  // ---------------------------------------------------------------------------
  process.stderr.write('\n--- BENCHMARK SUMMARY ---\n')
  process.stderr.write(`Corpus: ${embedded} embedded captures\n`)
  process.stderr.write(`Iterations per ef_search: ${ITERATIONS}\n`)
  process.stderr.write(`match_count: ${MATCH_COUNT}\n\n`)

  const headerFmt = 'ef_search | p50_ms  | p95_ms  | p99_ms  | avg_recall_vs_100'
  process.stderr.write(headerFmt + '\n')
  process.stderr.write('-'.repeat(headerFmt.length) + '\n')

  for (const ef of EF_SEARCH_VALUES) {
    const latencies = [...results[ef].latencies].sort((a, b) => a - b)
    const recalls = results[ef].recallVs100
    const p50 = percentile(latencies, 50).toFixed(1)
    const p95 = percentile(latencies, 95).toFixed(1)
    const p99 = percentile(latencies, 99).toFixed(1)
    const avgRecall = (recalls.reduce((s, v) => s + v, 0) / recalls.length).toFixed(4)
    process.stderr.write(`${String(ef).padStart(9)} | ${p50.padStart(7)} | ${p95.padStart(7)} | ${p99.padStart(7)} | ${avgRecall}\n`)
  }

  process.stderr.write('\n--- RECOMMENDATION ---\n')
  // Find ef_search with lowest p95 that achieves >=0.90 recall vs baseline
  let recommended = EF_SEARCH_VALUES[EF_SEARCH_VALUES.length - 1]
  for (const ef of EF_SEARCH_VALUES) {
    const latencies = [...results[ef].latencies].sort((a, b) => a - b)
    const recalls = results[ef].recallVs100
    const avgRecall = recalls.reduce((s, v) => s + v, 0) / recalls.length
    const p95 = percentile(latencies, 95)
    if (avgRecall >= 0.90) {
      recommended = ef
      process.stderr.write(`ef_search=${ef}: p95=${p95.toFixed(1)}ms, recall=${avgRecall.toFixed(4)} >=0.90 -- RECOMMENDED\n`)
      break
    }
  }
  process.stderr.write(`\nSet config/pipeline.yaml search.hnsw_ef_search: ${recommended}\n`)
  process.stderr.write('Log results to LAB_NOTEBOOK Entry 108 before merge.\n')
}

main().catch(err => {
  process.stderr.write(`[benchmark] ERROR: ${err.message}\n${err.stack}\n`)
  process.exit(1)
})
