/**
 * Synthesize API — POST /api/v1/synthesize.
 * LLM synthesis over matching captures. Extracted from api-client.ts.
 */

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { request } from './core'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SynthesizePayload {
  query: string
  limit?: number
}

/**
 * Actual response shape from POST /api/v1/synthesize.
 * Route returns { response: string, capture_count: number } — NOT { answer, sources, query }.
 * See packages/core-api/src/routes/synthesize.ts c.json({response, capture_count}).
 */
export interface SynthesizeResponse {
  response: string
  capture_count: number
}

// ---------------------------------------------------------------------------
// synthesizeApi
// ---------------------------------------------------------------------------

export const synthesizeApi = {
  /** POST /api/v1/synthesize — LLM synthesis over matching captures */
  query: (payload: SynthesizePayload): Promise<SynthesizeResponse> => {
    return request<SynthesizeResponse>('/synthesize', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}
