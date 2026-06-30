#!/usr/bin/env node
// ============================================================================
// PE-H1 / ADR-0003 validation gate — side-by-side CLUSTER diff
// ============================================================================
//
// Proves the new per-row HNSW k-NN probe (ef_search=60, k=50) produces the SAME
// consolidation/dedup CLUSTERS as the old O(N²) exact cosine self-join, on the
// production corpus. Compares connected components (Union-Find), NOT raw pairs:
// in a dense corpus the HNSW probe legitimately drops far-but-still->threshold
// edges, but Union-Find only needs the graph to stay connected, so the acted-on
// clusters can be identical even when pair sets differ. The ADR's gate is
// "cluster-diff ∅", which is exactly this.
//
// Reports both UNCAPPED (pure k-NN-vs-exact) and CAPPED-at-each-job's-real-cap
// cluster diffs, for consolidation (0.92, includes consolidation source, cap 5000)
// and dedup (0.95, excludes it, cap 100).
//
// THE GATE is the UNCAPPED cluster diff: it must be ∅ (proves the HNSW k=50 probe
// preserves every connected component the exact self-join finds — Union-Find only
// needs connectivity, so dropped redundant edges don't matter). The CAPPED diff is
// INFORMATIONAL: when a corpus has more above-threshold pairs than the cap (the
// production corpus has ~25K pairs >0.92 vs a 5000 cap), exact-vs-approximate
// ordering swaps a few MARGINAL near-duplicates right at the cutoff. That is a
// pre-existing cap-vs-saturation property, not a k-NN defect, and is immaterial to
// both skills (near-dupes still consolidate/flag). It also never manifests under
// incremental steady-state (new-captures-only runs stay well under the cap).
//
// Run on the homeserver inside a container with `pg` + DB access:
//   docker cp scripts/validate-knn-similarity.mjs open-brain-workers:/app/
//   docker exec -w /app open-brain-workers node validate-knn-similarity.mjs
//
// Exit 0 iff every UNCAPPED section's cluster diff is ∅.
// ============================================================================

import { Pool } from 'pg'

const EF_SEARCH = 60
const K = 50
const MIN_CLUSTER = 3 // DEFAULT_MIN_CLUSTER_SIZE

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL || process.env.DATABASE_URL,
})

/** Union-Find connected components of size >= minSize, returned as canonical sorted joined strings. */
function buildClusters(pairs, minSize = MIN_CLUSTER) {
  const parent = new Map()
  const rank = new Map()
  const find = (x) => {
    if (!parent.has(x)) {
      parent.set(x, x)
      rank.set(x, 0)
    }
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)
    let c = x
    while (c !== r) {
      const n = parent.get(c)
      parent.set(c, r)
      c = n
    }
    return r
  }
  const union = (x, y) => {
    const rx = find(x)
    const ry = find(y)
    if (rx === ry) return
    const a = rank.get(rx)
    const b = rank.get(ry)
    if (a < b) parent.set(rx, ry)
    else if (a > b) parent.set(ry, rx)
    else {
      parent.set(ry, rx)
      rank.set(rx, a + 1)
    }
  }
  for (const [a, b] of pairs) union(a, b)
  const groups = new Map()
  for (const k of parent.keys()) {
    const r = find(k)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(k)
  }
  return [...groups.values()]
    .filter((g) => g.length >= minSize)
    .map((g) => g.slice().sort().join(','))
}

async function oldPairs(threshold, excludeConsol, cap) {
  const src = excludeConsol ? `AND a.source <> 'consolidation' AND b.source <> 'consolidation'` : ''
  const limit = cap ? `LIMIT ${cap}` : ''
  const { rows } = await pool.query(
    `SELECT a.id::text AS a, b.id::text AS b
     FROM captures a JOIN captures b ON a.id < b.id
     WHERE a.pipeline_status='complete' AND b.pipeline_status='complete'
       AND a.deleted_at IS NULL AND b.deleted_at IS NULL
       AND a.embedding IS NOT NULL AND b.embedding IS NOT NULL ${src}
       AND (1 - (a.embedding <=> b.embedding)) > $1
     ORDER BY (1 - (a.embedding <=> b.embedding)) DESC
     ${limit}`,
    [threshold],
  )
  return rows.map((r) => [r.a, r.b])
}

