import OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import { sql } from 'drizzle-orm'
import { ServiceUnavailableError } from '../utils/errors.js'
import { ai_audit_log } from '../schema/index.js'
import { logger } from '../lib/logger.js'
import { ModelResolverError } from './model-resolver.js'
import type { ConfigService } from '../config/loader.js'
import type { Database } from '../db/index.js'
import type { TemplateCache } from '../lib/prompt-template.js'
import type { AIClientType, ModelTierEntry } from '../types/config.js'

/**
 * Thrown when the LLM gateway is over budget (hard limit).
 */
export class LLMBudgetExceededError extends ServiceUnavailableError {
  constructor(message = 'Monthly LLM budget hard limit exceeded') {
    super(message)
    this.name = 'LLMBudgetExceededError'
  }
}

/**
 * Thrown when the LLM gateway call fails.
 */
export class LLMGatewayError extends ServiceUnavailableError {
  constructor(message = 'LLM gateway request failed') {
    super(message)
    this.name = 'LLMGatewayError'
  }
}

/**
 * Estimate cost for tier-based calls. Ollama and Anthropic are $0.
 * LiteLLM/OpenAI tiers default to $0 until per-tier cost config is added.
 * The ai_audit_log records all calls, enabling retroactive cost analysis.
 */
function estimateTierCostUsd(clientUsed: AIClientType, _promptTokens: number, _completionTokens: number): number {
  if (clientUsed === 'ollama' || clientUsed === 'anthropic') return 0
  return 0
}

/** Maximum number of tier fallback hops (T0 -> T1 -> T2) */
const MAX_FALLBACK_HOPS = 2

/**
 * Backoff schedule (ms) for retrying the SAME tier when the model is still loading.
 * Matches llama.cpp's "Loading model" 503s during cold-start on the Jetson.
 * Length of the array is the number of retries (3 retries = 4 total attempts).
 */
const MODEL_LOADING_BACKOFF_MS = [3_000, 6_000, 12_000]

/**
 * Detect transient "model is warming up" errors where the same tier should be
 * retried instead of falling back. Specific enough not to match ordinary 503s.
 */
function isModelLoadingError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return /loading\s+model|model\s+is\s+loading|warming\s+up/i.test(err.message)
}

export interface LLMCompleteOptions {
  temperature?: number
  maxTokens?: number
  captureId?: string
  sessionId?: string
  /** When true, passes response_format: { type: 'json_object' } to OpenAI SDK calls */
  jsonMode?: boolean
}

export interface MonthlySpend {
  total: number
  by_model: Record<string, number>
}

/** Result from resolveByTask — everything needed to make a call and log the audit */
export interface TaskResolution {
  client: AIClientType
  model: string
  tierKey: string
  tier: ModelTierEntry
  maxTokens: number
  timeoutMs: number
}

/**
 * Resolved client bundle for agent-loop callers (e.g., `runAgent`).
 *
 * Carries the live SDK client instance (not just the client-type enum), the
 * concrete model string, and a `fallback` closure that advances through the
 * same-provider fallback chain. Returning `null` from `fallback` signals the
 * chain is exhausted.
 *
 * Agent-loop fallback is **restricted to same-provider tiers**: mid-loop
 * Anthropic→OpenAI swap would break tool-use block compatibility. The
 * resolver filters the chain accordingly.
 */
export interface AgentClientResolution {
  /** Live SDK client instance. Anthropic for anthropic tiers; OpenAI SDK otherwise. */
  client: Anthropic | OpenAI
  /** Concrete model id suitable for the client's API call. */
  model: string
  /** Tier key (e.g., `t2_quality`) the task routed to. */
  tierKey: string
  /** Provider string from ai-routing.yaml (e.g., `anthropic`, `openai_compat`). */
  provider: string
  /** Per-tier max completion tokens (from `model_tiers[tierKey].max_completion_tokens`). */
  maxTokens: number
  /** Per-tier request timeout (from `model_tiers[tierKey].timeout_ms`). */
  timeoutMs: number
  /**
   * Advance to the next same-provider tier. Returns `null` when exhausted.
   * Each invocation consumes one step in the chain — caller is responsible
   * for tracking swap count if it wants to cap retries.
   */
  fallback?: () => AgentClientResolution | null
}

