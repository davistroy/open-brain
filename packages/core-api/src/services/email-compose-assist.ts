import type Anthropic from '@anthropic-ai/sdk'
import { sql } from 'drizzle-orm'
import {
  logger,
  resolveTaskModel,
  runAgent,
  ServiceUnavailableError,
} from '@open-brain/shared'
import type {
  AgentTool,
  ConfigService,
  Database,
  ResolvedTaskModel,
} from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface ExistingDraft {
  to?: string[]
  cc?: string[]
  subject?: string
  body?: string
}

export interface EmailComposeAssistInput {
  instruction: string
  existingDraft?: ExistingDraft
}

export interface EmailComposeAssistResult {
  body: string
  subject?: string
  to?: string[]
  cc?: string[]
}

// ============================================================
// EmailComposeAssistService
// ============================================================

/**
 * Synchronous email-compose assistant backing POST /api/v1/email/compose-draft.
 *
 * Mirrors the agent-based approach used by the worker-side email-compose skill
 * (packages/workers/src/skills/email-compose.ts) but returns the proposed draft
 * fields directly to the caller instead of persisting a draft. That lets the
 * web drawer keep the draft in its local form state and only persist via the
 * existing POST/PATCH /email/drafts endpoints when the user chooses to save.
 *
 * Tools exposed to Claude:
 *  - search_brain: ILIKE search over captures.content for context
 *  - get_entity:   entity lookup by name (for contact/context info)
 *  - submit_draft: capture structured output (body, optional subject/to/cc)
 *
 * The service is intentionally decoupled from the worker skill to avoid a
 * circular workspace dependency (core-api does not depend on @open-brain/workers).
 */
export class EmailComposeAssistService {
  /**
   * Resolved `{ model, tierKey }` for the `email_compose` task alias, looked
   * up once at construction time via `config/ai-routing.yaml`. Caching here
   * avoids a per-request config read on every compose call and makes model
   * drift a startup-time failure instead of a request-time one.
   */
  private readonly resolvedModel: ResolvedTaskModel

  constructor(
    private db: Database,
    private anthropicClient: Anthropic | null,
    configService: ConfigService,
  ) {
    // Resolve the model for the `email_compose` task alias at INIT time.
    // Fail loud on ModelResolverError — no silent fallback to a hardcoded
    // default, because a silent fallback is exactly what landed the
    // now-removed `'claude-sonnet-4-5-20250929'` literal in this file.
    this.resolvedModel = resolveTaskModel(configService.get('ai'), 'email_compose')
    logger.info(
      { model: this.resolvedModel.model, tier: this.resolvedModel.tierKey },
      '[email-compose-assist] resolved email_compose model',
    )
  }

  async compose(input: EmailComposeAssistInput): Promise<EmailComposeAssistResult> {
    if (!this.anthropicClient) {
      throw new ServiceUnavailableError(
        'AI compose is unavailable — ANTHROPIC_API_KEY is not configured',
      )
    }

    const tools = this.buildTools()
    const userMessage = this.buildUserMessage(input)

    let agentResult
    try {
      agentResult = await runAgent(SYSTEM_PROMPT, tools, userMessage, {
        client: this.anthropicClient,
        model: this.resolvedModel.model,
        maxIterations: 8,
        maxTokens: 4096,
        temperature: 0.3,
      })
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[email-compose-assist] agent loop failed',
      )
      // Surface a safe, generic message — do not leak skill/agent internals.
      throw new Error('AI compose failed — please try again or edit manually')
    }

    // Extract the submitted draft from tool calls. Prefer the last successful
    // submit_draft call (agent may refine across iterations).
    const submitCalls = agentResult.toolCalls.filter(
      (tc) => tc.name === 'submit_draft' && !tc.isError,
    )
    const last = submitCalls[submitCalls.length - 1]

    if (!last) {
      // Fall back to final text if the agent didn't call submit_draft.
      const text = agentResult.text.trim()
      if (!text) {
        throw new Error('AI returned an empty response — please try rephrasing')
      }
      return { body: text }
    }

    const body = typeof last.input.body === 'string' ? last.input.body : ''
    if (!body.trim()) {
      throw new Error('AI returned an empty body — please try rephrasing')
    }

    const result: EmailComposeAssistResult = { body }

    if (typeof last.input.subject === 'string' && last.input.subject.trim()) {
      result.subject = last.input.subject.trim()
    }
    if (Array.isArray(last.input.to)) {
      const to = (last.input.to as unknown[])
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
      if (to.length > 0) result.to = to
    }
    if (Array.isArray(last.input.cc)) {
      const cc = (last.input.cc as unknown[])
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
      if (cc.length > 0) result.cc = cc
    }

    logger.info(
      {
        iterations: agentResult.iterations,
        toolCalls: agentResult.toolCalls.length,
        durationMs: agentResult.duration,
        hasSubject: Boolean(result.subject),
        toCount: result.to?.length ?? 0,
      },
      '[email-compose-assist] draft produced',
    )