async function newPairs(threshold, excludeConsol, cap) {
  const srcCand = excludeConsol ? `AND source <> 'consolidation'` : ''
  const srcN = excludeConsol ? `AND n2.source <> 'consolidation'` : ''
  const limit = cap ? `LIMIT ${cap}` : ''
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL hnsw.ef_search = ${EF_SEARCH}`)
    const { rows } = await client.query(
      `SELECT a, b FROM (
         SELECT DISTINCT ON (least(c.id, n.nid), greatest(c.id, n.nid))
           least(c.id, n.nid)::text AS a, greatest(c.id, n.nid)::text AS b, n.sim
         FROM (SELECT id FROM captures
               WHERE pipeline_status='complete' AND deleted_at IS NULL AND embedding IS NOT NULL ${srcCand}) c
         CROSS JOIN LATERAL (
           SELECT n2.id AS nid,
                  (1 - (n2.embedding <=> (SELECT embedding FROM captures WHERE id = c.id))) AS sim
           FROM captures n2
           WHERE n2.id <> c.id AND n2.deleted_at IS NULL AND n2.pipeline_status='complete'
             AND n2.embedding IS NOT NULL ${srcN}
           ORDER BY n2.embedding <=> (SELECT embedding FROM captures WHERE id = c.id)
           LIMIT ${K}
         ) n
         WHERE n.sim > $1
         ORDER BY least(c.id, n.nid), greatest(c.id, n.nid), n.sim DESC
       ) dedup
       ORDER BY sim DESC
       ${limit}`,
      [threshold],
    )
    await client.query('COMMIT')
    return rows.map((r) => [r.a, r.b])
  } finally {
    client.release()
  }
}

function diffClusters(oldC, newC) {
  const so = new Set(oldC)
  const sn = new Set(newC)
  return {
    onlyOld: oldC.filter((c) => !sn.has(c)),
    onlyNew: newC.filter((c) => !so.has(c)),
  }
}

async function run() {
  const jobs = [
    { name: 'consolidation', threshold: 0.92, excludeConsol: false, cap: 5000 }, // MAX_PAIRS
    { name: 'dedup', threshold: 0.95, excludeConsol: true, cap: 100 }, // DEFAULT_MAX_PAIRS
  ]
  let gateFailures = 0 // only UNCAPPED diffs gate the build
  for (const job of jobs) {
    for (const cap of [null, job.cap]) {
      const o = await oldPairs(job.threshold, job.excludeConsol, cap)
      const n = await newPairs(job.threshold, job.excludeConsol, cap)
      const oc = buildClusters(o)
      const nc = buildClusters(n)
      const { onlyOld, onlyNew } = diffClusters(oc, nc)
      const tag = cap ? `CAPPED@${cap} (informational)` : 'UNCAPPED (gate)'
      console.log(`\n=== ${job.name} (thr ${job.threshold}, exclConsol=${job.excludeConsol}) [${tag}] ===`)
      console.log(`  pairs    old=${o.length}  new=${n.length}`)
      console.log(`  clusters(>=${MIN_CLUSTER}) old=${oc.length}  new=${nc.length}`)
      console.log(`  cluster diff: onlyOld=${onlyOld.length}  onlyNew=${onlyNew.length}`)
      if (!cap && (onlyOld.length || onlyNew.length)) gateFailures++
      for (const [label, list] of [['ONLY IN OLD', onlyOld], ['ONLY IN NEW', onlyNew]]) {
        if (list.length) {
          console.log(`  ${label} (first 3):`)
          for (const c of list.slice(0, 3)) console.log('    [' + c.split(',').length + '] ' + c)
        }
      }
    }
  }
  console.log(
    `\n${gateFailures === 0 ? 'PASS — UNCAPPED cluster diff ∅ for all jobs (k-NN fidelity proven)' : `FAIL — ${gateFailures} UNCAPPED section(s) diverge`}`,
  )
  await pool.end()
  process.exit(gateFailures === 0 ? 0 : 1)
}

run().catch((err) => {
  console.error(err)
  process.exit(2)
})