/**
 * LLMGatewayService routes LLM calls via task-based tier routing only.
 *
 * Single entry point: `completeByTask(prompt, taskName)` uses `task_routing`
 * + `model_tiers` from ai-routing.yaml. Supports automatic fallback chains
 * (max 2 hops, e.g. T0 Ollama -> T1 Haiku -> T2 Sonnet). Unrouted task
 * names throw LLMGatewayError — no silent fall-through.
 *
 * Backends: Ollama (local), Anthropic (subscription), and OpenAI-SDK-compatible
 * endpoints (per-tier clients built from each tier's base_url). An optional
 * generic OpenAI client is kept as an escape hatch for tiers declaring
 * provider: 'litellm' or 'openai' (no openai_compat) — currently no tier does.
 *
 * Audit log records which client was used and cost ($0 for Ollama and Claude subscription).
 */
export class LLMGatewayService {
  private anthropicClient: Anthropic | null
  private ollamaClient: OpenAI | null
  private openaiClient: OpenAI | null
  private configService: ConfigService
  private db: Database
  private templateCache: TemplateCache
  /** Cache of OpenAI SDK clients for tiers with custom base_url (e.g., Jetson) */
  private tierClientCache: Map<string, OpenAI> = new Map()

  constructor(
    configService: ConfigService,
    db: Database,
    templateCache: TemplateCache,
    anthropicClient?: Anthropic | null,
    ollamaClient?: OpenAI | null,
    /**
     * Optional OpenAI-SDK-compatible client used only when a tier declares
     * provider: 'litellm' or 'openai' (no openai_compat). For openai_compat
     * tiers, per-tier clients are built from the tier's base_url via
     * getClientForTier() and this argument is ignored. Currently no tier
     * uses provider: 'litellm' — kept as an escape hatch.
     */
    openaiClient?: OpenAI | null,
  ) {
    this.configService = configService
    this.db = db
    this.templateCache = templateCache
    this.anthropicClient = anthropicClient ?? null
    this.ollamaClient = ollamaClient ?? null
    this.openaiClient = openaiClient ?? null

    const clients: string[] = []
    if (this.anthropicClient) clients.push('Anthropic')
    if (this.ollamaClient) clients.push('Ollama')
    if (this.openaiClient) clients.push('OpenAI')
    logger.info(
      { clients },
      `LLMGatewayService: ${clients.length}-client routing enabled (${clients.length ? clients.join(', ') : 'none — tiers must use openai_compat base_url'})`,
    )
  }

  // ---------------------------------------------------------------------------
  // Task-based tier routing (single entry point)
  // ---------------------------------------------------------------------------

  /**
   * Resolve a task name to its tier configuration and appropriate client.
   * Looks up: task_routing[taskName] -> tier key -> model_tiers[tierKey].
   *
   * Returns null if three-tier routing is not configured or the task is unknown.
   */
  resolveByTask(taskName: string): TaskResolution | null {
    if (!this.configService.hasThreeTierRouting()) return null

    const tierKey = this.configService.getTaskTierKey(taskName)
    if (!tierKey) return null

    const tier = this.configService.getModelTier(tierKey)
    if (!tier) return null

    const client = this.resolveProviderClient(tier.provider)

    return {
      client,
      model: tier.model,
      tierKey,
      tier,
      maxTokens: tier.max_completion_tokens,
      timeoutMs: tier.timeout_ms,
    }
  }

  /**
   * Maps a tier's provider string to the actual client type that will be used,
   * accounting for client availability. Falls back gracefully.
   *
   * 'openai_compat' tiers (e.g., Spark vLLM, Jetson llama.cpp) get a dedicated
   * OpenAI SDK client via getClientForTier() with custom base_url.
   */
  private resolveProviderClient(provider: string): AIClientType {
    if (provider === 'ollama' && this.ollamaClient) return 'ollama'
    if (provider === 'anthropic' && this.anthropicClient) return 'anthropic'
    if (provider === 'ollama' && !this.ollamaClient) {
      logger.debug('Ollama client not available — degrading to litellm')
      return 'litellm'
    }
    if (provider === 'anthropic' && !this.anthropicClient) {
      logger.debug('Anthropic client not available — degrading to litellm')
      return 'litellm'
    }
    if (provider === 'openai_compat') return 'openai_compat'
    // litellm, openai, deepseek — all use the OpenAI SDK client
    return 'litellm'
  }

