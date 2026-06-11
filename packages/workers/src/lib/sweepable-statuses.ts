import type { PipelineStatus } from '@open-brain/shared'

/**
 * Capture pipeline statuses eligible for stuck-capture recovery sweeps
 * (daily-sweep job + stale-captures skill).
 *
 * - `pending`    — initial enqueue failed (capture.ts swallows the error and
 *                  relies on the sweep to recover)
 * - `processing` — worker died mid-job
 * - `extracted`  — embed-job retries exhausted (the "no embedding fallback —
 *                  queue and retry" recovery case)
 *
 * `satisfies` pins every value to the canonical PipelineStatus union at
 * compile time (arch-review TD-2) — an invalid status string like the
 * pre-fix `'received'` (a pipeline_events.stage value, never a capture
 * status; SE-1) fails `tsc`.
 */
export const SWEEPABLE_STATUSES = [
  'pending',
  'processing',
  'extracted',
] as const satisfies readonly PipelineStatus[]
