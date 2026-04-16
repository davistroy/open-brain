/**
 * EmailClassifySkill — orchestrates the email classification pipeline.
 *
 * Replaces the Python email-pipeline.py `run_pipeline()` + `generate_daily_summary()`.
 * Runs as a BullMQ scheduled skill (5:00 AM daily, Phase 5.2 will register it).
 *
 * Pipeline steps per provider:
 *   1. Authenticate
 *   2. Fetch inbox (last N hours)
 *   3. Setup folders/labels for categories
 *   4. Classify each email (T0 sender -> T0 keyword -> T1 LLM -> manual)
 *   5. Organize: move to folder if confidence >= threshold, else "Needs Review"
 *   6. Record classification in Postgres
 *   7. Detect user corrections (emails moved to different folders)
 *   8. Cleanup old spam
 *
 * After all providers:
 *   9. Generate daily summary via LLM synthesis
 *  10. Post summary as capture to Open Brain API
 *  11. Send Pushover notification
 */

import { logger } from '@open-brain/shared'
import type { Database, LLMGatewayService, EmailProvider, EmailMessage } from '@open-brain/shared'
import { EmailClassifier } from '@open-brain/shared'
import type { EmailRules, ClassificationResult } from '@open-brain/shared'
import { BaseSkill } from './base-skill.js'
import type { BaseResult, BaseSkillOpts } from './types.js'
import {
  isProcessed,
  recordClassification,
  recordCorrection,
  getOvernightSummary,
  getDailySummary,
  markSummaryPosted,
  getRecentClassifications,
} from './email-classify-query.js'

// ============================================================
// Types
// ============================================================

export type ProviderName = 'hotmail' | 'gmail'

export interface EmailClassifyOptions {
  /** Which email providers to process. Default: ['hotmail', 'gmail'] */
  providers?: ProviderName[]
  /** How far back to fetch. Default: 24 */
  sinceHours?: number
  /** Classify but don't move emails. Default: false */
  dryRun?: boolean
}

export interface ProviderStats {
  classified: number
  moved: number
  needsReview: number
  skipped: number
  errors: number
}

export interface EmailClassifyResult extends BaseResult {
  hotmail: ProviderStats
  gmail: ProviderStats
  corrections: number
  summaryPosted: boolean
}

export interface EmailClassifySkillOpts extends BaseSkillOpts {
  hotmailClient?: EmailProvider | null
  gmailClient?: EmailProvider | null
  classifier: EmailClassifier
  llmGateway?: LLMGatewayService | null
  rules: EmailRules
  /** Override core-api URL for posting captures. Default: env or http://localhost:3000 */
  coreApiUrl?: string
}

// ============================================================
// Helpers
// ============================================================