  /**
   * Returns the OpenAI SDK client for a specific tier, respecting its base_url.
   *
   * For 'openai_compat' provider tiers (custom OpenAI-compatible endpoints like
   * Jetson llama.cpp, Spark vLLM), creates a dedicated cached client using the
   * tier's base_url.
   * For 'ollama' tiers, uses the pre-constructed ollamaClient (from OLLAMA_URL env).
   * For 'litellm'/'openai' tiers, uses the optional pre-constructed openaiClient.
   * For 'anthropic' tiers, the caller handles dispatch separately.
   */
  private getClientForTier(tier: ModelTierEntry, tierKey: string, clientType: AIClientType): OpenAI {
    // openai_compat tiers always get a dedicated client from base_url
    if (tier.provider === 'openai_compat' && tier.base_url) {
      const cached = this.tierClientCache.get(tierKey)
      if (cached) return cached

      const normalizedURL = tier.base_url.endsWith('/v1') ? tier.base_url : `${tier.base_url}/v1`
      const client = new OpenAI({
        baseURL: normalizedURL,
        apiKey: 'local',  // Local endpoints ignore the key but SDK requires non-empty
        timeout: tier.timeout_ms,
        maxRetries: 0,  // Fail fast — let the fallback chain handle retries
      })

      this.tierClientCache.set(tierKey, client)
      logger.info({ tierKey, baseUrl: normalizedURL }, `Created cached client for tier '${tierKey}'`)
      return client
    }

    // ollama tiers use the pre-constructed ollamaClient
    if (clientType === 'ollama' && this.ollamaClient) return this.ollamaClient

    // litellm/openai tiers use the optional pre-constructed openaiClient
    if (this.openaiClient) return this.openaiClient

    // No client available for this tier — misconfiguration
    throw new LLMGatewayError(
      `No OpenAI-SDK client available for tier '${tierKey}' (provider: ${tier.provider}). ` +
      `Either add base_url for openai_compat, or supply an openaiClient to the gateway.`,
    )
  }

  /**
   * Complete a prompt using task-based tier routing with automatic fallback.
   *
   * Resolves the task to a tier, calls the primary provider. On transient
   * failure, follows the fallback chain (max 2 hops). Falls back to legacy
   * alias-based routing if three-tier routing is not configured.
   *
   * @param prompt The prompt text
   * @param taskName The task name as defined in task_routing config
   * @param options Standard completion options
   * @returns The completion text
   */
  async completeByTask(
    prompt: string,
    taskName: string,
    options: LLMCompleteOptions = {},
  ): Promise<string> {
    const resolution = this.resolveByTask(taskName)
    if (!resolution) {
      throw new LLMGatewayError(
        `Task '${taskName}' has no routing entry. Add it to task_routing: in config/ai-routing.yaml.`,
      )
    }
    return this.completeWithTierFallback(prompt, taskName, resolution, options, 0)
  }

