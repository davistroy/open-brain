import { join } from 'node:path'
import type OpenAI from 'openai'
import type Anthropic from '@anthropic-ai/sdk'
import { createOpenAIClient, TemplateCache, PushoverService } from '@open-brain/shared'
import type { LLMGatewayService } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, LLMSkillOpts } from './types.js'

/**
 * LLMSkill — abstract base class for skills that use LLM inference.
 *
 * Extends BaseSkill with the full LLM dependency stack:
 * - `litellmClient` — OpenAI SDK client for LiteLLM/OpenAI API
 * - `anthropicClient` — Anthropic SDK client (optional)
 * - `llmGateway` — LLMGatewayService for task-based tier routing (optional)
 * - `templates` — TemplateCache for prompt templates
 * - `coreApiUrl` — URL for internal API calls (e.g., saving captures)
 *
 * Constructor initialization mirrors the pattern in DailyConnectionsSkill:
 * uses createOpenAIClient() for the OpenAI SDK client, falls back to env vars for
 * config, and provides sensible defaults for promptsDir and coreApiUrl.
 */
export abstract class LLMSkill<TInput, TResult extends BaseResult> extends BaseSkill<TInput, TResult> {
  protected litellmClient: OpenAI | null
  protected anthropicClient: Anthropic | null
  protected llmGateway: LLMGatewayService | null
  protected templates: TemplateCache
  protected promptsDir: string
  protected coreApiUrl: string

  constructor(skillName: string, opts: LLMSkillOpts) {
    super(skillName, {
      db: opts.db,
      pushover: opts.pushover ?? new PushoverService({ onError: 'throw' }),
    })

    // OpenAI SDK client: use provided client, or create one from base URL + API key
    this.litellmClient = opts.litellmClient ?? createOpenAIClient({
      baseUrl: opts.litellmBaseUrl,
      apiKey: opts.litellmApiKey,
      timeout: 'extended',
      maxRetries: 0,
    })

    this.anthropicClient = opts.anthropicClient ?? null
    this.llmGateway = opts.llmGateway ?? null

    // Template cache: use provided instance, or create from promptsDir
    this.promptsDir = opts.promptsDir ?? join(process.cwd(), 'config', 'prompts')
    this.templates = opts.templates ?? new TemplateCache(this.promptsDir)

    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
  }

  /**
   * Convenience: renders a prompt template with variable substitution.
   * Delegates to TemplateCache.render() which handles caching and
   * disk I/O.
   */
  protected renderTemplate(name: string, vars: Record<string, string>): string {
    return this.templates.render(name, vars)
  }
}
