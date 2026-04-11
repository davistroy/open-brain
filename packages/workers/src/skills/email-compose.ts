import { sql } from 'drizzle-orm'
import type Anthropic from '@anthropic-ai/sdk'
import type { Database } from '@open-brain/shared'
import {
  skills_log,
  logger,
  runAgent,
} from '@open-brain/shared'
import type { AgentTool, AgentResult } from '@open-brain/shared'

// ============================================================
// Types
// ============================================================

export interface EmailComposeResult {
  draftId: string | null
  to: string
  subject: string
  bodyPreview: string
  agentIterations: number
  toolCalls: number
  durationMs: number
}

export interface EmailComposeOptions {
  /** Anthropic client instance (required for runAgent). */
  anthropicClient?: Anthropic
  /** Model to use for the agent. Default: 'claude-sonnet-4-5-20250929'. */
  model?: string
  /** Max agent iterations. Default: 10. */
  maxIterations?: number
  /** Core API base URL for creating the draft. Default: env CORE_API_URL or http://localhost:3000 */
  coreApiUrl?: string
}

// ============================================================
// Agent tools
// ============================================================

/**
 * Build tools the agent uses to compose emails.
 *
 * - search_brain: search the knowledge base for context
 * - get_entity: look up entity details (e.g. contact info)
 * - draft_email: submit the composed email as a draft
 */
export function buildEmailComposeTools(
  db: Database,
  coreApiUrl: string,
): AgentTool[] {
  return [
    {
      name: 'search_brain',
      description: 'Search the brain knowledge base for relevant context. Use this to find information about topics, people, or projects before composing an email.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
          limit: {
            type: 'number',
            description: 'Max results to return (default: 10, max: 20)',
          },
        },
        required: ['query'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const query = String(input.query ?? '')
        const limit = Math.min(Number(input.limit) || 10, 20)

        const rows = await db.execute(sql`
          SELECT id, content, capture_type, brain_view, source, tags, created_at
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
          .map((r: Record<string, unknown>) =>
            `[${r.capture_type}/${r.brain_view}] ${String(r.content).slice(0, 300)} (${r.created_at})`,
          )
          .join('\n\n---\n\n')
      },
    },

    {
      name: 'get_entity',
      description: 'Look up an entity (person, organization, project) by name. Useful for finding contact details or context about a recipient.',
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
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const name = String(input.name ?? '')

        const rows = await db.execute(sql`
          SELECT e.name, e.entity_type, e.canonical_name, e.aliases, e.metadata,
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
          .map((r: Record<string, unknown>) =>
            `${r.name} (${r.entity_type}) — ${r.mention_count} mentions${r.metadata ? `, metadata: ${JSON.stringify(r.metadata)}` : ''}`,
          )
          .join('\n')
      },
    },

    {
      name: 'draft_email',
      description: 'Create an email draft. This submits the composed email for review. Use review-required mode unless explicitly told to auto-send.',
      input_schema: {
        type: 'object' as const,
        properties: {
          to: {
            type: 'string',
            description: 'Recipient email address',
          },
          subject: {
            type: 'string',
            description: 'Email subject line',
          },
          body: {
            type: 'string',
            description: 'Email body text (plain text)',
          },
          cc: {
            type: 'string',
            description: 'CC recipient(s), comma-separated (optional)',
          },
          send_mode: {
            type: 'string',
            enum: ['review-required', 'auto-send'],
            description: 'Send mode. Default: review-required',
          },
        },
        required: ['to', 'subject', 'body'],
      },
      execute: async (input: Record<string, unknown>): Promise<string> => {
        const to = String(input.to ?? '')
        const subject = String(input.subject ?? '')
        const body = String(input.body ?? '')
        const cc = input.cc ? String(input.cc) : undefined
        const sendMode = input.send_mode === 'auto-send' ? 'auto-send' : 'review-required'

        if (!to || !subject || !body) {
          return 'Error: to, subject, and body are all required.'
        }

        try {
          const response = await fetch(`${coreApiUrl}/api/v1/email/drafts`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Open-Brain-Caller': 'email-compose-skill',
            },
            body: JSON.stringify({
              to,
              subject,
              body,
              cc,
              source: 'skill',
              sendMode,
            }),
          })

          if (!response.ok) {
            const errBody = await response.text()
            return `Error creating draft: ${response.status} ${errBody}`
          }

          const result = await response.json() as Record<string, unknown>
          return `Draft created successfully. ID: ${result.id}, Status: ${result.status}, Mode: ${result.send_mode}`
        } catch (err) {
          return `Error creating draft: ${err instanceof Error ? err.message : String(err)}`
        }
      },
    },
  ]
}

