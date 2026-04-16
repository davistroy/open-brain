/**
 * Open Brain Synthetic Monitor — Cloudflare Worker cron health check.
 *
 * Runs every 5 minutes via cron trigger. Fetches the public health endpoint
 * (brain.troy-davis.com) to verify the full external path: DNS, Cloudflare,
 * tunnel, nginx, core-api, and Postgres. Tracks consecutive failures in KV
 * and sends Pushover alerts after 2 consecutive failures. Sends a recovery
 * notification when the service comes back up after a failure streak.
 */

interface Env {
  HEALTH_STATE: KVNamespace
  HEALTH_URL: string
  PUSHOVER_API_URL: string
  PUSHOVER_TOKEN: string
  /** Cloudflare Access Service Token — required to bypass Zero Trust on brain.troy-davis.com */
  CF_ACCESS_CLIENT_ID: string
  CF_ACCESS_CLIENT_SECRET: string
  PUSHOVER_USER: string
}

const KV_KEY_CONSECUTIVE_FAILURES = 'consecutive_failures'
const KV_KEY_LAST_ERROR = 'last_error'
const FAILURE_THRESHOLD = 2
const HEALTH_CHECK_TIMEOUT_MS = 15_000

interface HealthResponse {
  status: string
  [key: string]: unknown
}

async function getConsecutiveFailures(kv: KVNamespace): Promise<number> {
  const val = await kv.get(KV_KEY_CONSECUTIVE_FAILURES)
  return val ? parseInt(val, 10) : 0
}

async function sendPushover(
  env: Env,
  message: string,
  priority: number,
): Promise<void> {
  const body = new URLSearchParams({
    token: env.PUSHOVER_TOKEN,
    user: env.PUSHOVER_USER,
    message,
    title: 'Open Brain Monitor',
    priority: String(priority),
  })

  const res = await fetch(env.PUSHOVER_API_URL, {
    method: 'POST',
    body,
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`Pushover send failed: ${res.status} — ${text}`)
  } else {
    console.log(`Pushover notification sent (priority ${priority})`)
  }
}

async function checkHealth(env: Env): Promise<{ ok: boolean; error?: string }> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS)

    const headers: Record<string, string> = { Accept: 'application/json' }
    // Cloudflare Access Service Token bypasses Zero Trust login redirect
    if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
      headers['CF-Access-Client-Id'] = env.CF_ACCESS_CLIENT_ID
      headers['CF-Access-Client-Secret'] = env.CF_ACCESS_CLIENT_SECRET
    }

    const res = await fetch(env.HEALTH_URL, {
      signal: controller.signal,
      headers,
    })

    clearTimeout(timeout)

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}` }
    }

    const data = (await res.json()) as HealthResponse

    if (data.status !== 'healthy') {
      return { ok: false, error: `Status: ${data.status}` }
    }

    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // AbortError means timeout
    if (message.includes('abort')) {
      return { ok: false, error: `Timeout after ${HEALTH_CHECK_TIMEOUT_MS}ms` }
    }
    return { ok: false, error: message }
  }
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const result = await checkHealth(env)
    const previousFailures = await getConsecutiveFailures(env.HEALTH_STATE)

    if (result.ok) {
      console.log(`Health check passed (previous consecutive failures: ${previousFailures})`)

      // Send recovery notification if we were in a failure state
      if (previousFailures >= FAILURE_THRESHOLD) {
        ctx.waitUntil(
          sendPushover(
            env,
            `Open Brain recovered after ${previousFailures} consecutive failures.`,
            0, // normal priority
          ),
        )
      }

      // Reset counters
      await env.HEALTH_STATE.put(KV_KEY_CONSECUTIVE_FAILURES, '0')
      await env.HEALTH_STATE.delete(KV_KEY_LAST_ERROR)
    } else {
      const newCount = previousFailures + 1
      console.error(`Health check FAILED (${newCount} consecutive): ${result.error}`)

      await env.HEALTH_STATE.put(KV_KEY_CONSECUTIVE_FAILURES, String(newCount))
      await env.HEALTH_STATE.put(KV_KEY_LAST_ERROR, result.error ?? 'unknown')

      // Alert on threshold crossing — send on every failure at or above threshold
      // to avoid silent gaps if a single notification is missed
      if (newCount >= FAILURE_THRESHOLD) {
        ctx.waitUntil(
          sendPushover(
            env,
            `Open Brain health check failed: ${result.error} (${newCount} consecutive failures)`,
            1, // high priority
          ),
        )
      }
    }
  },
}