  /**
   * Execute a completion against a resolved tier, with recursive fallback
   * on transient errors. Enforces max 2 hops to prevent infinite loops.
   */
  private async completeWithTierFallback(
    prompt: string,
    taskName: string,
    resolution: TaskResolution,
    options: LLMCompleteOptions,
    hopCount: number,
  ): Promise<string> {
    const { client, model, tierKey, tier, maxTokens, timeoutMs } = resolution

    // Budget check — skip for free clients (Ollama, Anthropic subscription)
    await this.checkBudget(client)

    // Retry the SAME tier on "Loading model" errors (llama.cpp cold start).
    // Other errors fall through to the tier-fallback chain below.
    for (let attempt = 0; attempt <= MODEL_LOADING_BACKOFF_MS.length; attempt++) {
      const startMs = Date.now()

      try {
        let text: string
        let promptTokens = 0
        let completionTokens = 0
        let totalTokens = 0

        if (client === 'anthropic') {
          const result = await this.completeViaAnthropic(prompt, model, {
            ...options,
            maxTokens: options.maxTokens ?? maxTokens,
          })
          text = result.text
          promptTokens = result.inputTokens
          completionTokens = result.outputTokens
          totalTokens = promptTokens + completionTokens
        } else {
          // Ollama, LiteLLM, and openai_compat tiers all use OpenAI SDK.
          // getClientForTier respects the tier's base_url for custom endpoints.
          const openaiClient = this.getClientForTier(tier, tierKey, client)
          const result = await this.completeViaOpenAISDK(
            openaiClient, prompt, model,
            { ...options, maxTokens: options.maxTokens ?? maxTokens },
            timeoutMs,
          )
          text = result.text
          promptTokens = result.promptTokens
          completionTokens = result.completionTokens
          totalTokens = result.totalTokens
        }

        const durationMs = Date.now() - startMs
        const costUsd = estimateTierCostUsd(client, promptTokens, completionTokens)

        await this.logAudit({
          taskType: taskName,
          model,
          clientUsed: client,
          costUsd,
          promptTokens,
          completionTokens,
          totalTokens,
          durationMs,
          captureId: options.captureId,
          sessionId: options.sessionId,
        })

        return text
      } catch (err) {
        const durationMs = Date.now() - startMs

        if (err instanceof LLMBudgetExceededError) throw err

        const message = err instanceof Error ? err.message : String(err)

        // Log the failed attempt
        await this.logAudit({
          taskType: taskName,
          model,
          clientUsed: client,
          costUsd: null,
          durationMs,
          captureId: options.captureId,
          sessionId: options.sessionId,
          error: message,
        })

        // Same-tier retry window: llama.cpp "Loading model" 503s during cold start.
        if (isModelLoadingError(err) && attempt < MODEL_LOADING_BACKOFF_MS.length) {
          const backoffMs = MODEL_LOADING_BACKOFF_MS[attempt]!
          logger.warn(
            { taskName, tierKey, attempt: attempt + 1, maxAttempts: MODEL_LOADING_BACKOFF_MS.length + 1, backoffMs, error: message },
            `Tier ${tierKey} (${client}) loading model — retrying same tier in ${backoffMs}ms`,
          )
          await new Promise((resolve) => setTimeout(resolve, backoffMs))
          continue
        }

        // Attempt tier fallback if within hop limit and tier has a fallback
        if (hopCount < MAX_FALLBACK_HOPS && tier.fallback && this.shouldAttemptFallback(err, client)) {
          const fallbackTier = this.configService.getModelTier(tier.fallback)
          if (fallbackTier) {
            const fallbackClient = this.resolveProviderClient(fallbackTier.provider)
            logger.warn(
              { taskName, tierKey, fallbackTier: tier.fallback, hopCount: hopCount + 1, error: message },
              `Tier ${tierKey} (${client}) failed — falling back to ${tier.fallback} (${fallbackClient})`,
            )

            const fallbackResolution: TaskResolution = {
              client: fallbackClient,
              model: fallbackTier.model,
              tierKey: tier.fallback,
              tier: fallbackTier,
              maxTokens: fallbackTier.max_completion_tokens,
              timeoutMs: fallbackTier.timeout_ms,
            }

            return this.completeWithTierFallback(prompt, `${taskName}:fallback`, fallbackResolution, options, hopCount + 1)
          }
        }

        throw new LLMGatewayError(
          `LLM request failed for task '${taskName}' tier '${tierKey}' (${client}): ${message}`,
        )
      }
    }

    // Unreachable — the loop either returns on success, recurses on fallback, or throws.
    throw new LLMGatewayError(`LLM request failed for task '${taskName}' tier '${tierKey}' (${client}): exhausted retries`)
  }

