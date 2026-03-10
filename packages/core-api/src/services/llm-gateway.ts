import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import OpenAI from 'openai'
import { ServiceUnavailableError, ai_audit_log } from '@open-brain/shared'
import type { ConfigService, Database } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

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

const LLM_TIMEOUT_MS = 60_000

/**
 * Approximate cost per 1K tokens by model alias (USD).
 * LiteLLM tracks actual spend, but we estimate here for the circuit breaker.
 * These are conservative estimates; real costs are reported via getMonthlySpend().
 */
const COST_PER_1K_TOKENS: Record<string, number> = {
  fast: 0.0002,
  synthesis: 0.003,
  governance: 0.003,
  intent: 0.0002,
  // fallback for unknown aliases
  default: 0.001,
}

function estimateCostUsd(modelAlias: string, totalTokens: number): number {
  const rate = COST_PER_1K_TOKENS[modelAlias] ?? COST_PER_1K_TOKENS.default!
  return (totalTokens / 1000) * rate
}

export type LLMModelAlias = 'fast' | 'synthesis' | 'governance' | 'intent'

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
 * LLMGatewayService wraps the OpenAI SDK pointed at the LiteLLM proxy.
 * Resolves model aliases from ai-routing.yaml, logs every call to ai_audit_log,
 * and enforces the monthly budget circuit breaker (soft: warn, hard: throw).
 */
export class LLMGatewayService {
  private client: OpenAI
  private configService: ConfigService
  private db: Database
  private promptsDir: string

  constructor(
    litellmBaseUrl: string,
    litellmApiKey: string,
    configService: ConfigService,
    db: Database,
    promptsDir: string,
  ) {
    this.client = new OpenAI({
      baseURL: litellmBaseUrl,
      apiKey: litellmApiKey,
      timeout: LLM_TIMEOUT_MS,
    })
    this.configService = configService
    this.db = db
    this.promptsDir = promptsDir
  }

  /**
   * Resolves a model alias to the LiteLLM model string from ai-routing.yaml.
   */
  private resolveModel(alias: LLMModelAlias): string {
    const aiConfig = this.configService.get('ai')
    return aiConfig.models[alias]
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
          Authorization: `Bearer ${this.client.apiKey}`,
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
   * Soft limit ($30): logs a warning.
   * Hard limit ($50): throws LLMBudgetExceededError.
   */
  private async checkBudget(): Promise<void> {
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
      })
    } catch (err) {
      // Audit log failures must not break the caller
      logger.error({ err }, 'Failed to write audit log')
    }
  }

  /**
   * Calls LiteLLM with the given model alias and prompt.
   * Logs to ai_audit_log on success or failure.
   * Returns the completion text.
   */
  async complete(
    prompt: string,
    modelAlias: LLMModelAlias,
    options: LLMCompleteOptions = {},
  ): Promise<string> {
    await this.checkBudget()

    const model = this.resolveModel(modelAlias)
    const startMs = Date.now()

    try {
      // Disable thinking/reasoning mode for structured output (Qwen3.5 etc.)
      const response = await this.client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 2048,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extra_body: { chat_template_kwargs: { enable_thinking: false } },
      } as any)

      const durationMs = Date.now() - startMs
      const usage = response.usage
      const text = response.choices[0]?.message?.content ?? ''

      await this.logAudit({
        taskType: modelAlias,
        model,
        promptTokens: usage?.prompt_tokens,
        completionTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
        durationMs,
        captureId: options.captureId,
        sessionId: options.sessionId,
      })

      // Warn if we're approaching budget even after a successful call
      if (usage?.total_tokens) {
        const estimatedCost = estimateCostUsd(modelAlias, usage.total_tokens)
        if (estimatedCost > 0.10) {
          logger.warn(
            { estimatedCost, modelAlias, totalTokens: usage.total_tokens },
            `Single call estimated cost $${estimatedCost.toFixed(4)} for alias '${modelAlias}' (${usage.total_tokens} tokens)`,
          )
        }
      }

      return text
    } catch (err) {
      const durationMs = Date.now() - startMs

      if (err instanceof LLMBudgetExceededError) throw err

      const message = err instanceof Error ? err.message : String(err)

      await this.logAudit({
        taskType: modelAlias,
        model,
        durationMs,
        captureId: options.captureId,
        sessionId: options.sessionId,
        error: message,
      })

      throw new LLMGatewayError(`LiteLLM request failed for alias '${modelAlias}': ${message}`)
    }
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
    const templatePath = join(this.promptsDir, `${templateName}.v1.txt`)

    if (!existsSync(templatePath)) {
      throw new LLMGatewayError(`Prompt template not found: ${templatePath}`)
    }

    let template = readFileSync(templatePath, 'utf8')

    for (const [key, value] of Object.entries(vars)) {
      template = template.replaceAll(`{{${key}}}`, value)
    }

    return this.complete(template, modelAlias as LLMModelAlias, options)
  }
}
