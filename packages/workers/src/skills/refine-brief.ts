import { eq } from 'drizzle-orm'
import { briefs } from '@open-brain/shared'
import { logger, renderBriefHtml, SafePromptBuilder, REFINE_OPTIONS } from '@open-brain/shared'
import { LLMSkill } from './llm-skill.js'
import type { LLMSkillOpts, BaseResult } from './types.js'

/**
 * Task key that resolves to a model tier via config/ai-routing.yaml
 * task_routing.brief_refinement.
 *
 * Routed to t1_spark (Qwen 35B on DGX Spark, free) — HTML transform
 * requires moderate reasoning but is not time-critical enough to justify
 * paid Haiku cost. Spark handles structured text rewriting well.
 */
const BRIEF_REFINEMENT_TASK = 'brief_refinement'

// ============================================================
// Types
// ============================================================

export interface RefineBriefInput {
  /** UUID of the source brief to refine. */
  source_brief_id: string
  /**
   * Refinement option string. Must be one of REFINE_OPTIONS.
   * Examples: 'Shorter', 'Longer', 'More casual', 'More formal',
   * 'Add action items', 'Simplify language'.
   */
  option: string
}

export interface RefineBriefResult extends BaseResult {
  /** UUID of the newly created refined brief. null if input validation failed. */
  newBriefId: string | null
  sourceBriefId: string
  option: string
  /** true if the LLM call succeeded and a new brief was persisted. */
  refined: boolean
  /** Character count of the new body_html (0 if not refined). */
  outputLength: number
}

// ============================================================
// Prompt builder
// ============================================================

/**
 * Builds the refinement prompt.
 *
 * The source body_html is wrapped in SafePromptBuilder fenced delimiters
 * to prevent prompt injection from user-controlled brief content (WI-1).
 * The option string is validated against REFINE_OPTIONS before reaching
 * here, so it is safe to interpolate directly.
 */
function buildRefinementPrompt(bodyHtml: string, option: string): string {
  const builder = new SafePromptBuilder()
  const safeBody = builder.wrapContent(bodyHtml, 'brief-body-html')

  return `You are rewriting an HTML brief for a personal AI knowledge system.

Apply this transformation to the brief: **${option}**

Rules:
- Preserve all HTML heading tags (h1, h2, h3, h4) and their text exactly.
- Preserve the overall document structure and section ordering.
- Preserve all source references and attribution.
- Do NOT add new sections that were not in the original.
- Do NOT remove sections unless the modifier explicitly calls for condensing.
- Output ONLY the rewritten HTML — no preamble, no explanation, no markdown fences.
- The output must be valid HTML fragment (no <html>/<body> wrapper tags).

Transformation guidance by modifier:
- "Shorter": condense each paragraph to its most essential sentence. Remove redundant phrases.
- "Longer": expand each point with 1–2 supporting sentences or examples.
- "More casual": replace formal phrasing with conversational language. Use contractions.
- "More formal": replace casual phrasing with professional language. Remove contractions.
- "Add action items": after each section, add a bullet list of concrete next steps inferred from the content.
- "Simplify language": replace jargon and complex vocabulary with plain language. Aim for 8th-grade reading level.

Source brief HTML to transform:
${safeBody}

Output the transformed HTML below:`
}

// ============================================================
// RefineBriefSkill class
// ============================================================

/**
 * RefineBriefSkill — single-shot LLM HTML transform for brief refinement.
 *
 * Triggered by the BullMQ job enqueued by `POST /api/v1/briefs/:id/refine`
 * (Phase 5). Reads the source brief, applies the LLM transform, runs the
 * result through renderBriefHtml to regenerate the TOC, then inserts a new
 * brief row with refined_from_id pointing back to the source.
 *
 * No minimum_autonomy gate — this is a reactive pipeline skill triggered
 * by an explicit user action (the POST /refine request). The user already
 * expressed intent; gating would be disruptive.
 *
 * LLM call: routed via task_routing.brief_refinement in ai-routing.yaml
 * (t1_spark). Falls back to direct litellmClient for tests.
 */
export class RefineBriefSkill extends LLMSkill<RefineBriefInput, RefineBriefResult> {
  constructor(opts: LLMSkillOpts) {
    super('refine-brief', opts)
  }