// ============================================================
// System prompt
// ============================================================

const EMAIL_COMPOSE_SYSTEM_PROMPT = `You are an email composition assistant for Troy Davis's personal AI knowledge system (Open Brain).

Your job is to compose professional, clear emails based on the user's instructions. You have access to the brain's knowledge base to look up relevant context and entity information.

Guidelines:
- Search the brain for relevant context before composing
- Look up entities (people, organizations) for background information
- Write clear, professional emails in Troy's voice — direct, substantive, no filler
- Default to review-required mode (never auto-send unless explicitly instructed)
- Include relevant context from the brain in the email where appropriate
- Keep emails concise — Troy respects people's time

Process:
1. Understand what email needs to be composed
2. Search the brain for relevant context (if needed)
3. Look up entity details (if the recipient is a known entity)
4. Compose and submit the draft via draft_email tool

Always create the draft via the draft_email tool — do not just describe what you would write.`

// ============================================================
// Entry point
// ============================================================

/**
 * Execute the email-compose skill using runAgent().
 *
 * Takes a natural language instruction (e.g. "Email John about the project update")
 * and uses an LLM agent with tools to compose and create a draft.
 */
export async function executeEmailCompose(
  db: Database,
  instruction: string,
  options: EmailComposeOptions = {},
): Promise<EmailComposeResult> {
  const startMs = Date.now()
  const coreApiUrl = options.coreApiUrl ?? process.env.CORE_API_URL ?? 'http://localhost:3000'

  logger.info({ instruction: instruction.slice(0, 200) }, '[email-compose] starting')

  const tools = buildEmailComposeTools(db, coreApiUrl)

  let agentResult: AgentResult
  try {
    agentResult = await runAgent(
      EMAIL_COMPOSE_SYSTEM_PROMPT,
      tools,
      instruction,
      {
        client: options.anthropicClient,
        model: options.model ?? 'claude-sonnet-4-5-20250929',
        maxIterations: options.maxIterations ?? 10,
        maxTokens: 4096,
        temperature: 0.3,
      },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err: msg }, '[email-compose] agent loop failed')
    throw err
  }

  // Extract draft info from tool calls
  const draftCall = agentResult.toolCalls.find(
    (tc) => tc.name === 'draft_email' && !tc.isError,
  )

  const draftIdMatch = draftCall?.result?.match(/ID: ([a-f0-9-]+)/)
  const draftId = draftIdMatch?.[1] ?? null

  const durationMs = Date.now() - startMs
  const result: EmailComposeResult = {
    draftId,
    to: draftCall ? String(draftCall.input.to ?? '') : '',
    subject: draftCall ? String(draftCall.input.subject ?? '') : '',
    bodyPreview: draftCall ? String(draftCall.input.body ?? '').slice(0, 200) : '',
    agentIterations: agentResult.iterations,
    toolCalls: agentResult.toolCalls.length,
    durationMs,
  }

  // Log to skills_log
  try {
    await db.insert(skills_log).values({
      skill_name: 'email-compose',
      input_summary: instruction.slice(0, 200),
      output_summary: draftId
        ? `draft:${draftId} to:${result.to} subj:${result.subject.slice(0, 80)}`
        : `no draft created — iterations:${agentResult.iterations} tools:${agentResult.toolCalls.length}`,
      result: result as unknown as Record<string, unknown>,
      duration_ms: durationMs,
    })
  } catch {
    logger.warn('[email-compose] failed to write skills_log')
  }

  logger.info(
    {
      draftId,
      to: result.to,
      subject: result.subject,
      iterations: agentResult.iterations,
      toolCalls: agentResult.toolCalls.length,
      durationMs,
    },
    '[email-compose] execution complete',
  )

  return result
}
