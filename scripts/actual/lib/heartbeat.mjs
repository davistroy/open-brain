/**
 * Heartbeat reporting for the actual-ingest sidecar (remediation item 3.5).
 * Carries counts and an error string only: no balance, payee, or account name.
 * A heartbeat failure is logged and never masks the run's own exit status.
 */

const MAX_ERROR_CHARS = 300

/**
 * POST the heartbeat to core-api. Throws on network error or non-2xx.
 */
export async function postHeartbeat({ coreApiUrl, ok, errors, meta, fetchImpl = fetch }) {
  const base = String(coreApiUrl).replace(/\/+$/, '')
  const body = { ok }
  if (errors && errors.length > 0) body.errors = errors
  if (meta) body.meta = meta
  const res = await fetchImpl(`${base}/api/v1/internal/heartbeat/actual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Open-Brain-Caller': 'actual-pipeline' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`heartbeat POST failed: HTTP ${res.status}`)
}

/**
 * Report a run outcome. On a failed heartbeat post for a failed run, send one
 * priority-1 Pushover so the failure is not silent. Never throws.
 */
export async function reportOutcome({ ok, error, meta, postHeartbeat: post, sendPushover, logger }) {
  const message = error == null ? null : String(error?.message ?? error).slice(0, MAX_ERROR_CHARS)
  const errors = ok || message === null ? undefined : [message]
  try {
    await post({ ok, errors, meta })
  } catch (err) {
    logger?.warn?.(`heartbeat post failed (${err?.message ?? err})`)
    if (!ok) {
      try {
        await sendPushover('Actual daily FAILED', `${message ?? 'run failed'} (heartbeat unreachable)`, 1)
      } catch (pErr) {
        logger?.warn?.(`failure Pushover also failed (${pErr?.message ?? pErr})`)
      }
    }
  }
}
