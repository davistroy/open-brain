import type { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { SearchService } from '../services/search.js'
import type { LLMGatewayService } from '@open-brain/shared'
import { logger, SafePromptBuilder } from '@open-brain/shared'

const synthesizeBodySchema = z.object({
  query: z.string().min(1, 'Query is required').max(2000),
  // Default 5 — many captures are file-ingested at 50,000 chars (~12,500 tokens)
  // each, so 10 hits Spark vLLM's 32k context ceiling. Long-term: per-capture
  // token-budget truncation (similar to #204 for monthly-reflection).
  limit: z.number().int().min(1).max(30).default(5),
})

/**
 * Register the synthesize route.
 *
 * POST /api/v1/synthesize
 * Body: { query: string, limit?: number }
 *
 * Runs a hybrid search over captures, then asks the LLM to synthesize a
 * coherent answer grounded in those results. Falls back to FTS-only search
 * if embedding is unavailable.
 *
 * Response: { response: string, capture_count: number }
 */
export function registerSynthesizeRoutes(
  app: Hono,
  searchService: SearchService,
  llmGateway: LLMGatewayService,
): void {
  app.post('/api/v1/synthesize', zValidator('json', synthesizeBodySchema), async (c) => {
    const { query, limit } = c.req.valid('json')

    logger.info({ query: query.slice(0, 100), limit }, '[synthesize] request received')

    // Step 1: retrieve relevant captures — try hybrid, fall back to FTS
    let results
    try {
      results = await searchService.search(query, { limit, searchMode: 'hybrid' })
    } catch {
      // Embedding unavailable — fall back to FTS so the endpoint still works
      logger.warn('[synthesize] embedding unavailable, falling back to FTS')
      results = await searchService.search(query, { limit, searchMode: 'fts' })
    }

    if (results.length === 0) {
      return c.json({
        response: "I couldn't find any captures in your brain that are relevant to this query. Try capturing more notes first.",
        capture_count: 0,
      })
    }

    // Step 2: build context block from captures — sanitize via SafePromptBuilder (WI-1)
    const builder = new SafePromptBuilder()
    const safeQuery = builder.sanitizeInline(query, 'query')
    const contextBlocks = results.map((r, i) => {
      const date = new Date(r.capture.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      const label = `[${i + 1}] (${r.capture.capture_type}, ${r.capture.brain_view}, ${date})`
      return `${label}\n${builder.wrapContent(r.capture.content, r.capture.id!)}`
    })
    const context = contextBlocks.join('\n\n')

    // Step 3: synthesize with LLM
    const prompt = `You are a personal AI assistant with access to the user's knowledge base. Answer the user's question based ONLY on the captures below. Be concise and specific. If the captures do not contain enough information to answer confidently, say so.

User question: ${safeQuery}

Relevant captures from knowledge base:
${context}

Answer:`

    const response = await llmGateway.completeByTask(prompt, 'search_synthesis', {
      maxTokens: 1024,
      temperature: 0.2,
    })

    logger.info({ captureCount: results.length }, '[synthesize] complete')

    return c.json({
      response: response.trim(),
      capture_count: results.length,
    })
  })
}
