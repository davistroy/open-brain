import type { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '@hono/zod-validator'
import type { SearchService } from '../services/search.js'
import type { LLMGatewayService } from '../services/llm-gateway.js'
import { logger } from '../lib/logger.js'

const synthesizeBodySchema = z.object({
  query: z.string().min(1, 'Query is required').max(2000),
  limit: z.number().int().min(1).max(30).default(10),
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

    // Step 2: build context block from captures
    const contextLines = results.map((r, i) => {
      const date = new Date(r.capture.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
      return `[${i + 1}] (${r.capture.capture_type}, ${r.capture.brain_view}, ${date})\n${r.capture.content}`
    })
    const context = contextLines.join('\n\n')

    // Step 3: synthesize with LLM
    const prompt = `You are a personal AI assistant with access to the user's knowledge base. Answer the user's question based ONLY on the captures below. Be concise and specific. If the captures do not contain enough information to answer confidently, say so.

User question: ${query}

Relevant captures from knowledge base:
${context}

Answer:`

    const response = await llmGateway.complete(prompt, 'synthesis', {
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
