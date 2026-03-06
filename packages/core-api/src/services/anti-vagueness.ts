import type { LLMGatewayService } from './llm-gateway.js'
import { logger } from '../lib/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AntiVaguenessResult {
  passes: boolean
  pushback_message?: string
  confidence: number
}

// ---------------------------------------------------------------------------
// Vagueness patterns (fast-path heuristic — avoids LLM call for obvious cases)
// ---------------------------------------------------------------------------

const VAGUE_PATTERNS = [
  /^working on it\.?$/i,
  /^making progress\.?$/i,
  /^focused on .{1,40}\.?$/i,
  /^things are going .{0,20}\.?$/i,
  /^it's going .{0,20}\.?$/i,
  /^not sure\.?$/i,
  /^i don'?t know\.?$/i,
  /^maybe\.?$/i,
  /^probably\.?$/i,
  /^fine\.?$/i,
  /^ok\.?$/i,
  /^good\.?$/i,
  /^busy\.?$/i,
  /^same as usual\.?$/i,
  /^no change\.?$/i,
  /^nothing new\.?$/i,
  /^same\.?$/i,
]

// Minimum length threshold — very short answers are usually vague
const MIN_SUBSTANTIVE_LENGTH = 40

/**
 * Fast heuristic check before falling back to LLM evaluation.
 * Returns true if the answer is obviously vague.
 */
function isObviouslyVague(answer: string): boolean {
  const trimmed = answer.trim()

  if (trimmed.length < MIN_SUBSTANTIVE_LENGTH) {
    // Short answers pass only if they contain specific indicators
    const hasSpecifics = /\d|%|\$|deadline|date|client|project|blocker|decision/i.test(trimmed)
    if (!hasSpecifics) return true
  }

  return VAGUE_PATTERNS.some(p => p.test(trimmed))
}

// ---------------------------------------------------------------------------
// AntiVaguenessGate
// ---------------------------------------------------------------------------

/**
 * AntiVaguenessGate evaluates whether a user's response to a governance
 * question is substantive enough to count as covering a topic.
 *
 * Strategy:
 *   1. Fast-path heuristic: if obviously vague, return pushback immediately
 *   2. LLM evaluation: for ambiguous cases, call the 'fast' model alias
 *   3. Returns { passes, pushback_message, confidence }
 *
 * The governance engine tracks skip counts per topic — a max of 2 pushbacks
 * before the engine moves on regardless (to prevent infinite loops).
 *
 * When llmGateway is not provided (e.g., in tests), falls back to heuristic only.
 */
export class AntiVaguenessGate {
  constructor(private llmGateway?: LLMGatewayService) {}

  /**
   * Evaluates whether the user's answer to a governance question is substantive.
   *
   * @param question   The governance question that was asked
   * @param answer     The user's response
   * @param topic      The topic area being covered (for pushback phrasing)
   * @param sessionId  Optional session ID for audit log correlation
   */
  async evaluate(
    question: string,
    answer: string,
    topic: string,
    sessionId?: string,
  ): Promise<AntiVaguenessResult> {
    // Fast path: obviously vague
    if (isObviouslyVague(answer)) {
      logger.debug(
        { topic, answerLength: answer.length, sessionId },
        '[anti-vagueness] fast-path vague detected',
      )
      return {
        passes: false,
        pushback_message: this.buildPushback(topic, answer),
        confidence: 0.95,
      }
    }

    // If no LLM gateway available, rely on heuristic only
    if (!this.llmGateway) {
      return { passes: true, confidence: 0.6 }
    }

    // LLM evaluation for ambiguous cases
    try {
      const prompt = this.buildEvalPrompt(question, answer, topic)
      const raw = await this.llmGateway.complete(prompt, 'fast', {
        temperature: 0.0,
        maxTokens: 256,
        sessionId,
      })

      const parsed = this.parseEvalResponse(raw)
      logger.debug(
        { topic, passes: parsed.passes, confidence: parsed.confidence, sessionId },
        '[anti-vagueness] LLM evaluation complete',
      )
      return parsed
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn({ topic, err: msg, sessionId }, '[anti-vagueness] LLM eval failed — defaulting to pass')
      // Fail open: if the LLM call fails, don't block the session
      return { passes: true, confidence: 0.5 }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildEvalPrompt(question: string, answer: string, topic: string): string {
    return `You are evaluating whether a governance session answer is substantive enough to count as covering a topic.

Topic area: ${topic}
Question asked: ${question}
User's answer: ${answer}

A SUBSTANTIVE answer contains at least one of:
- Specific project name, client name, or system name
- A concrete number, date, dollar amount, or percentage
- A named decision with stated rationale
- A specific blocker with named owner or dependency
- A concrete outcome that happened or is expected

A VAGUE answer contains only:
- General status phrases ("working on it", "making progress", "going well")
- Assertions without evidence ("I've been focused on X" with no specifics about X)
- Deflections or topic changes

Respond with valid JSON only. No explanation, no markdown fencing.
{"passes": <true|false>, "confidence": <0.0-1.0>, "reason": "<one sentence>", "pushback_question": "<specific follow-up question if not passing>"}`
  }

  private parseEvalResponse(raw: string): AntiVaguenessResult {
    try {
      // Strip markdown fencing if present
      const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
      const parsed = JSON.parse(clean) as {
        passes: boolean
        confidence: number
        reason?: string
        pushback_question?: string
      }

      return {
        passes: Boolean(parsed.passes),
        confidence: Number(parsed.confidence) || 0.5,
        pushback_message: parsed.passes ? undefined : (parsed.pushback_question ?? undefined),
      }
    } catch {
      // Parse failure: fail open
      return { passes: true, confidence: 0.4 }
    }
  }

  private buildPushback(topic: string, _answer: string): string {
    const pushbacks: Record<string, string> = {
      priorities: "I need specifics. What is the single top priority by name, and what is the concrete next action — not a category or intent, the actual task?",
      decisions: "That's not a decision — it's a status. Name a specific decision made this week: what was decided, what was the alternative you rejected, and why?",
      bets: "Walk me through one active bet: the specific commitment you made, its due date, and whether your confidence has changed since you made it. If you have no active bets, say so explicitly.",
      energy: "I need an honest read. On a scale of 1-10: work energy, personal energy. Then tell me one specific thing draining you and one specific thing restoring it.",
      outlook: "Give me the 90-day trajectory in one sentence — not what you hope will happen, what the current data suggests will happen if nothing changes.",
    }

    return (
      pushbacks[topic] ??
      `I need more specifics on ${topic}. Give me concrete names, dates, or numbers — not general descriptions of activity.`
    )
  }
}
