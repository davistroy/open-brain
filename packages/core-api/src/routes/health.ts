import type { Hono } from 'hono'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { readFileSync } from 'node:fs'
import { logger } from '../lib/logger.js'

// Read version at startup — works in Docker where npm_package_version is unset.
// tsup bundles into dist/index.js, so ../package.json reaches packages/core-api/package.json.
const APP_VERSION = (() => {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf-8'))
      if (pkg.version) return pkg.version as string
    } catch { /* try next */ }
  }
  return process.env.npm_package_version ?? 'unknown'
})()

type ServiceStatus = 'healthy' | 'degraded' | 'unhealthy'

interface ServiceCheck {
  status: ServiceStatus
  latency_ms?: number
  error?: string
}

interface HealthResponse {
  status: ServiceStatus
  timestamp: string
  version?: string
  uptime_s?: number
  services: {
    postgres: ServiceCheck
    redis: ServiceCheck
    litellm: ServiceCheck
  }
}

async function checkPostgres(url: string): Promise<ServiceCheck> {
  const start = Date.now()
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 })
  try {
    await pool.query('SELECT 1')
    return { status: 'healthy', latency_ms: Date.now() - start }
  } catch (err) {
    logger.warn({ err }, 'Postgres health check failed')
    return { status: 'unhealthy', error: err instanceof Error ? err.message : String(err) }
  } finally {
    await pool.end()
  }
}

async function checkRedis(url: string): Promise<ServiceCheck> {
  const start = Date.now()
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 3000 })
  try {
    await redis.connect()
    await redis.ping()
    return { status: 'healthy', latency_ms: Date.now() - start }
  } catch (err) {
    logger.warn({ err }, 'Redis health check failed')
    return { status: 'unhealthy', error: err instanceof Error ? err.message : String(err) }
  } finally {
    redis.disconnect()
  }
}

async function checkLiteLLM(baseUrl: string): Promise<ServiceCheck> {
  const start = Date.now()
  const apiKey = process.env.LITELLM_API_KEY
  try {
    // Use /v1/models — virtual keys can only access LLM API routes, not /health
    const headers: Record<string, string> = {}
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000), headers })
    if (res.ok) {
      return { status: 'healthy', latency_ms: Date.now() - start }
    }
    return { status: 'degraded', latency_ms: Date.now() - start, error: `HTTP ${res.status}` }
  } catch (err) {
    logger.warn({ err }, 'LiteLLM health check failed')
    return { status: 'degraded', error: err instanceof Error ? err.message : String(err) }
  }
}

async function buildHealthResponse(): Promise<HealthResponse> {
  const postgresUrl = process.env.POSTGRES_URL ?? 'postgresql://openbrain:openbrain_dev@localhost:5432/openbrain'
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
  const litellmUrl = process.env.LITELLM_URL ?? 'https://llm.k4jda.net'

  const [postgres, redis, litellm] = await Promise.all([
    checkPostgres(postgresUrl),
    checkRedis(redisUrl),
    checkLiteLLM(litellmUrl),
  ])

  return {
    status: postgres.status === 'unhealthy' ? 'unhealthy' : (
      redis.status === 'unhealthy' || litellm.status === 'degraded' ? 'degraded' : 'healthy'
    ),
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
    uptime_s: Math.floor(process.uptime()),
    services: { postgres, redis, litellm },
  }
}

export function registerHealthRoutes(app: Hono): void {
  // Docker-internal healthcheck endpoint
  app.get('/health', async (c) => {
    const response = await buildHealthResponse()
    return c.json(response, response.status === 'unhealthy' ? 503 : 200)
  })

  // Versioned alias — used by the web UI Settings page
  app.get('/api/v1/health', async (c) => {
    const response = await buildHealthResponse()
    return c.json(response, response.status === 'unhealthy' ? 503 : 200)
  })
}
