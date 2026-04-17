import OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import { sql } from 'drizzle-orm'
import { ServiceUnavailableError } from '../utils/errors.js'
import { ai_audit_log } from '../schema/index.js'
import { logger } from '../lib/logger.js'
import { getModelEntry } from '../types/config.js'
import type { ConfigService } from '../config/loader.js'
import type { Database } from '../db/index.js'
import type { TemplateCache } from '../lib/prompt-template.js'
import type { AIModelEntry, AIClientType, ModelTierEntry } from '../types/config.js'

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
 * Estimate cost for LiteLLM calls using config-defined rates.
 * Anthropic calls are always $0 (subscription-covered).
 */
function estimateCostUsd(entry: AIModelEntry, promptTokens: number, completionTokens: number): number {
  return (promptTokens / 1000) * entry.cost_per_1k_input
    + (completionTokens / 1000) * entry.cost_per_1k_output
}

/**
 * Estimate cost for tier-based calls. Ollama and Anthropic are $0.
 * LiteLLM/OpenAI uses the legacy cost rates if an alias mapping exists,
 * otherwise defaults to $0 (cost tracking for tier-based calls will be
 * refined as tier-specific rates are added to config).
 */
function estimateTierCostUsd(clientUsed: AIClientType, _promptTokens: number, _completionTokens: number): number {
  if (clientUsed === 'ollama' || clientUsed === 'anthropic') return 0
  // Without per-tier cost config, LiteLLM/OpenAI costs default to 0.
  // The ai_audit_log records all calls, enabling retroactive cost analysis.
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

export type LLMModelAlias = 'fast' | 'synthesis' | 'governance' | 'intent' | 'conversation'

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
 * LLMGatewayService wraps three LLM backends: Ollama (local), Anthropic (subscription),
 * and LiteLLM/OpenAI (API). Routes calls via two mechanisms:
 *
 * 1. **Legacy alias-based**: `complete(prompt, modelAlias)` uses the `models:` map in
 *    ai-routing.yaml. Backward-compatible with all existing call sites.
 *
 * 2. **Task-based tier routing**: `completeByTask(prompt, taskName)` uses `task_routing`
 *    + `model_tiers` sections. Supports three-way dispatch with automatic fallback
 *    chain (max 2 hops, e.g. T0 Ollama -> T1 Haiku -> T2 Sonnet).
 *
 * Audit log records which client was used and cost ($0 for Ollama and Claude subscription).
 */
export class LLMGatewayService {
  private litellmClient: OpenAI
  private anthropicClient: Anthropic | null
  private ollamaClient: OpenAI | null
  private configService: ConfigService
  private db: Database
  private templateCache: TemplateCache
  /** Cache of OpenAI SDK clients for tiers with custom base_url (e.g., Jetson) */
  private tierClientCache: Map<string, OpenAI> = new Map()

  constructor(
    litellmClient: OpenAI,
    configService: ConfigService,
    db: Database,
    templateCache: TemplateCache,
    anthropicClient?: Anthropic | null,
    ollamaClient?: OpenAI | null,
  ) {
    this.litellmClient = litellmClient
    this.configService = configService
    this.db = db
    this.templateCache = templateCache
    this.anthropicClient = anthropicClient ?? null
    this.ollamaClient = ollamaClient ?? null

    const clients: string[] = ['LiteLLM']
    if (this.anthropicClient) clients.push('Anthropic')
    if (this.ollamaClient) clients.push('Ollama')
    logger.info(
      { clients },
      `LLMGatewayService: ${clients.length}-client routing enabled (${clients.join(', ')})`,
    )
  }

  /**
   * Resolves a model alias to its full config entry from ai-routing.yaml.
   */
  private getEntry(alias: LLMModelAlias): AIModelEntry {
    const aiConfig = this.configService.get('ai')
    return getModelEntry(aiConfig, alias)
  }

  /**
   * Determines which client to use for a given model alias.
   * Falls back to litellm if the preferred client is unavailable.
   */
  private resolveClient(entry: AIModelEntry): AIClientType {
    if (entry.client === 'anthropic' && this.anthropicClient) {
      return 'anthropic'
    }
    if (entry.client === 'ollama' && this.ollamaClient) {
      return 'ollama'
    }
    // Fallback: if preferred client is null, use litellm
    return 'litellm'
  }

  // ---------------------------------------------------------------------------
  // Task-based tier routing (v2 three-way dispatch)
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
   * Returns the OpenAI SDK client for a given resolved client type.
   * Ollama and LiteLLM both use OpenAI SDK clients (different base URLs).
   */
  private getOpenAIClient(clientType: AIClientType): OpenAI {
    if (clientType === 'ollama' && this.ollamaClient) return this.ollamaClient
    return this.litellmClient
  }

  /**
   * Returns the OpenAI SDK client for a specific tier, respecting its base_url.
   *
   * For 'openai_compat' provider tiers (custom OpenAI-compatible endpoints like
   * Jetson llama.cpp), creates a dedicated cached client using the tier's base_url.
   * For 'ollama' tiers, uses the pre-constructed ollamaClient (from OLLAMA_URL env).
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

    // ollama, litellm, openai — use pre-constructed clients
    return this.getOpenAIClient(clientType)
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
   * Queries LiteLLM /spend/logs for the current month's spend.
   *
   * Uses LITELLM_SPEND_URL env var (separate from litellm_url which points to
   * the inference API at api.openai.com/v1). When LITELLM_SPEND_URL is unset,
   * falls back to local ai_audit_log estimation via queryLocalMonthlySpend().
   *
   * The /spend/logs endpoint returns a raw JSON array of individual request
   * records (each with `spend`, `model`, `startTime`, etc.), NOT an aggregated
   * summary. This method iterates the array, sums the `spend` field, and
   * groups by `model`.
   */
  async getMonthlySpend(): Promise<MonthlySpend> {
    const spendUrl = process.env.LITELLM_SPEND_URL ?? ''

    if (!spendUrl) {
      // No LiteLLM spend endpoint configured — use local ai_audit_log estimation
      return this.queryLocalMonthlySpend()
    }

    try {
      const now = new Date()
      const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
      const endDate = now.toISOString().slice(0, 10)

      const url = new URL('/spend/logs', spendUrl)
      url.searchParams.set('start_date', startDate)
      url.searchParams.set('end_date', endDate)

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.litellmClient.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        logger.warn(
          { status: response.status },
          'LiteLLM spend API returned non-OK — falling back to local estimation',
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

      logger.warn({ data }, 'LiteLLM spend response format not recognized — using local estimation')
      return this.queryLocalMonthlySpend()
    } catch (err) {
      logger.warn({ err }, 'Failed to query LiteLLM spend API — using local estimation')
      return this.queryLocalMonthlySpend()
    }
  }

  /**
   * Estimates monthly spend from local ai_audit_log table.
   * Used as fallback when LITELLM_SPEND_URL is not configured or unreachable.
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

  // ---------------------------------------------------------------------------
  // Public API — unchanged interface
  // ---------------------------------------------------------------------------

  /**
   * Calls the appropriate LLM provider with the given model alias and prompt.
   * Routes to Anthropic SDK or LiteLLM based on ai-routing.yaml config.
   * Logs to ai_audit_log on success or failure.
   * Returns the completion text.
   */
  async complete(
    prompt: string,
    modelAlias: LLMModelAlias,
    options: LLMCompleteOptions = {},
  ): Promise<string> {
    const entry = this.getEntry(modelAlias)
    const clientUsed = this.resolveClient(entry)
    const model = entry.model

    await this.checkBudget(clientUsed)

    const startMs = Date.now()

    try {
      let text: string
      let promptTokens = 0
      let completionTokens = 0
      let totalTokens = 0

      if (clientUsed === 'anthropic') {
        const result = await this.completeViaAnthropic(prompt, model, options)
        text = result.text
        promptTokens = result.inputTokens
        completionTokens = result.outputTokens
        totalTokens = promptTokens + completionTokens
      } else {
        // Both 'litellm' and 'ollama' use the OpenAI SDK
        const openaiClient = this.getOpenAIClient(clientUsed)
        const result = await this.completeViaOpenAISDK(openaiClient, prompt, model, options)
        text = result.text
        promptTokens = result.promptTokens
        completionTokens = result.completionTokens
        totalTokens = result.totalTokens
      }

      const durationMs = Date.now() - startMs

      // Cost: $0 for Anthropic (subscription) and Ollama (local), estimated for LiteLLM
      const costUsd = (clientUsed === 'anthropic' || clientUsed === 'ollama')
        ? 0
        : estimateCostUsd(entry, promptTokens, completionTokens)

      await this.logAudit({
        taskType: modelAlias,
        model,
        clientUsed,
        costUsd,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs,
        captureId: options.captureId,
        sessionId: options.sessionId,
      })

      // Warn on expensive LiteLLM calls
      if (clientUsed === 'litellm' && costUsd > 0.10) {
        logger.warn(
          { costUsd, modelAlias, totalTokens },
          `Single LiteLLM call estimated cost $${costUsd.toFixed(4)} for alias '${modelAlias}' (${totalTokens} tokens)`,
        )
      }

      return text
    } catch (err) {
      const durationMs = Date.now() - startMs

      if (err instanceof LLMBudgetExceededError) throw err

      const message = err instanceof Error ? err.message : String(err)

      await this.logAudit({
        taskType: modelAlias,
        model,
        clientUsed,
        costUsd: null,
        durationMs,
        captureId: options.captureId,
        sessionId: options.sessionId,
        error: message,
      })

      // Attempt fallback to the other client on transient errors (429, 500, 502, 503)
      if (this.shouldAttemptFallback(err, clientUsed)) {
        const fallbackClient: AIClientType = clientUsed === 'anthropic' ? 'litellm' : 'anthropic'
        logger.warn(
          { modelAlias, primaryClient: clientUsed, fallbackClient, error: message },
          `Primary client ${clientUsed} failed — attempting fallback to ${fallbackClient}`,
        )

        try {
          return await this.completeFallback(prompt, model, modelAlias, fallbackClient, options)
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
          logger.error(
            { modelAlias, fallbackClient, error: fallbackMsg },
            `Fallback to ${fallbackClient} also failed`,
          )
          // Fall through to throw the original error
        }
      }

      throw new LLMGatewayError(`LLM request failed for alias '${modelAlias}' (${clientUsed}): ${message}`)
    }
  }

  /**
   * Determines if a fallback should be attempted on error.
   * Only on transient server errors — not on client errors or budget issues.
   */
  private shouldAttemptFallback(err: unknown, _clientUsed: AIClientType): boolean {
    if (err instanceof Error) {
      const msg = err.message
      // Check for common transient error patterns
      return /429|500|502|503|rate.limit|overloaded|timeout|ECONNREFUSED|ETIMEDOUT/i.test(msg)
    }
    return false
  }

  /**
   * Attempt a completion via the fallback client.
   */
  private async completeFallback(
    prompt: string,
    model: string,
    modelAlias: LLMModelAlias,
    fallbackClient: AIClientType,
    options: LLMCompleteOptions,
  ): Promise<string> {
    const startMs = Date.now()
    const entry = this.getEntry(modelAlias)

    let text: string
    let promptTokens = 0
    let completionTokens = 0
    let totalTokens = 0

    if (fallbackClient === 'anthropic') {
      const result = await this.completeViaAnthropic(prompt, model, options)
      text = result.text
      promptTokens = result.inputTokens
      completionTokens = result.outputTokens
      totalTokens = promptTokens + completionTokens
    } else {
      const openaiClient = this.getOpenAIClient(fallbackClient)
      const result = await this.completeViaOpenAISDK(openaiClient, prompt, model, options)
      text = result.text
      promptTokens = result.promptTokens
      completionTokens = result.completionTokens
      totalTokens = result.totalTokens
    }

    const durationMs = Date.now() - startMs
    const costUsd = (fallbackClient === 'anthropic' || fallbackClient === 'ollama')
      ? 0
      : estimateCostUsd(entry, promptTokens, completionTokens)

    await this.logAudit({
      taskType: `${modelAlias}:fallback`,
      model,
      clientUsed: fallbackClient,
      costUsd,
      promptTokens,
      completionTokens,
      totalTokens,
      durationMs,
      captureId: options.captureId,
      sessionId: options.sessionId,
    })

    logger.info(
      { modelAlias, fallbackClient, durationMs, totalTokens },
      `Fallback to ${fallbackClient} succeeded`,
    )

    return text
  }

  /**
   * Loads a versioned prompt template from config/prompts/{name}.v1.txt,
   * substitutes {{variable}} placeholders with vars, then calls complete().
   *
   * Template files use {{variable}} syntax for substitution.
   * Missing variables are left as-is; extra vars are silently ignored.
   */
  async completeWithPromptTemplate(
    templateName: string,
    vars: Record<string, string>,
    modelAlias: string,
    options: LLMCompleteOptions = {},
  ): Promise<string> {
    try {
      const rendered = this.templateCache.render(`${templateName}.v1.txt`, vars)
      return this.complete(rendered, modelAlias as LLMModelAlias, options)
    } catch (err) {
      if (err instanceof Error && err.message.includes('Prompt template not found')) {
        throw new LLMGatewayError(err.message)
      }
      throw err
    }
  }
}