function emptyStats(): ProviderStats {
  return { classified: 0, moved: 0, needsReview: 0, skipped: 0, errors: 0 }
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

// ============================================================
// EmailClassifySkill
// ============================================================

export class EmailClassifySkill extends BaseSkill<EmailClassifyOptions, EmailClassifyResult> {
  private hotmailClient: EmailProvider | null
  private gmailClient: EmailProvider | null
  private classifier: EmailClassifier
  private llmGateway: LLMGatewayService | null
  private rules: EmailRules
  private coreApiUrl: string

  constructor(opts: EmailClassifySkillOpts) {
    super('email-classify', opts)
    this.hotmailClient = opts.hotmailClient ?? null
    this.gmailClient = opts.gmailClient ?? null
    this.classifier = opts.classifier
    this.llmGateway = opts.llmGateway ?? null
    this.rules = opts.rules
    this.coreApiUrl = opts.coreApiUrl ?? process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
  }

  async execute(input: EmailClassifyOptions = {}): Promise<EmailClassifyResult> {
    const startMs = Date.now()
    const providers = input.providers ?? ['hotmail', 'gmail']
    const sinceHours = input.sinceHours ?? 24
    const dryRun = input.dryRun ?? false

    logger.info(
      { providers, sinceHours, dryRun },
      '[email-classify] starting pipeline',
    )

    const hotmailStats = emptyStats()
    const gmailStats = emptyStats()
    let totalCorrections = 0

    // Process each requested provider
    for (const providerName of providers) {
      const client = providerName === 'hotmail' ? this.hotmailClient : this.gmailClient
      const stats = providerName === 'hotmail' ? hotmailStats : gmailStats

      if (!client) {
        logger.debug({ provider: providerName }, '[email-classify] no client configured — skipping')
        continue
      }

      try {
        const corrections = await this.processProvider(
          providerName,
          client,
          stats,
          sinceHours,
          dryRun,
        )
        totalCorrections += corrections
      } catch (err) {
        logger.error(
          { err, provider: providerName },
          '[email-classify] provider failed — continuing with next',
        )
      }
    }

    // Generate and post daily summary
    let summaryPosted = false
    if (!dryRun) {
      summaryPosted = await this.generateAndPostSummary(sinceHours)
    }

    const durationMs = Date.now() - startMs
    const result: EmailClassifyResult = {
      hotmail: hotmailStats,
      gmail: gmailStats,
      corrections: totalCorrections,
      summaryPosted,
      durationMs,
    }

    // Log to skills_log
    const totalClassified = hotmailStats.classified + gmailStats.classified
    const totalMoved = hotmailStats.moved + gmailStats.moved
    await this.logResult(
      result,
      `providers:${providers.join(',')} sinceHours:${sinceHours} dryRun:${dryRun}`,
      `classified:${totalClassified} moved:${totalMoved} corrections:${totalCorrections} summary:${summaryPosted}`,
    )

    // Send Pushover notification
    if (totalClassified > 0 || totalCorrections > 0) {
      const title = `Email Pipeline — ${todayDateString()}`
      const lines: string[] = []
      if (hotmailStats.classified > 0) {
        lines.push(`Hotmail: ${hotmailStats.classified} classified, ${hotmailStats.moved} moved, ${hotmailStats.needsReview} review`)
      }
      if (gmailStats.classified > 0) {
        lines.push(`Gmail: ${gmailStats.classified} classified, ${gmailStats.moved} moved, ${gmailStats.needsReview} review`)
      }
      if (totalCorrections > 0) {
        lines.push(`Corrections detected: ${totalCorrections}`)
      }
      if (summaryPosted) {
        lines.push('Daily digest posted to Open Brain')
      }
      lines.push(`Duration: ${this.formatDuration(durationMs)}`)

      await this.sendNotification(title, lines.join('\n'))
    }

    logger.info(
      {
        hotmail: hotmailStats,
        gmail: gmailStats,
        corrections: totalCorrections,
        summaryPosted,
        durationMs,
      },
      '[email-classify] pipeline complete',
    )

    return result
  }

  // ──────────────────────────────────────────────────────────────
  // Private: Process a single provider
  // ──────────────────────────────────────────────────────────────

  private async processProvider(
    providerName: ProviderName,
    client: EmailProvider,
    stats: ProviderStats,
    sinceHours: number,
    dryRun: boolean,
  ): Promise<number> {
    logger.info({ provider: providerName }, `[email-classify] ${providerName} pipeline start`)

    // Step 1: Authenticate
    const authenticated = await client.authenticate()
    if (!authenticated) {
      logger.error({ provider: providerName }, '[email-classify] authentication failed — skipping provider')
      throw new Error(`${providerName} authentication failed`)
    }

    // Step 2: Fetch inbox
    const emails = await client.fetchInbox(sinceHours)
    logger.info({ provider: providerName, fetched: emails.length }, '[email-classify] inbox fetched')

    // Step 3: Filter already-processed
    const newEmails: EmailMessage[] = []
    for (const email of emails) {
      const processed = await isProcessed(this.db, providerName, email.messageId)
      if (processed) {
        stats.skipped++
      } else {
        newEmails.push(email)
      }
    }

    if (newEmails.length === 0) {
      logger.info({ provider: providerName }, '[email-classify] no new emails')
      return 0
    }

    // Step 4: Setup folders
    const categories = [...this.rules.categories]
    const folderMap = await client.setupFolders(categories)

    // Step 5: Classify and organize each email
    const threshold = this.rules.autoMoveThreshold
    for (const email of newEmails) {
      try {
        await this.classifyAndOrganize(
          providerName,
          client,
          email,
          folderMap,
          threshold,
          dryRun,
          stats,
        )
      } catch (err) {
        stats.errors++
        logger.warn(
          { err, messageId: email.messageId, subject: email.subject?.slice(0, 60) },
          '[email-classify] failed to process email',
        )
      }
    }

    // Step 6: Detect corrections (not in dry run)
    let corrections = 0
    if (!dryRun) {
      corrections = await this.detectCorrections(providerName, client, folderMap, sinceHours)
    }

    // Step 7: Cleanup spam (not in dry run)
    if (!dryRun) {
      try {
        const spamCleaned = await client.cleanupSpam(this.rules.spamMaxAgeDays)
        if (spamCleaned > 0) {
          logger.info({ provider: providerName, spamCleaned }, '[email-classify] spam cleanup done')
        }
      } catch (err) {
        logger.warn({ err, provider: providerName }, '[email-classify] spam cleanup failed')
      }
    }

    logger.info(
      { provider: providerName, ...stats },
      `[email-classify] ${providerName} pipeline done`,
    )

    return corrections
  }

  // ──────────────────────────────────────────────────────────────
  // Private: Classify + organize a single email
  // ──────────────────────────────────────────────────────────────

  private async classifyAndOrganize(
    providerName: ProviderName,
    client: EmailProvider,
    email: EmailMessage,
    folderMap: Map<string, string>,
    threshold: number,
    dryRun: boolean,
    stats: ProviderStats,
  ): Promise<void> {
    // Classify through the tiered chain
    const classification: ClassificationResult = await this.classifier.classify(email)
    stats.classified++

    // Determine target: use classified category if above threshold, otherwise "Needs Review"
    const targetCategory =
      classification.confidence >= threshold ? classification.category : 'Needs Review'
    if (targetCategory === 'Needs Review') {
      stats.needsReview++
    }

    const folderId = folderMap.get(targetCategory) ?? null

    // Move email if not dry run
    let moved = false
    if (!dryRun && folderId) {
      moved = await client.moveEmail(email.messageId, folderId)
      if (moved) {
        stats.moved++
      }
    }

    // Record to database
    await recordClassification(this.db, {
      messageId: email.messageId,
      provider: providerName,
      sender: email.sender,
      subject: email.subject,
      category: classification.category,
      confidence: classification.confidence,
      tier: classification.tier,
      folderId,
      moved,
    })

    const action = dryRun ? 'DRY' : moved ? 'MOV' : 'REC'
    logger.debug(
      {
        action,
        tier: classification.tier,
        confidence: classification.confidence.toFixed(2),
        target: targetCategory,
        subject: email.subject?.slice(0, 60),
      },
      `[email-classify] [${action}] ${classification.tier}(${classification.confidence.toFixed(2)}) -> ${targetCategory}`,
    )
  }

  // ──────────────────────────────────────────────────────────────
  // Private: Detect user corrections
  // ──────────────────────────────────────────────────────────────

  private async detectCorrections(
    providerName: ProviderName,
    client: EmailProvider,
    folderMap: Map<string, string>,
    sinceHours: number,
  ): Promise<number> {
    try {
      const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000)
      const corrections = await client.detectCorrections(folderMap)

      // Also check recent classifications against current folder state
      const recentClassified = await getRecentClassifications(this.db, since, providerName)

      let correctionCount = 0

      // Record corrections detected by the provider's built-in detection
      for (const c of corrections) {
        await recordCorrection(this.db, {
          messageId: c.messageId,
          provider: providerName,
          oldCategory: c.oldCategory,
          newCategory: c.newCategory,
        })
        correctionCount++
      }

      if (correctionCount > 0) {
        logger.info(
          { provider: providerName, corrections: correctionCount },
          '[email-classify] corrections recorded',
        )
      }

      return correctionCount
    } catch (err) {
      logger.warn({ err, provider: providerName }, '[email-classify] correction detection failed')
      return 0
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Private: Generate and post daily summary
  // ──────────────────────────────────────────────────────────────

  private async generateAndPostSummary(sinceHours: number): Promise<boolean> {
    const today = todayDateString()

    // Check if already posted today
    const existing = await getDailySummary(this.db, today)
    if (existing?.postedToBrain) {
      logger.info({ date: today }, '[email-classify] summary already posted today')
      return false
    }

    // Get overnight category summary
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000)
    const overnightData = await getOvernightSummary(this.db, since)

    if (overnightData.length === 0) {
      logger.info('[email-classify] no emails to summarize')
      return false
    }

    // Build category counts
    const emailCount = overnightData.reduce((sum, c) => sum + c.count, 0)
    const categories: Record<string, number> = {}
    for (const cat of overnightData) {
      categories[cat.category] = cat.count
    }

    // Build summary text
    let summaryText: string

    if (this.llmGateway) {
      // Use LLM gateway for synthesis (T1/T2 tier routing)
      try {
        const emailLines = overnightData
          .flatMap((cat) =>
            cat.topSubjects.map(
              (s) => `- [${cat.category}] ${s}`,
            ),
          )
          .slice(0, 100)

        const prompt =
          `Summarize today's email activity for Troy Davis's personal knowledge system.\n\n` +
          `Date: ${today} | Total: ${emailCount}\n` +
          `Categories: ${JSON.stringify(categories)}\n\n` +
          `Sample emails:\n${emailLines.join('\n')}\n\n` +
          'Write a concise daily digest (3-5 paragraphs): volume highlights, ' +
          'actionable items by category, notable senders, patterns worth noting.'

        summaryText = await this.llmGateway.completeByTask(prompt, 'synthesis', {
          maxTokens: 1024,
        })
      } catch (err) {
        logger.warn({ err }, '[email-classify] LLM synthesis failed — using fallback')
        summaryText = this.buildFallbackSummary(emailCount, categories)
      }
    } else {
      summaryText = this.buildFallbackSummary(emailCount, categories)
    }

    // Post as capture to Open Brain
    try {
      const captureBody = {
        content: `[Email Daily Digest] ${today}\n\n${summaryText}`,
        source: 'email',
        source_metadata: {
          type: 'daily_digest',
          date: today,
          email_count: emailCount,
          categories,
        },
      }

      const res = await fetch(`${this.coreApiUrl}/api/v1/captures`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Open-Brain-Caller': 'email-classify',
        },
        body: JSON.stringify(captureBody),
        signal: AbortSignal.timeout(15_000),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '(no body)')
        logger.error(
          { status: res.status, body: body.slice(0, 200) },
          '[email-classify] failed to post summary capture',
        )
        return false
      }

      // Mark summary as posted
      await markSummaryPosted(this.db, today, emailCount, categories, summaryText)
      logger.info({ date: today, emailCount }, '[email-classify] daily summary posted')
      return true
    } catch (err) {
      logger.error({ err }, '[email-classify] failed to post summary capture')
      return false
    }
  }

  private buildFallbackSummary(
    emailCount: number,
    categories: Record<string, number>,
  ): string {
    const topCats = Object.entries(categories)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([cat, count]) => `${cat}(${count})`)
      .join(', ')

    return `[Auto] ${emailCount} emails processed. Top categories: ${topCats}`
  }
}
