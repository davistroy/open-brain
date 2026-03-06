/**
 * IntentRouter — classifies incoming Slack messages into one of four intent categories:
 * CAPTURE, QUERY, COMMAND, or CONVERSATION.
 *
 * Classification strategy (in order):
 * 1. Prefix-based detection — instant, zero-latency, never fails
 * 2. Natural question pattern matching — heuristic, no external calls
 * 3. LLM classification via LiteLLM `intent` alias — for genuinely ambiguous messages
 * 4. Graceful degradation to prefix-only (CAPTURE as default) if LiteLLM is unavailable
 */

export type IntentType = 'capture' | 'query' | 'command' | 'conversation'

export interface IntentResult {
  intent: IntentType
  confidence: number
  prefix_matched: boolean
  method: 'prefix' | 'pattern' | 'llm' | 'default'
}

export interface IntentContext {
  /** Slack channel ID — used to weight intent (e.g., DMs may be more conversational) */
  channel_id?: string
  /** Whether the message is a thread reply */
  is_thread_reply?: boolean
  /** Whether the bot was @mentioned */
  is_mention?: boolean
}

export interface IntentRouterConfig {
  litellm_url: string
  litellm_api_key: string
  /** Model alias for intent classification — resolves to backing model on LiteLLM */
  intent_model?: string
  /** Timeout in ms for LLM intent classification call. Default: 5000 */
  llm_timeout_ms?: number
}

/**
 * Question word patterns that suggest QUERY intent without an explicit `?` prefix.
 * Checked only when no prefix is matched.
 */
const QUESTION_PATTERNS = [
  /^(what|who|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|have|has|had)\s/i,
  /\?$/,
  /^(tell me|show me|find|search|look up|get me)/i,
]

/**
 * COMMAND prefixes (after stripping `!`).
 * Commands are imperative directives to the bot itself, not content to capture.
 */
const COMMAND_NAMES = new Set([
  'stats', 'status', 'help', 'brief', 'budget', 'views', 'types', 'ping',
])

/**
 * LLM system prompt for intent classification.
 * Designed to be fast — the model only needs to output a single word.
 */
const INTENT_SYSTEM_PROMPT = `You classify Slack messages into exactly one of four categories:
- capture: information, thoughts, decisions, observations, tasks, or anything the user wants to remember
- query: questions or search requests directed at the knowledge base
- command: bot control commands (stats, help, status, brief, budget)
- conversation: casual chat, greetings, confirmations, or small talk

Reply with exactly one word: capture, query, command, or conversation.`

export class IntentRouter {
  private readonly litellmUrl: string
  private readonly litellmApiKey: string
  private readonly intentModel: string
  private readonly llmTimeoutMs: number

  constructor(config: IntentRouterConfig) {
    this.litellmUrl = config.litellm_url.replace(/\/$/, '')
    this.litellmApiKey = config.litellm_api_key
    this.intentModel = config.intent_model ?? 'intent'
    this.llmTimeoutMs = config.llm_timeout_ms ?? 5_000
  }

  /**
   * Classifies a Slack message into an intent category.
   *
   * @param text - Raw message text (including any prefix characters)
   * @param context - Optional Slack context for improved classification
   * @returns IntentResult with intent type, confidence, and classification method
   */
  async classify(text: string, context?: IntentContext): Promise<IntentResult> {
    const trimmed = text.trim()

    // --- Step 1: Prefix-based detection (immediate, no LLM) ---
    const prefixResult = this.classifyByPrefix(trimmed, context)
    if (prefixResult !== null) {
      return prefixResult
    }

    // --- Step 2: Natural question pattern matching ---
    const patternResult = this.classifyByPattern(trimmed)
    if (patternResult !== null) {
      // High-confidence pattern match — skip LLM
      if (patternResult.confidence >= 0.8) {
        return patternResult
      }
    }

    // --- Step 3: LLM classification for ambiguous messages ---
    try {
      const llmResult = await this.classifyByLLM(trimmed)
      return llmResult
    } catch {
      // LiteLLM unavailable — degrade gracefully to pattern result or CAPTURE default
      if (patternResult !== null) {
        return { ...patternResult, method: 'pattern' }
      }
      return {
        intent: 'capture',
        confidence: 0.5,
        prefix_matched: false,
        method: 'default',
      }
    }
  }

  /**
   * Step 1: Prefix-based classification. Returns null if no prefix matched.
   *
   * Prefixes:
   * - `?` → QUERY (strip prefix, search the brain)
   * - `!` → COMMAND (strip prefix, execute bot command)
   * - `@Open Brain` → QUERY (treat @mention as a question/search)
   */
  private classifyByPrefix(text: string, context?: IntentContext): IntentResult | null {
    // `?` query prefix
    if (text.startsWith('?')) {
      return {
        intent: 'query',
        confidence: 1.0,
        prefix_matched: true,
        method: 'prefix',
      }
    }

    // `!` command prefix
    if (text.startsWith('!')) {
      const commandName = text.slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
      if (COMMAND_NAMES.has(commandName)) {
        return {
          intent: 'command',
          confidence: 1.0,
          prefix_matched: true,
          method: 'prefix',
        }
      }
      // Unknown `!` prefix — treat as CAPTURE (could be markdown emphasis, etc.)
      return null
    }

    // @mention directed at the bot → treat as QUERY
    if (context?.is_mention === true) {
      return {
        intent: 'query',
        confidence: 0.95,
        prefix_matched: true,
        method: 'prefix',
      }
    }

    return null
  }

  /**
   * Step 2: Heuristic pattern matching for question-like text.
   * Returns null if no pattern matched.
   */
  private classifyByPattern(text: string): IntentResult | null {
    for (const pattern of QUESTION_PATTERNS) {
      if (pattern.test(text)) {
        return {
          intent: 'query',
          confidence: 0.75,
          prefix_matched: false,
          method: 'pattern',
        }
      }
    }
    return null
  }

  /**
   * Step 3: LLM-based intent classification via LiteLLM `intent` alias.
   * Throws on network error or timeout — caller handles degradation.
   */
  private async classifyByLLM(text: string): Promise<IntentResult> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.llmTimeoutMs)

    let response: Response
    try {
      response = await fetch(`${this.litellmUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.litellmApiKey}`,
        },
        body: JSON.stringify({
          model: this.intentModel,
          messages: [
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          max_tokens: 10,
          temperature: 0,
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new Error(`LiteLLM intent classification failed: HTTP ${response.status}`)
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }

    const raw = data.choices?.[0]?.message?.content?.trim().toLowerCase() ?? ''
    const intent = this.parseIntentLabel(raw)

    return {
      intent,
      confidence: 0.9,
      prefix_matched: false,
      method: 'llm',
    }
  }

  /**
   * Maps raw LLM output to a valid IntentType, defaulting to 'capture' for
   * any unrecognized output.
   */
  private parseIntentLabel(label: string): IntentType {
    switch (label) {
      case 'query':
        return 'query'
      case 'command':
        return 'command'
      case 'conversation':
        return 'conversation'
      default:
        return 'capture'
    }
  }
}
