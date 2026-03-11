import { loadPromptTemplate, renderPromptTemplate } from '@open-brain/shared'
import type { LLMGatewayService } from './llm-gateway.js'
import type { SearchService } from './search.js'
import type { BetService } from './bet.js'
import type { SessionRecord, SessionMessageRecord } from './session.js'
import { AntiVaguenessGate } from './anti-vagueness.js'
import { logger } from '../lib/logger.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The five required topic areas for a Quick Board Check.
 * All five must be covered before the session can close.
 */
const GOVERNANCE_TOPICS = [
  'priorities',
  'decisions',
  'bets',
  'energy',
  'outlook',
] as const

export type GovernanceTopic = (typeof GOVERNANCE_TOPICS)[number]

/**
 * Board roles rotate by turn pair. Integrator takes over once all topics covered.
 */
const BOARD_ROLES: Record<number, string> = {
  0: 'Operator',
  1: 'Operator',
  2: 'Strategist',
  3: 'Strategist',
  4: 'Skeptic',
  5: 'Skeptic',
}

function getBoardRole(turnNumber: number, allTopicsCovered: boolean): string {
  if (allTopicsCovered) return 'Integrator'
  return BOARD_ROLES[Math.min(turnNumber, 5)] ?? 'Integrator'
}

/**
 * Maximum number of vagueness pushbacks allowed per topic before moving on.
 * Prevents infinite loops where the user refuses to provide specifics.
 */
const MAX_VAGUENESS_SKIPS_PER_TOPIC = 2

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GovernanceEngineConfig {
  promptsDir: string
}

export interface GovernanceState {
  topics_covered: GovernanceTopic[]
  vagueness_skips: Record<string, number>
  assessment_generated: boolean
}

export interface ProcessResponseResult {
  bot_message: string
  context_capture_ids?: string[]
  state_update?: Partial<GovernanceState>
}

export interface GovernanceAssessment {
  assessment_type: string
  board_role: string
  areas_covered: string[]
  key_findings: string[]
  risks_identified: string[]
  honest_assessment: string
  prediction: {
    commitment: string
    confidence: number
    resolution_date: string
    criteria: string
  }
}

// ---------------------------------------------------------------------------
// GovernanceEngine
// ---------------------------------------------------------------------------

/**
 * GovernanceEngine drives the LLM-based governance conversation.
 *
 * This implements the duck-typed interface expected by SessionService:
 *   processResponse(session, transcript, userMessage): Promise<{ bot_message, context_capture_ids? }>
 *
 * Flow per turn:
 *   1. Parse governance state from session.config
 *   2. Pull relevant captures from SearchService as evidence
 *   3. Run anti-vagueness gate on the user's message
 *   4. If vague (and skips remaining): return pushback, increment skip count
 *   5. Otherwise: mark topic covered, determine next topic / board role
 *   6. Render governance_v1 prompt with full context
 *   7. Call LLMGatewayService with 'governance' alias
 *   8. If all topics covered: parse assessment JSON → create bet via BetService
 *   9. Return { bot_message, context_capture_ids }
 *
 * Guardrails (enforced by prompt + engine layer):
 *   - Min 3 topics must be covered before assessment can trigger
 *   - Anti-vagueness gate enforces concrete answers (max 2 skips/topic)
 *   - Bet creation is idempotent (checked via assessment_generated flag)
 */
export class GovernanceEngine {
  private antiVaguenessGate: AntiVaguenessGate
  private promptTemplate: string | null = null

  constructor(
    private llmGateway: LLMGatewayService,
    private promptsDir: string,
    private searchService?: SearchService,
    private betService?: BetService,
  ) {
    this.antiVaguenessGate = new AntiVaguenessGate(llmGateway)
  }

  // -------------------------------------------------------------------------
  // processResponse — implements the SessionService duck-typed interface
  // -------------------------------------------------------------------------