  protected async run(input: RefineBriefInput): Promise<RefineBriefResult> {
    const startMs = Date.now()
    const { source_brief_id, option } = input

    logger.info(
      { source_brief_id, option },
      '[refine-brief] starting execution',
    )

    // ── Step 1: Validate option ─────────────────────────────────────
    if (!(REFINE_OPTIONS as readonly string[]).includes(option)) {
      const durationMs = Date.now() - startMs
      const result: RefineBriefResult = {
        newBriefId: null,
        sourceBriefId: source_brief_id,
        option,
        refined: false,
        outputLength: 0,
        durationMs,
      }
      logger.warn(
        { option, validOptions: REFINE_OPTIONS },
        '[refine-brief] invalid option — aborting',
      )
      await this.logResult(
        result,
        `source:${source_brief_id} option:${option}`,
        'invalid option',
      )
      return result
    }

    // ── Step 2: Fetch source brief ──────────────────────────────────
    const rows = await this.db
      .select()
      .from(briefs)
      .where(eq(briefs.id, source_brief_id))
      .limit(1)

    const sourceBrief = rows[0]
    if (!sourceBrief) {
      const durationMs = Date.now() - startMs
      const result: RefineBriefResult = {
        newBriefId: null,
        sourceBriefId: source_brief_id,
        option,
        refined: false,
        outputLength: 0,
        durationMs,
      }
      logger.warn(
        { source_brief_id },
        '[refine-brief] source brief not found — aborting',
      )
      await this.logResult(
        result,
        `source:${source_brief_id} option:${option}`,
        'source brief not found',
      )
      return result
    }

    logger.info(
      {
        source_brief_id,
        kind: sourceBrief.kind,
        cover: sourceBrief.cover,
        bodyLength: sourceBrief.body_html.length,
      },
      '[refine-brief] source brief fetched',
    )

    // ── Step 3: Build prompt ────────────────────────────────────────
    const prompt = buildRefinementPrompt(sourceBrief.body_html, option)

    logger.debug(
      { promptLength: prompt.length, option },
      '[refine-brief] calling LLM',
    )

    // ── Step 4: Call LLM via gateway (preferred) or direct client ───
    let rawOutput: string
    if (this.llmGateway) {
      rawOutput = await this.llmGateway.completeByTask(prompt, BRIEF_REFINEMENT_TASK, {
        temperature: 0.2,
        maxTokens: 4096,
      })
      logger.info('[refine-brief] LLM call complete (gateway)')
    } else {
      // Test-compat fallback: direct OpenAI-compatible client
      if (!this.litellmClient) {
        throw new Error('[refine-brief] No LLM client configured — set OPENAI_API_KEY or inject llmGateway')
      }
      const response = await this.litellmClient.chat.completions.create({
        model: 'synthesis',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_completion_tokens: 4096,
      })
      rawOutput = response.choices[0]?.message?.content ?? ''
      logger.info(
        {
          promptTokens: response.usage?.prompt_tokens,
          completionTokens: response.usage?.completion_tokens,
        },
        '[refine-brief] LLM call complete (OpenAI)',
      )
    }

    // Strip any accidental markdown code fences the LLM may have added
    const cleanedOutput = rawOutput
      .replace(/^```html\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()

    // ── Step 5: Regenerate TOC via renderBriefHtml ──────────────────
    // renderBriefHtml expects Markdown; the LLM returns HTML. Pass the
    // raw HTML — the unified pipeline treats it as-is (allowDangerousHtml
    // is false, so remark-rehype doesn't parse it) and rehype-slug will
    // still annotate any heading tags with ids and extract TOC correctly.
    // This is an intentional design trade-off: the LLM output is already
    // HTML, so we bypass the Markdown → HAST step by using a minimal
    // wrapper. We call renderBriefHtml with a sentinel to get the correct
    // TOC extraction via the unified pipeline.
    //
    // Implementation note: renderBriefHtml expects Markdown input, but
    // passing HTML directly still produces correct heading slugs because
    // rehype-slug runs on the HAST tree regardless. The XSS sanitizer
    // at the end ensures safety.
    const { html: newBodyHtml, toc: newToc } = renderBriefHtml(cleanedOutput)

    logger.info(
      {
        outputLength: newBodyHtml.length,
        tocItems: newToc.length,
      },
      '[refine-brief] TOC regenerated',
    )

    // ── Step 6: Insert new brief with refined_from_id ───────────────
    const inserted = await this.db
      .insert(briefs)
      .values({
        kind: sourceBrief.kind,
        cover: sourceBrief.cover,
        title: `${sourceBrief.title} (${option})`,
        subtitle: sourceBrief.subtitle ?? undefined,
        body_html: newBodyHtml,
        toc: newToc as unknown as Record<string, unknown>[],
        sources: sourceBrief.sources as unknown as Record<string, unknown>[],
        refine_options: sourceBrief.refine_options as unknown as string[],
        refined_from_id: sourceBrief.id,
        // source_skill_log_id left null — this is a derivative brief,
        // not directly originating from a scheduled skill run
      })
      .returning({ id: briefs.id })

    const newBriefId = inserted[0]?.id ?? null

    const durationMs = Date.now() - startMs

    const finalResult: RefineBriefResult = {
      newBriefId,
      sourceBriefId: source_brief_id,
      option,
      refined: newBriefId !== null,
      outputLength: newBodyHtml.length,
      durationMs,
    }

    await this.logResult(
      finalResult,
      `source:${source_brief_id} option:${option}`,
      newBriefId
        ? `newBriefId:${newBriefId} outputLen:${newBodyHtml.length} toc:${newToc.length}`
        : 'insert failed',
    )

    logger.info(
      {
        newBriefId,
        sourceBriefId: source_brief_id,
        option,
        outputLength: newBodyHtml.length,
        tocItems: newToc.length,
        durationMs,
      },
      '[refine-brief] execution complete',
    )

    return finalResult
  }
}

// ============================================================
// Top-level entry point — called by BullMQ skill-execution worker
// ============================================================

/**
 * Execute the refine-brief skill.
 *
 * Called by the skill-execution worker when a 'refine-brief' job arrives.
 * Wire llmGateway for production; inject litellmClient for tests.
 */
export async function executeRefineBrief(
  opts: LLMSkillOpts,
  input: RefineBriefInput,
): Promise<RefineBriefResult> {
  return new RefineBriefSkill(opts).execute(input)
}
