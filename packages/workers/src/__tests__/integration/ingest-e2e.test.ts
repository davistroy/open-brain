/**
 * Ingest End-to-End Test (Tech Debt 4.5)
 *
 * GATED: Skipped by default. Enable with `INGEST_E2E=1`.
 *
 * Exercises the full ingest path:
 *
 *     core-api  (POST /api/v1/ingest/upload)
 *          │
 *          ▼
 *      BullMQ ingest-process queue
 *          │
 *          ▼
 *      workers ingest-process.ts   ──POST /process──▶  sidecar trigger_server
 *          │                                                   │
 *          ◀──── captures_posted (array of UUIDs) ─────────────┘
 *          │
 *          ▼
 *      file_uploads.status = 'parsed'
 *
 * Run manually (after bringing up the full dev stack OR a combined test stack that
 * includes test-postgres + test-redis + core-api + workers + a test-sidecar):
 *
 *     INGEST_E2E=1 pnpm --filter @open-brain/workers test:integration \
 *       src/__tests__/integration/ingest-e2e.test.ts
 *
 * Environment overrides (with defaults):
 *   CORE_API_URL       default: http://localhost:3002
 *   INGEST_SOURCE      default: financial        (must match the running sidecar's
 *                                                  INGEST_SOURCE env var — see
 *                                                  PR #93 regression. The test
 *                                                  asserts the tag propagates.)
 *   INGEST_TRIGGER_SECRET default: test-secret   (must match the sidecar's secret)
 *
 * Why this is a separate file (not folded into pipeline.test.ts):
 *   - pipeline.test.ts runs on every `test:integration` invocation and relies on
 *     ONLY test-postgres + test-redis. This file needs additional long-running
 *     services (core-api + workers + sidecar) — we do not want CI to start all
 *     of those for the normal integration pass.
 *   - The gate (`INGEST_E2E`) keeps it out of the default suite entirely; when
 *     off it produces a "skipped" line and exits instantly.
 */

import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Configuration & gate
// ---------------------------------------------------------------------------

const E2E_ENABLED = process.env.INGEST_E2E === '1'

const CORE_API_URL = (process.env.CORE_API_URL ?? 'http://localhost:3002').replace(/\/$/, '')
const EXPECTED_INGEST_SOURCE = process.env.INGEST_SOURCE ?? 'financial'

const UPLOAD_POLL_TIMEOUT_MS = 30_000
const UPLOAD_POLL_INTERVAL_MS = 500

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub 2-line CSV (header + 1 data row) suitable for a financial parser. */
function stubFinancialCsv(): string {
  // Match a shape the local router recognises as financial (AMEX "activity.csv"):
  //   Date,Description,Amount
  // The test does NOT depend on any particular parser — it only needs the sidecar
  // to accept the payload and emit a successful /process response.
  return 'Date,Description,Amount\n2026-04-17,TEST INGEST E2E,-12.34\n'
}

/**
 * POST a multipart upload to core-api and return the parsed JSON body.
 *
 * We use the global `fetch` (Node 22) + `FormData` + `Blob` APIs so the test has
 * no extra deps beyond what the workers package already carries.
 */
async function uploadStubCsv(): Promise<{ upload_id: string; source_type: string }> {
  const csv = stubFinancialCsv()
  const form = new FormData()
  // Filename "activity.csv" hits the local AMEX heuristic in the ingest route —
  // guarantees source_type=financial without relying on the explicit field below.
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'activity.csv')
  form.append('source_type', EXPECTED_INGEST_SOURCE)

  const res = await fetch(`${CORE_API_URL}/api/v1/ingest/upload`, {
    method: 'POST',
    headers: {
      // Rate-limiter bypass — matches BYPASS_CALLERS in middleware/rate-limit.ts.
      'X-Open-Brain-Caller': 'integration-test',
    },
    body: form,
  })

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '<unreadable>')
    throw new Error(`upload failed: ${res.status} ${res.statusText} — ${bodyText}`)
  }

  const body = (await res.json()) as { upload_id: string; source_type: string }
  return body
}

/**
 * Poll `GET /api/v1/ingest/uploads/:id` until status transitions out of `pending`.
 * Throws on timeout; returns the final row otherwise.
 */
async function pollUntilTerminal(upload_id: string): Promise<{
  status: string
  source_type: string
  capture_ids: string[]
  error_message: string | null
}> {
  const deadline = Date.now() + UPLOAD_POLL_TIMEOUT_MS
  let last: Awaited<ReturnType<typeof pollUntilTerminal>> | null = null

  while (Date.now() < deadline) {
    const res = await fetch(`${CORE_API_URL}/api/v1/ingest/uploads/${upload_id}`, {
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
    })
    if (!res.ok) {
      // 404 is tolerated briefly right after POST in case of read-replica lag;
      // any other error is fatal.
      if (res.status !== 404) {
        const bodyText = await res.text().catch(() => '<unreadable>')
        throw new Error(`poll failed: ${res.status} ${res.statusText} — ${bodyText}`)
      }
    } else {
      last = (await res.json()) as typeof last
      if (last && last.status !== 'pending' && last.status !== 'processing') {
        return last
      }
    }
    await new Promise((r) => setTimeout(r, UPLOAD_POLL_INTERVAL_MS))
  }

  throw new Error(
    `timed out after ${UPLOAD_POLL_TIMEOUT_MS}ms waiting for upload ${upload_id} to reach a terminal status — last=${JSON.stringify(last)}`,
  )
}

// ---------------------------------------------------------------------------
// Suite — skipIf gates the entire block
// ---------------------------------------------------------------------------

describe.skipIf(!E2E_ENABLED)('ingest end-to-end (INGEST_E2E=1)', () => {
  it('uploads a stub CSV and the full pipeline marks it parsed', async () => {
    const { upload_id, source_type } = await uploadStubCsv()

    expect(upload_id).toMatch(/^[0-9a-f-]{36}$/i)
    // The upload response's source_type reflects the router decision — must match
    // the sidecar tag we expect (regression coverage for PR #93).
    expect(source_type).toBe(EXPECTED_INGEST_SOURCE)

    const terminal = await pollUntilTerminal(upload_id)

    // Primary assertion: worker + sidecar drove the row to `parsed`.
    expect(terminal.status).toBe('parsed')
    expect(terminal.error_message).toBeNull()
    // Sidecar should have reported at least one capture UUID back to core-api.
    expect(terminal.capture_ids.length).toBeGreaterThan(0)
    // The row must still be tagged with the source that matches the sidecar
    // binding — guards the PR #93 "each sidecar bound to its INGEST_SOURCE"
    // regression from silently regressing to a default/fallback value.
    expect(terminal.source_type).toBe(EXPECTED_INGEST_SOURCE)
  })

  it('rejects an upload without a file part', async () => {
    // Happy-path guard + auth/shape negative: the core-api should 4xx before any
    // work is queued. This catches a class of regressions where the endpoint
    // silently enqueues a job with no source file.
    const form = new FormData()
    form.append('source_type', EXPECTED_INGEST_SOURCE)

    const res = await fetch(`${CORE_API_URL}/api/v1/ingest/upload`, {
      method: 'POST',
      headers: { 'X-Open-Brain-Caller': 'integration-test' },
      body: form,
    })

    // Any 4xx is acceptable — we only assert the endpoint did not 2xx and did
    // not 5xx (which would indicate the server crashed on bad input).
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