    return result
  }

  // ──────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────

  private buildUserMessage(input: EmailComposeAssistInput): string {
    const parts: string[] = [
      `Instruction:\n"${input.instruction.trim()}"`,
    ]

    const d = input.existingDraft
    if (d) {
      const ctx: string[] = []
      if (d.to && d.to.length > 0) ctx.push(`To: ${d.to.join(', ')}`)
      if (d.cc && d.cc.length > 0) ctx.push(`Cc: ${d.cc.join(', ')}`)
      if (d.subject && d.subject.trim()) ctx.push(`Subject: ${d.subject.trim()}`)
      if (d.body && d.body.trim()) {
        ctx.push(`Existing body (revise if relevant):\n${d.body.trim()}`)
      }
      if (ctx.length > 0) {
        parts.push(`\nExisting draft context:\n${ctx.join('\n')}`)
      }
    }

    return parts.join('\n')
  }

  private buildTools(): AgentTool[] {
    const db = this.db
    return [
      {
        name: 'search_brain',
        description:
          'Search the brain knowledge base for relevant context. Use this to find information about topics, people, or projects before composing an email.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: {
              type: 'number',
              description: 'Max results to return (default: 8, max: 15)',
            },
          },
          required: ['query'],
        },
        execute: async (inp: Record<string, unknown>): Promise<string> => {
          const query = String(inp.query ?? '')
          const limit = Math.min(Number(inp.limit) || 8, 15)

          const rows = await db.execute(sql`
            SELECT id, content, capture_type, brain_view, source, created_at
            FROM captures
            WHERE deleted_at IS NULL
              AND content ILIKE ${'%' + query + '%'}
            ORDER BY created_at DESC
            LIMIT ${limit}
          `)

          if (!rows.rows || rows.rows.length === 0) {
            return 'No results found.'
          }

          return rows.rows
            .map(
              (r: Record<string, unknown>) =>
                `[${r.capture_type}/${r.brain_view}] ${String(r.content).slice(0, 300)} (${r.created_at})`,
            )
            .join('\n\n---\n\n')
        },
      },

      {
        name: 'get_entity',
        description:
          'Look up an entity (person, organization, project) by name. Useful for finding background on a recipient or topic.',
        input_schema: {
          type: 'object' as const,
          properties: {
            name: {
              type: 'string',
              description: 'Entity name to search for (case-insensitive partial match)',
            },
          },
          required: ['name'],
        },
        execute: async (inp: Record<string, unknown>): Promise<string> => {
          const name = String(inp.name ?? '')

          const rows = await db.execute(sql`
            SELECT e.name, e.entity_type, e.canonical_name, e.metadata,
                   COUNT(el.id) as mention_count
            FROM entities e
            LEFT JOIN entity_links el ON el.entity_id = e.id
            WHERE e.canonical_name ILIKE ${'%' + name + '%'}
               OR e.name ILIKE ${'%' + name + '%'}
            GROUP BY e.id
            ORDER BY COUNT(el.id) DESC
            LIMIT 5
          `)

          if (!rows.rows || rows.rows.length === 0) {
            return `No entity found matching "${name}".`
          }

          return rows.rows
            .map(
              (r: Record<string, unknown>) =>
                `${r.name} (${r.entity_type}) — ${r.mention_count} mentions${
                  r.metadata ? `, metadata: ${JSON.stringify(r.metadata)}` : ''
                }`,
            )
            .join('\n')
        },
      },

      {
        name: 'submit_draft',
        description:
          'Submit the proposed email fields. Call this EXACTLY ONCE at the end after gathering context. The caller will persist or discard as they see fit.',
        input_schema: {
          type: 'object' as const,
          properties: {
            body: {
              type: 'string',
              description:
                'The proposed email BODY text only. Do not include a Subject: line or a "From:/To:" header inside the body.',
            },
            subject: {
              type: 'string',
              description:
                'Optional proposed subject line. Omit if the caller already set one and it still fits.',
            },
            to: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional list of recipient email addresses. Omit if the caller already set recipients.',
            },
            cc: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Optional list of CC email addresses. Omit if no CC change is needed.',
            },
          },
          required: ['body'],
        },
        execute: async (inp: Record<string, unknown>): Promise<string> => {
          const body = String(inp.body ?? '').trim()
          if (!body) return 'Error: body is required.'
          return 'Draft submitted.'
        },
      },
    ]
  }
}

// ============================================================
// System prompt
// ============================================================

const SYSTEM_PROMPT = `You are an email-composition assistant for Troy Davis's personal AI knowledge system (Open Brain).

Your job is to produce a single proposed email draft based on the user's instruction and any existing draft context provided. You have access to the brain's knowledge base to look up relevant context before composing.

Guidelines:
- Search the brain when the instruction references a topic, project, or person that may already have context recorded.
- Look up entities (people, organizations) when the recipient or topic appears entity-like.
- Write in Troy's voice — direct, substantive, no filler, respects the reader's time.
- Never invent contact details. If the caller provided recipients in existing-draft context, keep them.
- Always finish by calling the submit_draft tool with at minimum a body field. Do NOT describe the email in prose and skip the tool.
- If the caller's existing draft already has a reasonable body and they only asked for a tweak, refine rather than rewrite wholesale.`
