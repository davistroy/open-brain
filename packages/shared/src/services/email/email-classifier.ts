/**
 * Email Classifier Service — tiered classification chain.
 *
 * Implements the cost-tiered processing principle:
 *   T0: Sender rules (exact email / domain suffix match) — free, deterministic
 *   T0: Keyword rules (subject keyword match) — free, deterministic
 *   T1: LLM classification via LLMGatewayService.completeByTask() — free (Jetson/Spark)
 *   Manual: "Needs Review" fallback
 *
 * Ported from Python scripts/email-pipeline.py classify_email() chain.
 */

import { logger } from '../../lib/logger.js'
import type { EmailMessage } from './types.js'
import type { EmailRules } from './config-loader.js'
import type { LLMGatewayService } from '../llm-gateway.js'

export interface ClassificationResult {
  category: string
  confidence: number
  tier: 'sender' | 'keyword' | 'jetson' | 'manual'
}

export class EmailClassifier {
  private rules: EmailRules
  private llmGateway: LLMGatewayService | null

  constructor(rules: EmailRules, llmGateway?: LLMGatewayService | null) {
    this.rules = rules
    this.llmGateway = llmGateway ?? null
  }

  /**
   * T0: Exact email match or domain suffix match.
   *
   * Matching logic (case-insensitive):
   * 1. If sender email exactly matches a rule key -> match
   * 2. If rule key has no '@' (domain rule), match if sender domain equals
   *    the rule or ends with '.{rule}' (subdomain matching)
   *
   * Confidence: 1.0 (deterministic match)
   */
  classifyBySender(email: EmailMessage): ClassificationResult | null {
    const sender = email.sender.toLowerCase()

    // Direct email match
    const directMatch = this.rules.senderRules.get(sender)
    if (directMatch) {
      return { category: directMatch, confidence: 1.0, tier: 'sender' }
    }

    // Domain suffix match
    const atIdx = sender.indexOf('@')
    if (atIdx === -1) return null

    const domain = sender.slice(atIdx + 1)

    for (const [rule, category] of this.rules.senderRules) {
      // Skip full email rules (they contain '@') — already checked above
      if (rule.includes('@')) continue

      // Domain rule: match exact domain or subdomain (.rule suffix)
      if (domain === rule || domain.endsWith('.' + rule)) {
        return { category, confidence: 1.0, tier: 'sender' }
      }
    }

    return null
  }

  /**
   * T0: Subject keyword match.
   *
   * Scans the subject line (lowercase) against each category's keyword list.
   * Picks the category with the most keyword hits.
   *
   * Confidence formula: min(0.5 + 0.15 * hitCount, 0.9)
   */
  classifyByKeyword(email: EmailMessage): ClassificationResult | null {
    const subject = email.subject.toLowerCase()

    let bestCategory: string | null = null
    let bestHitCount = 0

    for (const [category, keywords] of this.rules.keywordRules) {
      let hitCount = 0
      for (const kw of keywords) {
        if (subject.includes(kw)) {
          hitCount++
        }
      }
      if (hitCount > bestHitCount) {
        bestCategory = category
        bestHitCount = hitCount
      }
    }

    if (bestCategory && bestHitCount > 0) {
      const confidence = Math.min(0.5 + 0.15 * bestHitCount, 0.9)
      return { category: bestCategory, confidence, tier: 'keyword' }
    }

    return null
  }

  /**
   * T1: LLM classification via LLMGatewayService.completeByTask('email_classification', ...).
   *
   * Sends a prompt asking the LLM to classify the email into one of the valid categories.
   * Parses JSON response, handles markdown code blocks and <think> tags from reasoning models.
   *
   * Default confidence: 0.85 if LLM doesn't return one.
   */
  async classifyByLLM(email: EmailMessage): Promise<ClassificationResult | null> {
    if (!this.llmGateway) {
      logger.debug('LLM gateway not available — skipping LLM classification')
      return null
    }

    const sortedCategories = [...this.rules.categories].sort()
    const bodyPreview = email.bodyPreview ? email.bodyPreview.slice(0, 500) : ''

    const prompt =
      `Classify this email into exactly one of these categories:\n${JSON.stringify(sortedCategories)}\n\n` +
      `Email:\nFrom: ${email.sender}\nSubject: ${email.subject}\n` +
      `Body preview: ${bodyPreview}\n\n` +
      'Respond with ONLY valid JSON: {"category": "...", "confidence": 0.0-1.0}'

    try {
      const response = await this.llmGateway.completeByTask(prompt, 'email_classification', {
        temperature: 0.1,
        maxTokens: 256,
      })

      const parsed = this.parseLLMResponse(response)
      if (!parsed) return null

      // Validate category is in known set
      if (!this.rules.categories.has(parsed.category)) {
        logger.warn(
          { category: parsed.category, validCategories: sortedCategories.length },
          `LLM returned unknown category '${parsed.category}' — rejecting`,
        )
        return null
      }

      return {
        category: parsed.category,
        confidence: parsed.confidence,
        tier: 'jetson',
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ error: message }, 'LLM email classification failed')
      return null
    }
  }

  /**
   * Parse an LLM response that may contain markdown code blocks or <think> tags.
   *
   * Strips:
   * - ```json ... ``` or ``` ... ``` wrapper
   * - <think>...</think> blocks (reasoning model artifacts)
   *
   * Expects JSON with {category, confidence?}.
   */
  private parseLLMResponse(content: string): { category: string; confidence: number } | null {
    let cleaned = content.trim()

    // Strip <think>...</think> blocks (reasoning models like Qwen)
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, '').trim()

    // Strip markdown code block wrapper
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '')
    cleaned = cleaned.replace(/\s*```$/i, '')
    cleaned = cleaned.trim()

    try {
      const parsed = JSON.parse(cleaned) as Record<string, unknown>
      const category = typeof parsed.category === 'string' ? parsed.category : ''
      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.85

      if (!category) {
        logger.warn({ parsed: cleaned }, 'LLM response missing category field')
        return null
      }

      return { category, confidence }
    } catch {
      logger.warn({ content: cleaned.slice(0, 200) }, 'Failed to parse LLM classification response as JSON')
      return null
    }
  }

  /**
   * Tiered classification dispatcher: sender -> keyword -> LLM -> "Needs Review".
   *
   * Follows cost-tiered processing: T0 free rules first, T1 local LLM second,
   * manual fallback last. Each tier short-circuits if it produces a result.
   */
  async classify(email: EmailMessage): Promise<ClassificationResult> {
    // T0: Sender rules (deterministic, free)
    const senderResult = this.classifyBySender(email)
    if (senderResult) return senderResult

    // T0: Keyword rules (deterministic, free)
    const keywordResult = this.classifyByKeyword(email)
    if (keywordResult) return keywordResult

    // T1: LLM classification (Jetson/Spark, free)
    const llmResult = await this.classifyByLLM(email)
    if (llmResult) return llmResult

    // Fallback: manual review
    return { category: 'Needs Review', confidence: 0.0, tier: 'manual' }
  }
}
