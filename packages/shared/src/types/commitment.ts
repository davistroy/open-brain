import { z } from 'zod'

// ============================================================
// CommitmentStatus — direction of an extracted obligation
// Canonical 4-value set (CS2 / migration 0031). Lockstep across:
//
//   - This TS union (source of truth)
//   - Zod: CommitmentStatusSchema / COMMITMENT_STATUSES
//   - DB CHECK: commitments_status_check (migration 0031)
//   - Drizzle schema comment in packages/shared/src/schema/commitments.ts
//
// Maps to Cloudscape Board 4-column layout:
//   pending      → Pending column (unclassified / needs attention)
//   owed_by_user → "You owe" column (user has an outgoing obligation)
//   waiting_on   → "Waiting on" column (user is waiting for another party)
//   resolved     → Resolved column (obligation fulfilled or cancelled)
//
// Adding a value → update all surfaces in lockstep + pre-flight audit.
// ============================================================
export type CommitmentStatus = 'pending' | 'owed_by_user' | 'waiting_on' | 'resolved'

export const COMMITMENT_STATUSES: readonly CommitmentStatus[] = [
  'pending',
  'owed_by_user',
  'waiting_on',
  'resolved',
] as const

export const CommitmentStatusSchema = z.enum(['pending', 'owed_by_user', 'waiting_on', 'resolved'])

// ============================================================
// Commitment — list-shape returned by GET /api/v1/commitments
// ============================================================
export interface Commitment {
  id: string
  capture_id: string
  entity_id?: string            // null when no entity was resolved
  text: string
  due_date?: string             // ISO 8601 date string (YYYY-MM-DD), null if no deadline
  status: CommitmentStatus
  resolved_at?: string          // ISO 8601 timestamp, null while open
  created_at: string            // ISO 8601 timestamp
}

export const CommitmentSchema = z.object({
  id: z.string().uuid(),
  capture_id: z.string().uuid(),
  entity_id: z.string().uuid().optional(),
  text: z.string(),
  due_date: z.string().optional(),
  status: CommitmentStatusSchema,
  resolved_at: z.string().optional(),
  created_at: z.string(),
})
