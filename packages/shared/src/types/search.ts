import type { CaptureRecord } from './capture.js'

export interface SearchOptions {
  query: string
  brain_view?: string
  capture_type?: string
  limit?: number          // default 20
  offset?: number         // default 0
  temporal_weight?: number // 0.0–1.0, default 0.0 (ramp up as search history builds)
  min_score?: number
  hybrid?: boolean        // default true — use FTS + vector with RRF
}

export interface SearchResult {
  capture: CaptureRecord
  vector_score?: number   // cosine similarity (0–1)
  fts_score?: number      // BM25-like rank from postgres FTS
  rrf_score?: number      // Reciprocal Rank Fusion combined score
  temporal_score?: number // ACT-R decay score (0–1)
  final_score: number     // weighted composite
}

export interface SearchResponse {
  results: SearchResult[]
  total: number
  query: string
  took_ms: number
}
