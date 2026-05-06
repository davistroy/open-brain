/**
 * Commitments API namespace. Extracted from `lib/api-client.ts` (Phase 8a Round 2).
 *
 * Exports: `commitmentsApi`, `CommitmentsListParams`, `CreateCommitmentPayload`, `PatchCommitmentPayload`
 */

import type { BoardCommitment, CommitmentStatus } from '../types'
import { request, buildQueryString } from './core'
import type { ListEnvelope } from './core'

// ---------------------------------------------------------------------------
// commitmentsApi — Board Kanban (M3, screen 09)
// ---------------------------------------------------------------------------

export interface CommitmentsListParams {
  status?: CommitmentStatus
  entity_id?: string
  limit?: number
  offset?: number
}

export interface CreateCommitmentPayload {
  text: string
  entity_id?: string
  due_date?: string     // ISO date "YYYY-MM-DD"
  status?: CommitmentStatus
}

export interface PatchCommitmentPayload {
  resolved?: boolean
  status?: CommitmentStatus
  due_date?: string
}

export const commitmentsApi = {
  /** GET /api/v1/commitments — paginated list with optional status + entity_id filters */
  list: (params: CommitmentsListParams = {}): Promise<ListEnvelope<BoardCommitment>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<BoardCommitment>>(`/commitments${qs}`)
  },

  /** GET /api/v1/entities/:id/commitments — open commitments for a specific entity */
  forEntity: (entityId: string, params: { limit?: number } = {}): Promise<ListEnvelope<BoardCommitment>> => {
    const qs = buildQueryString(params)
    return request<ListEnvelope<BoardCommitment>>(
      `/entities/${encodeURIComponent(entityId)}/commitments${qs}`,
    )
  },

  /** PATCH /api/v1/commitments/:id — toggle resolved or update status/due_date */
  patch: (id: string, body: PatchCommitmentPayload): Promise<BoardCommitment> => {
    return request<BoardCommitment>(
      `/commitments/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
  },

  /** POST /api/v1/commitments — manually create a commitment */
  create: (body: CreateCommitmentPayload): Promise<BoardCommitment> => {
    return request<BoardCommitment>('/commitments', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
}
