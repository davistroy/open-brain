/**
 * Deterministic, content-derived pseudo-embedding for integration tests.
 *
 * WHY THIS EXISTS
 * ----------------
 * The real embedder (OpenAI `text-embedding-3-large`, truncated to `vector(768)`
 * per CLAUDE.md) costs money and needs network access + `OPENAI_API_KEY` — neither
 * is available in CI/local integration runs, and QA-5 explicitly forbids calling it
 * from tests. The integration stub previously returned an all-zero 768-d vector for
 * every capture AND every query (`setup.ts` used to do `new Array(768).fill(0)`).
 * Cosine distance against a zero vector is undefined (pgvector returns NaN — verified
 * empirically against pgvector 0.8.2: `'[0,0,0]'::vector <=> '[0,0,0]'::vector` = NaN,
 * and NaN also for a non-zero vector against a zero vector). That made every row tie,
 * so the vector/HNSW/RRF half of hybrid search (`hybrid_search()` in
 * scripts/init-schema.sql) had ZERO behavioral coverage — HNSW candidate retrieval and
 * RRF fusion were never actually exercised end-to-end.
 *
 * WHAT fakeEmbed DOES
 * --------------------
 * `fakeEmbed(text)` hashes `text` to seed a small deterministic PRNG, draws 768
 * pseudo-random values (Box-Muller for a roughly isotropic distribution), and
 * L2-normalizes them into a unit vector — the same shape as a real embedding.
 * Properties that matter for tests:
 *   - Deterministic: same text -> byte-identical vector, every run, every machine.
 *   - Distinct: different text -> a different (generally near-orthogonal, in this
 *     high-dimensional space) vector, so distinct capture content no longer ties.
 *   - Self-consistent: because the SAME function embeds both queries and captures,
 *     a capture whose content is IDENTICAL to a search query embeds to the SAME
 *     vector as that query (cosine distance ~0) — this is the one controllable
 *     "exact match" case the fixture supports, and it's what the ordering
 *     assertions in search.test.ts key off of.
 *
 * WHAT fakeEmbed DOES NOT DO
 * ---------------------------
 * It captures NO semantic meaning. "dog" and "puppy" are NOT close in this space
 * the way they would be with a real embedder — two different strings land at an
 * essentially random angle to each other. Use this fixture ONLY for
 * *ranking-mechanics* assertions:
 *   - "a capture whose stored vector exactly matches the query vector ranks first"
 *   - "distinct capture content produces a distinct, non-degenerate vector-rank
 *     order (not an all-tied NaN/zero order)"
 *   - "hybrid mode fuses an FTS-only hit and a vector-only hit — both surface"
 * Do NOT use it to assert anything about semantic relevance/similarity (e.g. "a
 * query about coffee should rank a capture about tea higher than one about cars")
 * — that requires the live OpenAI embedder and belongs in a manual/staging check,
 * not CI. See IMPLEMENTATION_PLAN.md 6.4 for the QA-5 remediation this fixture
 * satisfies.
 */

const DIMENSIONS = 768

/**
 * FNV-1a 32-bit hash. Small, dependency-free, and stable across Node versions
 * and platforms (pure integer ops) — used only to derive a PRNG seed from text.
 */
function fnv1aHash(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Mulberry32 PRNG — deterministic given a 32-bit seed, fast, good-enough
 * statistical quality for generating a pseudo-embedding fixture (not
 * cryptographic, not for anything security-sensitive).
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministically derive a 768-dimension, L2-normalized pseudo-embedding
 * from arbitrary text. See module doc for what this is (and is NOT) safe to
 * assert about.
 */
export function fakeEmbed(text: string): number[] {
  const rand = mulberry32(fnv1aHash(text))

  const vec = new Array<number>(DIMENSIONS)
  for (let i = 0; i < DIMENSIONS; i++) {
    // Box-Muller transform: two uniforms -> one approximately-standard-normal
    // value. Using a normal distribution (rather than raw uniform) keeps the
    // resulting unit vectors closer to isotropic, so unrelated texts land
    // near-orthogonal instead of biased toward the all-positive orthant.
    const u1 = Math.max(rand(), 1e-12) // guard against log(0) = -Infinity
    const u2 = rand()
    vec[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }

  let normSq = 0
  for (const v of vec) normSq += v * v
  const norm = Math.sqrt(normSq)

  return vec.map((v) => v / norm)
}
