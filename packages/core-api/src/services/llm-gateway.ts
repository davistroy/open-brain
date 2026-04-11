import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import {
  ServiceUnavailableError,
  ai_audit_log,
  logger,
  getModelEntry,
} from '@open-brain/shared'
import type { ConfigService, Database, TemplateCache, AIModelEntry, AIClientType } from '@open-brain/shared'

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

export type LLMModelAlias = 'fast' | 'synthesis' | 'governance' | 'intent' | 'conversation'

export interface LLMCompleteOptions {
  temperature?: number
  maxTokens?: number
  captureId?: string
  sessionId?: string
}

export interface MonthlySpend {
  total: number
  by_model: Record<string, number>
}

/**
 * LLMGatewayService wraps both the OpenAI SDK (LiteLLM proxy) and the
 * Anthropic SDK (Claude subscription). Routes LLM calls based on the
 * `client` field in ai-routing.yaml.
 *
 * - Claude SDK: inference tasks (fast, synthesis, governance, conversation, intent)
 * - LiteLLM/OpenAI SDK: embeddings and local models
 *
 * Callers pass taskType/modelAlias — routing is internal and transparent.
 * Audit log records which client was used and cost ($0 for Claude subscription).
 */
export class LLMGatewayService {
  private litellmClient: OpenAI
  private anthropicClient: Anthropic | null
  private configService: ConfigService
  private db: Database
  private templateCache: TemplateCache

  constructor(
    litellmClient: OpenAI,
    configService: ConfigService,
    db: Database,
    templateCache: TemplateCache,
    anthropicClient?: Anthropic | null,
  ) {
    this.litellmClient = litellmClient
    this.configService = configService
    this.db = db
    this.templateCache = templateCache
    this.anthropicClient = anthropicClient ?? null

    if (this.anthropicClient) {
      logger.info('LLMGatewayService: Anthropic client available — dual-client routing enabled')
    } else {
      logger.info('LLMGatewayService: Anthropic client not available — LiteLLM-only mode')
    }
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
    // Fallback: if anthropic is preferred but client is null, use litellm
    return 'litellm'
  }

  /**
   * Queries LiteLLM /spend/logs for the current month's spend.
   * Returns zero values if the endpoint is unavailable — non-critical.
   */
  async getMonthlySpend(): Promise<MonthlySpend> {
    try {
      const aiConfig = this.configService.get('ai')
      const response = await fetch(`${aiConfig.litellm_url}/spend/logs`, {
        headers: {
          Authorization: `Bearer ${this.litellmClient.apiKey}`,
        },
      })
      if (!response.ok) {
        return { total: 0, by_model: {} }
      }
      const data = await response.json() as { total_cost?: number; spend_by_model?: Record<string, number> }
      return {
        total: data.total_cost ?? 0,
        by_model: data.spend_by_model ?? {},
      }
    } catch {
      return { total: 0, by_model: {} }
    }
  }

  /**
   * Checks monthly spend against budget limits.
   * Only applies to LiteLLM calls — Claude subscription calls are free.
   * Soft limit ($30): logs a warning.
   * Hard limit ($50): throws LLMBudgetExceededError.
   */
  private async checkBudget(clientUsed: AIClientType): Promise<void> {
    // Claude subscription calls are free — skip budget check
    if (clientUsed === 'anthropic') return

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
  // LiteLLM/OpenAI SDK call path
  // ---------------------------------------------------------------------------

  /**
   * Calls the OpenAI SDK (pointed at LiteLLM proxy) and returns the text response.
   */
  private async completeViaLiteLLM(
    prompt: string,
    model: string,
    options: LLMCompleteOptions,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; totalTokens: number }> {
    const response = await this.litellmClient.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? 0.2,
      max_completion_tokens: options.maxTokens ?? 2048,
    })

    const usage = response.usage
    const text = response.choices[0]?.message?.content ?? ''

    return {
      text,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
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
        const result = await this.completeViaLiteLLM(prompt, model, options)
        text = result.text
        promptTokens = result.promptTokens
        completionTokens = result.completionTokens
        totalTokens = result.totalTokens
      }

      const durationMs = Date.now() - startMs

      // Cost: $0 for Anthropic (subscription), estimated for LiteLLM
      const costUsd = clientUsed === 'anthropic'
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
   * Determines if a fallback to the other client should be attempted.
   * Only on transient server errors — not on client errors or budget issues.
   */
  private shouldAttemptFallback(err: unknown, clientUsed: AIClientType): boolean {
    // Can only fall back to anthropic if the client exists
    if (clientUsed === 'litellm' && !this.anthropicClient) return false

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
      const result = await this.completeViaLiteLLM(prompt, model, options)
      text = result.text
      promptTokens = result.promptTokens
      completionTokens = result.completionTokens
      totalTokens = result.totalTokens
    }

    const durationMs = Date.now() - startMs
    const costUsd = fallbackClient === 'anthropic' ? 0 : estimateCostUsd(entry, promptTokens, completionTokens)

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
