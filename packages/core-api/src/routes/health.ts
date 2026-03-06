import type { Hono } from 'hono'
import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { logger } from '../lib/logger.js'

type ServiceStatus = 'healthy' | 'degraded' | 'unhealthy'

interface ServiceCheck {
  status: ServiceStatus
  latency_ms?: number
  error?: string
}

interface HealthResponse {
  status: ServiceStatus
  timestamp: string
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
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      return { status: 'healthy', latency_ms: Date.now() - start }
    }
    return { status: 'degraded', latency_ms: Date.now() - start, error: `HTTP ${res.status}` }
  } catch (err) {
    logger.warn({ err }, 'LiteLLM health check failed')
    return { status: 'degraded', error: err instanceof Error ? err.message : String(err) }
  }
}

export function registerHealthRoutes(app: Hono): void {
  app.get('/health', async (c) => {
    const postgresUrl = process.env.POSTGRES_URL ?? 'postgresql://openbrain:openbrain_dev@localhost:5432/openbrain'
    const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
    const litellmUrl = process.env.LITELLM_URL ?? 'https://llm.k4jda.net'

    const [postgres, redis, litellm] = await Promise.all([
      checkPostgres(postgresUrl),
      checkRedis(redisUrl),
      checkLiteLLM(litellmUrl),
    ])

    const response: HealthResponse = {
      status: postgres.status === 'unhealthy' ? 'unhealthy' : (
        redis.status === 'unhealthy' || litellm.status === 'degraded' ? 'degraded' : 'healthy'
      ),
      timestamp: new Date().toISOString(),
      services: { postgres, redis, litellm },
    }

    // Only 503 when Postgres is down (critical)
    return c.json(response, response.status === 'unhealthy' ? 503 : 200)
  })
}