  async processResponse(
    session: SessionRecord,
    transcript: SessionMessageRecord[],
    userMessage: string,
  ): Promise<ProcessResponseResult> {
    const sessionId = session.id
    const config = (session.config ?? {}) as Record<string, unknown>
    const turnNumber = (config.turn_count as number) ?? 0

    // Parse or initialize governance state from session config
    const state = this.parseGovernanceState(config)

    logger.debug(
      {
        sessionId,
        turnNumber,
        topicsCovered: state.topics_covered,
        assessmentGenerated: state.assessment_generated,
      },
      '[governance-engine] processing turn',
    )

    // Pull relevant captures as evidence (non-blocking — fail gracefully)
    const { captureSnippets, captureIds } = await this.fetchRelevantCaptures(
      userMessage,
      session,
      state,
    )

    // Determine the current topic being discussed
    const currentTopic = this.getCurrentTopic(state)
    const allTopicsCovered = state.topics_covered.length >= GOVERNANCE_TOPICS.length
    const boardRole = getBoardRole(turnNumber, allTopicsCovered)

    // Anti-vagueness gate — only applies when there's a current topic to address
    if (currentTopic && !allTopicsCovered) {
      const skipCount = state.vagueness_skips[currentTopic] ?? 0

      if (skipCount < MAX_VAGUENESS_SKIPS_PER_TOPIC) {
        const lastBotMessage = this.getLastBotMessage(transcript)
        const gateResult = await this.antiVaguenessGate.evaluate(
          lastBotMessage,
          userMessage,
          currentTopic,
          sessionId,
        )

        if (!gateResult.passes && gateResult.pushback_message) {
          logger.debug(
            { sessionId, currentTopic, skipCount },
            '[governance-engine] anti-vagueness pushback triggered',
          )

          const newSkips = {
            ...state.vagueness_skips,
            [currentTopic]: skipCount + 1,
          }

          return {
            bot_message: `[${boardRole}] ${gateResult.pushback_message}`,
            context_capture_ids: captureIds,
            state_update: { vagueness_skips: newSkips },
          }
        }
      } else {
        // Max skips reached — log and move on
        logger.info(
          { sessionId, currentTopic, skipCount },
          '[governance-engine] max vagueness skips reached — advancing topic',
        )
      }

      // Mark topic as covered (either substantive answer or max skips reached)
      if (!state.topics_covered.includes(currentTopic)) {
        state.topics_covered = [...state.topics_covered, currentTopic]
      }
    }

    // Enforce minimum coverage guardrail before generating assessment
    const allNowCovered = state.topics_covered.length >= GOVERNANCE_TOPICS.length
    const minCoverageReached = state.topics_covered.length >= 3

    // Build the prompt and call LLM
    const prompt = this.renderPrompt({
      session_id: sessionId,
      session_type: session.session_type,
      turn_number: String(turnNumber + 1),
      max_turns: String((config.max_turns as number) ?? 20),
      board_role: allNowCovered ? 'Integrator' : boardRole,
      topics_covered: state.topics_covered.join(', ') || 'none',
      topics_remaining: GOVERNANCE_TOPICS.filter(t => !state.topics_covered.includes(t)).join(', ') || 'none',
      vagueness_skips: String(state.vagueness_skips[currentTopic ?? ''] ?? 0),
      relevant_captures: captureSnippets || 'No recent captures found.',
      transcript: this.formatTranscript(transcript),
      user_message: userMessage,
    })

    let botMessage: string
    try {
      botMessage = await this.llmGateway.complete(prompt, 'governance', {
        temperature: 0.3,
        maxTokens: 1024,
        sessionId,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error({ sessionId, err: msg }, '[governance-engine] LLM call failed')
      throw err
    }

    // If all topics are now covered and assessment not yet generated, try to parse it
    let betCaptureId: string | undefined
    if (allNowCovered && !state.assessment_generated) {
      betCaptureId = await this.handleAssessment(botMessage, sessionId, session.session_type)
      state.assessment_generated = true
    }

    const finalCaptureIds = betCaptureId
      ? [...captureIds, betCaptureId]
      : captureIds

    return {
      bot_message: botMessage,
      context_capture_ids: finalCaptureIds,
      state_update: {
        topics_covered: state.topics_covered,
        vagueness_skips: state.vagueness_skips,
        assessment_generated: state.assessment_generated,
      },
    }
  }

  // -------------------------------------------------------------------------
  // Private: state parsing
  // -------------------------------------------------------------------------

  private parseGovernanceState(config: Record<string, unknown>): GovernanceState {
    const raw = config.governance_state as Record<string, unknown> | undefined

    return {
      topics_covered: (raw?.topics_covered as GovernanceTopic[] | undefined) ?? [],
      vagueness_skips: (raw?.vagueness_skips as Record<string, number> | undefined) ?? {},
      assessment_generated: Boolean(raw?.assessment_generated ?? false),
    }
  }

  private getCurrentTopic(state: GovernanceState): GovernanceTopic | null {
    for (const topic of GOVERNANCE_TOPICS) {
      if (!state.topics_covered.includes(topic)) return topic
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Private: relevant captures
  // -------------------------------------------------------------------------

  private async fetchRelevantCaptures(
    userMessage: string,
    session: SessionRecord,
    state: GovernanceState,
  ): Promise<{ captureSnippets: string; captureIds: string[] }> {
    if (!this.searchService) {
      return { captureSnippets: '', captureIds: [] }
    }

    try {
      const config = (session.config ?? {}) as Record<string, unknown>
      const brainViews = config.focus_brain_views as string[] | undefined

      // Search using the current user message for topical relevance
      const results = await this.searchService.search(userMessage, {
        limit: 5,
        brainViews: brainViews && brainViews.length > 0 ? brainViews : undefined,
        temporalWeight: 0.3,  // Bias toward recent captures during governance
      })

      if (results.length === 0) {
        return { captureSnippets: '', captureIds: [] }
      }

      const snippets = results
        .map(r => {
          const date = r.capture.created_at
            ? new Date(r.capture.created_at).toLocaleDateString()
            : 'unknown date'
          const content = r.capture.content.slice(0, 300)
          return `[${date} | ${r.capture.brain_view ?? 'general'} | ${r.capture.capture_type ?? 'note'}]\n${content}`
        })
        .join('\n\n---\n\n')

      const captureIds = results.map(r => r.capture.id)

      return { captureSnippets: snippets, captureIds }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ sessionId: session.id, err: msg }, '[governance-engine] failed to fetch relevant captures — non-fatal')
      return { captureSnippets: '', captureIds: [] }
    }
  }

  // -------------------------------------------------------------------------
  // Private: assessment handling
  // -------------------------------------------------------------------------

  /**
   * Attempts to parse a GovernanceAssessment from the LLM response.
   * If a valid assessment with a prediction is found, creates a bet.
   * Returns the bet capture ID if one was created, undefined otherwise.
   */
  private async handleAssessment(
    botMessage: string,
    sessionId: string,
    sessionType: string,
  ): Promise<string | undefined> {
    if (!this.betService) return undefined

    const assessment = this.parseAssessmentFromMessage(botMessage)
    if (!assessment) {
      logger.debug({ sessionId }, '[governance-engine] no parseable assessment in response')
      return undefined
    }

    const { prediction } = assessment
    if (!prediction?.commitment || !prediction?.resolution_date) {
      logger.debug({ sessionId }, '[governance-engine] assessment missing prediction fields — skipping bet creation')
      return undefined
    }

    try {
      const dueDate = new Date(prediction.resolution_date)
      if (isNaN(dueDate.getTime())) {
        logger.warn({ sessionId, resolution_date: prediction.resolution_date }, '[governance-engine] invalid resolution_date — skipping bet')
        return undefined
      }

      const bet = await this.betService.create({
        commitment: prediction.commitment,
        criteria: prediction.criteria ?? '',
        due_date: dueDate,
        confidence: prediction.confidence ?? 0.5,
        session_id: sessionId,
        source: `governance:${sessionType}`,
        tags: ['governance', 'board-check', 'auto-generated'],
      })

      logger.info(
        { sessionId, betId: bet.id, commitment: prediction.commitment },
        '[governance-engine] bet created from assessment',
      )

      return bet.id
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ sessionId, err: msg }, '[governance-engine] bet creation failed — non-fatal')
      return undefined
    }
  }