  /**
   * Call the OpenAI SDK (LiteLLM or Ollama) with a per-call timeout.
   * Used by tier-based routing where each tier specifies its own timeout.
   */
  private async completeViaOpenAISDK(
    client: OpenAI,
    prompt: string,
    model: string,
    options: LLMCompleteOptions,
    timeoutMs?: number,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; totalTokens: number }> {
    const requestOptions = timeoutMs ? { timeout: timeoutMs } : undefined

    const response = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 0.2,
        max_completion_tokens: options.maxTokens ?? 2048,
        ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      },
      requestOptions,
    )

    const usage = response.usage
    const text = response.choices[0]?.message?.content ?? ''

    return {
      text,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
    }
  }

  /**
   * Queries an LLM-spend proxy's /spend/logs for the current month's spend.
   *
   * Uses `LLM_SPEND_URL` env var — distinct from `OPENAI_BASE_URL` which
   * points at the inference API (api.openai.com/v1). When unset, falls back
   * to local `ai_audit_log` estimation via `queryLocalMonthlySpend()`.
   *
   * The /spend/logs endpoint returns a raw JSON array of individual request
   * records (each with `spend`, `model`, `startTime`, etc.), NOT an aggregated
   * summary. This method iterates the array, sums the `spend` field, and
   * groups by `model`.
   */
  async getMonthlySpend(): Promise<MonthlySpend> {
    const spendUrl = process.env.LLM_SPEND_URL ?? ''

    if (!spendUrl) {
      // No spend proxy configured — use local ai_audit_log estimation
      return this.queryLocalMonthlySpend()
    }

    try {
      const now = new Date()
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
      const endDate = now.toISOString().slice(0, 10)

      const url = new URL('/spend/logs', spendUrl)
      url.searchParams.set('start_date', startDate)
      url.searchParams.set('end_date', endDate)

      const spendApiKey = process.env.LLM_SPEND_API_KEY ?? this.openaiClient?.apiKey ?? ''
      const response = await fetch(url.toString(), {
        headers: {
          ...(spendApiKey ? { Authorization: `Bearer ${spendApiKey}` } : {}),
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          'LLM spend API returned non-OK — falling back to local estimation',
        )
        return this.queryLocalMonthlySpend()
      }

      const data = await response.json() as unknown

      // /spend/logs returns an array of individual request records
      if (Array.isArray(data)) {
        const by_model: Record<string, number> = {}
        let total = 0

        for (const row of data as Array<Record<string, unknown>>) {
          const rowSpend = typeof row.spend === 'number' ? row.spend
            : typeof row.total_cost === 'number' ? row.total_cost
            : 0
          total += rowSpend

          const model = typeof row.model === 'string' ? row.model : 'unknown'
          by_model[model] = (by_model[model] ?? 0) + rowSpend
        }

        return { total, by_model }
      }

      // Fallback: handle unexpected object formats gracefully
      const dataObj = data as Record<string, unknown>
      if (typeof dataObj.total_cost === 'number') {
        return { total: dataObj.total_cost, by_model: (dataObj.spend_by_model as Record<string, number>) ?? {} }
      }

      logger.warn({ data }, 'LLM spend response format not recognized — using local estimation')
      return this.queryLocalMonthlySpend()
    } catch (err) {
      logger.warn({ err }, 'Failed to query LLM spend API — using local estimation')
      return this.queryLocalMonthlySpend()
    }
  }

  /**
   * Estimates monthly spend from local ai_audit_log table.
   * Used as fallback when LLM_SPEND_URL is not configured or unreachable.
   */
  private async queryLocalMonthlySpend(): Promise<MonthlySpend> {
    try {
      const now = new Date()
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

      const rows = await this.db.execute<{
        model: string
        cost_usd: string
      }>(sql`
        SELECT
          model,
          COALESCE(SUM(cost_usd::numeric), 0)::text AS cost_usd
        FROM ai_audit_log
        WHERE created_at >= ${monthStart.toISOString()}::timestamptz
          AND error IS NULL
        GROUP BY model
      `)

      const by_model: Record<string, number> = {}
      let total = 0

      for (const row of rows.rows) {
        const cost = Number(row.cost_usd)
        by_model[row.model] = cost
        total += cost
      }

      return { total, by_model }
    } catch (err) {
      logger.warn({ err }, 'Failed to query local ai_audit_log for spend estimation')
      return { total: 0, by_model: {} }
    }
  }

  /**
   * Checks monthly spend against budget limits.
   * Only applies to LiteLLM/OpenAI API calls — Ollama (local) and Claude subscription are free.
   * Soft limit: logs a warning.
   * Hard limit: throws LLMBudgetExceededError.
   */
  private async checkBudget(clientUsed: AIClientType): Promise<void> {
    // Ollama (local) and Claude subscription calls are free — skip budget check
    if (clientUsed === 'anthropic' || clientUsed === 'ollama') return

    const aiConfig = this.configService.get('ai')
    const { soft_limit_usd, hard_limit_usd } = aiConfig.monthly_budget

    const spend = await this.getMonthlySpend()
    const total = spend.total

    if (total >= hard_limit_usd) {
      throw new LLMBudgetExceededError(
        `Monthly LLM spend $${total.toFixed(2)} has reached the hard limit of $${hard_limit_usd}`,
      )
    }

    if (total >= soft_limit_usd) {
      logger.warn(
        { spend: total, softLimit: soft_limit_usd },
        `Monthly LLM spend $${total.toFixed(2)} has reached the soft limit of $${soft_limit_usd}`,
      )
    }
  }

  /**
   * Logs an LLM call to ai_audit_log.
   */
  private async logAudit(params: {
    taskType: string
    model: string
    clientUsed: AIClientType
    costUsd: number | null
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
    durationMs?: number
    captureId?: string
    sessionId?: string
    error?: string
  }): Promise<void> {
    try {
      await this.db.insert(ai_audit_log).values({
        task_type: params.taskType,
        model: params.model,
        prompt_tokens: params.promptTokens ?? null,
        completion_tokens: params.completionTokens ?? null,
        total_tokens: params.totalTokens ?? null,
        duration_ms: params.durationMs ?? null,
        capture_id: params.captureId ?? null,
        session_id: params.sessionId ?? null,
        error: params.error ?? null,
        client_used: params.clientUsed,
        cost_usd: params.costUsd !== null ? String(params.costUsd) : null,
      })
    } catch (err) {
      // Audit log failures must not break the caller
      logger.error({ err }, 'Failed to write audit log')
    }
  }

  // ---------------------------------------------------------------------------
  // Anthropic SDK call path
  // ---------------------------------------------------------------------------

  /**
   * Calls the Anthropic Messages API and returns the text response.
   */
  private async completeViaAnthropic(
    prompt: string,
    model: string,
    options: LLMCompleteOptions,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    if (!this.anthropicClient) {
      throw new LLMGatewayError('Anthropic client not available')
    }

    const response = await this.anthropicClient.messages.create({
      model,
      max_tokens: options.maxTokens ?? 2048,
      messages: [{ role: 'user', content: prompt }],
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    })

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    }
  }

  /**
   * Determines if a fallback should be attempted on error.
   * Only on transient server errors — not on client errors or budget issues.
   * Used by completeWithTierFallback to decide whether to hop tiers.
   */
  private shouldAttemptFallback(err: unknown, _clientUsed: AIClientType): boolean {
    if (err instanceof Error) {
      const msg = err.message
      // Check for common transient error patterns
      return /429|500|502|503|rate.limit|overloaded|timeout|ECONNREFUSED|ETIMEDOUT/i.test(msg)
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Agent-loop client resolution (Option C: factory injection into runAgent)
  // ---------------------------------------------------------------------------

  /**
   * Compute the fallback chain for a primary tier key, walking `tier.fallback`
   * links in `model_tiers`. Does NOT include the primary itself. Stops when
   * `fallback` is null or a cycle is detected. Bounded by `MAX_FALLBACK_HOPS`.
   */
  private computeFallbackChain(primaryTierKey: string): Array<{ tierKey: string; tier: ModelTierEntry }> {
    const chain: Array<{ tierKey: string; tier: ModelTierEntry }> = []
    const seen = new Set<string>([primaryTierKey])
    let currentKey: string | null | undefined = this.configService.getModelTier(primaryTierKey)?.fallback

    while (currentKey && !seen.has(currentKey) && chain.length < MAX_FALLBACK_HOPS) {
      const tier = this.configService.getModelTier(currentKey)
      if (!tier) break
      chain.push({ tierKey: currentKey, tier })
      seen.add(currentKey)
      currentKey = tier.fallback
    }

    return chain
  }

  /**
   * Build an `AgentClientResolution` from a tier key — resolves the live SDK
   * client, model string, per-tier limits, and attaches a `fallback` closure
   * that walks the remaining chain (same-provider only).
   */
  private buildAgentResolution(
    tierKey: string,
    tier: ModelTierEntry,
    remainingChain: Array<{ tierKey: string; tier: ModelTierEntry }>,
  ): AgentClientResolution {
    const clientType = this.resolveProviderClient(tier.provider)

    let client: Anthropic | OpenAI
    if (clientType === 'anthropic') {
      if (!this.anthropicClient) {
        throw new LLMGatewayError(
          `Tier '${tierKey}' requires Anthropic client but none was supplied to LLMGatewayService`,
        )
      }
      client = this.anthropicClient
    } else {
      client = this.getClientForTier(tier, tierKey, clientType)
    }

    return {
      client,
      model: tier.model,
      tierKey,
      provider: tier.provider,
      maxTokens: tier.max_completion_tokens,
      timeoutMs: tier.timeout_ms,
      fallback: () => {
        // Pop the head of the remaining chain; return null when exhausted.
        const next = remainingChain.shift()
        if (!next) return null
        return this.buildAgentResolution(next.tierKey, next.tier, remainingChain)
      },
    }
  }

  /**
   * Resolve a task name to a live agent-loop client bundle.
   *
   * Used by multi-turn skills (e.g., `email-compose`) that run their own
   * tool-use loop via `runAgent()`. The gateway pre-computes tier selection
   * and returns an `AgentClientResolution`; the agent loop owns dispatch but
   * can call `resolution.fallback()` on transient errors to hop tiers.
   *
   * Fallback chain is filtered to **same-provider tiers only**: cross-provider
   * fallback mid-loop (e.g., Anthropic→OpenAI) would break tool-use block
   * compatibility. A separate design is required for cross-provider agent
   * fallback — see IMPLEMENTATION_PLAN.md flagged follow-up.
   *
   * @throws {ModelResolverError} if the task has no tier mapping
   * @throws {LLMGatewayError} if the primary tier's required client is unavailable
   */
  resolveAgentClient(taskName: string): AgentClientResolution {
    const primary = this.resolveByTask(taskName)
    if (!primary) {
      throw new ModelResolverError(
        `Task '${taskName}' has no routing entry — add it to task_routing: in config/ai-routing.yaml.`,
        taskName,
      )
    }

    // Filter fallback chain to tiers sharing the primary's provider.
    // Prevents cross-provider swap mid-agent-loop (tool-use format mismatch).
    const fullChain = this.computeFallbackChain(primary.tierKey)
    const sameProviderChain = fullChain.filter(({ tier }) => tier.provider === primary.tier.provider)

    return this.buildAgentResolution(primary.tierKey, primary.tier, [...sameProviderChain])
  }

  /**
   * Record a completed agent-loop run in `ai_audit_log`.
   *
   * Used by multi-turn skills (e.g., `email-compose`) that manage their own
   * loop via `runAgent()` and can't lean on `completeByTask`'s per-call
   * audit log. One row per agent run (not per iteration) — `duration_ms`
   * covers the full loop wall-clock.
   *
   * Failures are swallowed (logged, not thrown) — audit-log failures must
   * never break the caller's success path. Same policy as `logAudit`.
   */
  async recordAgentCompletion(
    taskName: string,
    tierKey: string,
    result: {
      iterations: number
      tokenUsage: { input: number; output: number }
      latencyMs: number
    },
  ): Promise<void> {
    const tier = this.configService.getModelTier(tierKey)
    const model = tier?.model ?? 'unknown'
    const clientUsed: AIClientType = tier ? this.resolveProviderClient(tier.provider) : 'litellm'
    const costUsd = estimateTierCostUsd(clientUsed, result.tokenUsage.input, result.tokenUsage.output)

    await this.logAudit({
      taskType: taskName,
      model,
      clientUsed,
      costUsd,
      promptTokens: result.tokenUsage.input,
      completionTokens: result.tokenUsage.output,
      totalTokens: result.tokenUsage.input + result.tokenUsage.output,
      durationMs: result.latencyMs,
    })

    logger.info(
      {
        task: taskName,
        tierKey,
        model,
        iterations: result.iterations,
        inputTokens: result.tokenUsage.input,
        outputTokens: result.tokenUsage.output,
        latencyMs: result.latencyMs,
      },
      '[llm-gateway] agent completion recorded',
    )
  }
}
