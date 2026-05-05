/**
 * Config routes — read-only endpoints for viewing runtime configuration.
 *
 * GET /api/v1/config/ai-routing     — model routing table + per-model monthly spend
 * GET /api/v1/config/integrations   — integration connectivity statuses
 */

import type { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import type { Database, ConfigService } from '@open-brain/shared'
import { AppError, logger } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelRoutingEntry {
  task: string
  model: string
  client: 'anthropic' | 'litellm' | 'ollama'
  cost_per_1k_input: number
  cost_per_1k_output: number
  month_spend_usd: number
  month_calls: number
}

interface AIRoutingResponse {
  models: ModelRoutingEntry[]
  budget: {
    soft_limit_usd: number
    hard_limit_usd: number
    month_total_usd: number
  }
}

interface IntegrationStatus {
  name: string
  status: 'connected' | 'disconnected' | 'unknown'
  url?: string
  detail?: string
  last_activity?: string
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerConfigRoutes(
  app: Hono,
  configService: ConfigService,
  db: Database,
): void {
  // ---- AI Routing config + spend ----
  app.get('/api/v1/config/ai-routing', async (c) => {
    try {
      const aiConfig = configService.get('ai')

      // Per-model monthly spend from ai_audit_log
      let spendByModel: Record<string, { spend: number; calls: number }> = {}
      let monthTotal = 0
      try {
        const rows = await db.execute<{
          model: string
          total_spend: string | null
          call_count: string | null
        }>(sql`
          SELECT
            model,
            COALESCE(SUM(cost_usd), 0) AS total_spend,
            COUNT(*)::text AS call_count
          FROM ai_audit_log
          WHERE created_at >= date_trunc('month', CURRENT_DATE)
          GROUP BY model
        `)
        for (const row of rows.rows) {
          const spend = parseFloat(String(row.total_spend))
          const calls = parseInt(String(row.call_count), 10)
          spendByModel[row.model] = { spend, calls }
          monthTotal += spend
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to query per-model spend')
      }

      // Build routing entries from config
      const models: ModelRoutingEntry[] = []
      for (const [task, entry] of Object.entries(aiConfig.models)) {
        if (!entry) continue
        const modelEntry = typeof entry === 'string'
          ? { model: entry, client: 'litellm' as const, cost_per_1k_input: 0, cost_per_1k_output: 0 }
          : entry
        const spendInfo = spendByModel[modelEntry.model] ?? { spend: 0, calls: 0 }
        models.push({
          task,
          model: modelEntry.model,
          client: modelEntry.client,
          cost_per_1k_input: modelEntry.cost_per_1k_input,
          cost_per_1k_output: modelEntry.cost_per_1k_output,
          month_spend_usd: Math.round(spendInfo.spend * 1000000) / 1000000,
          month_calls: spendInfo.calls,
        })
      }

      const response: AIRoutingResponse = {
        models,
        budget: {
          soft_limit_usd: aiConfig.monthly_budget.soft_limit_usd,
          hard_limit_usd: aiConfig.monthly_budget.hard_limit_usd,
          month_total_usd: Math.round(monthTotal * 1000000) / 1000000,
        },
      }

      return c.json(response)
    } catch (err) {
      logger.error({ err }, 'Failed to build AI routing config')
      throw new AppError('Failed to load AI routing config', 500, 'CONFIG_LOAD_FAILED')
    }
  })

  // ---- Integration statuses ----
  app.get('/api/v1/config/integrations', async (c) => {
    const integrations: IntegrationStatus[] = []

    // MCP endpoint
    try {
      const mcpResult = await db.execute<{ last_call: string | null }>(sql`
        SELECT MAX(timestamp) AS last_call
        FROM mcp_activity
      `)
      const lastCall = mcpResult.rows[0]?.last_call
      const mcpUrl = `${c.req.url.replace(/\/api\/v1\/config\/integrations.*/, '')}/mcp`
      integrations.push({
        name: 'MCP',
        status: 'connected',
        url: mcpUrl,
        detail: 'Streamable HTTP',
        last_activity: lastCall ?? undefined,
      })
    } catch {
      integrations.push({
        name: 'MCP',
        status: 'connected',
        detail: 'Streamable HTTP (no activity log)',
      })
    }

    // Slack
    const slackBotToken = process.env.SLACK_BOT_TOKEN
    integrations.push({
      name: 'Slack',
      status: slackBotToken ? 'connected' : 'disconnected',
      detail: slackBotToken ? 'Socket Mode' : 'No bot token configured',
    })

    // Cloudflare Tunnel
    integrations.push({
      name: 'Cloudflare Tunnel',
      status: 'connected',
      url: 'https://brain.troy-davis.com',
      detail: 'Web dashboard + API',
    })

    // Gitea (Wiki)
    const wikiRepoUrl = process.env.WIKI_REPO_URL
    integrations.push({
      name: 'Gitea',
      status: wikiRepoUrl ? 'connected' : 'disconnected',
      url: wikiRepoUrl ?? undefined,
      detail: wikiRepoUrl ? 'Wiki repository' : 'WIKI_REPO_URL not configured',
    })

    // Email inbound (Cloudflare Email Worker)
    integrations.push({
      name: 'Email (Inbound)',
      status: 'connected',
      detail: 'brain@troy-davis.com via CF Worker',
    })

    // Email outbound (Himalaya — future)
    integrations.push({
      name: 'Email (Outbound)',
      status: 'disconnected',
      detail: 'Himalaya — not yet configured',
    })

    return c.json({ integrations })
  })
}