  private parseAssessmentFromMessage(message: string): GovernanceAssessment | null {
    // Look for a JSON block in the response
    const jsonMatch = message.match(/\{[\s\S]*"assessment_type"[\s\S]*\}/)
    if (!jsonMatch) return null

    try {
      const parsed = JSON.parse(jsonMatch[0]) as GovernanceAssessment
      if (parsed.assessment_type && parsed.prediction) return parsed
    } catch {
      // Not valid JSON — return null
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Private: prompt rendering
  // -------------------------------------------------------------------------

  private renderPrompt(vars: Record<string, string>): string {
    if (!this.promptTemplate) {
      this.promptTemplate = loadPromptTemplate(this.promptsDir, 'governance_v1.txt')
    }
    return renderPromptTemplate(this.promptTemplate, vars)
  }

  // -------------------------------------------------------------------------
  // Private: transcript formatting
  // -------------------------------------------------------------------------

  private formatTranscript(transcript: SessionMessageRecord[]): string {
    if (transcript.length === 0) return '(no prior conversation)'

    return transcript
      .map(msg => {
        const role = msg.role === 'user' ? 'User' : 'Board'
        return `${role}: ${msg.content}`
      })
      .join('\n\n')
  }

  private getLastBotMessage(transcript: SessionMessageRecord[]): string {
    const botMessages = transcript.filter(m => m.role === 'assistant')
    return botMessages.at(-1)?.content ?? ''
  }
}
