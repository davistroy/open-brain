import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  McpActivityLogger,
  sanitizeParameters,
  truncateResult,
  RESULT_SUMMARY_MAX_LENGTH,
  SENSITIVE_PARAM_KEYS,
  type McpToolResult,
} from '../mcp/middleware/activity-logger.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockDb() {
  return {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  }
}

function makeMockActivityFeedService() {
  return {
    insert: vi.fn().mockResolvedValue({ id: 'feed-1' }),
  }
}

function makeSuccessResult(text = 'Search found 3 results'): McpToolResult {
  return { content: [{ type: 'text' as const, text }] }
}

// ---------------------------------------------------------------------------
// sanitizeParameters
// ---------------------------------------------------------------------------

describe('sanitizeParameters', () => {
  it('passes through normal parameters', () => {
    const params = { query: 'test', limit: 10, flag: true }
    const result = sanitizeParameters(params)
    expect(result).toEqual(params)
  })

  it('redacts sensitive keys', () => {
    for (const key of SENSITIVE_PARAM_KEYS) {
      const params = { [key]: 'secret-value-123' }
      const result = sanitizeParameters(params)
      expect(result[key]).toBe('[REDACTED]')
    }
  })

  it('redacts case-insensitively', () => {
    const params = { PASSWORD: 'secret', Token: 'abc' }
    const result = sanitizeParameters(params)
    expect(result['PASSWORD']).toBe('[REDACTED]')
    expect(result['Token']).toBe('[REDACTED]')
  })

  it('truncates long string values to 200 chars', () => {
    const longValue = 'x'.repeat(300)
    const params = { query: longValue }
    const result = sanitizeParameters(params)
    expect((result.query as string).length).toBe(203) // 200 + '...'
    expect((result.query as string).endsWith('...')).toBe(true)
  })

  it('does not truncate strings under 200 chars', () => {
    const value = 'x'.repeat(200)
    const params = { query: value }
    const result = sanitizeParameters(params)
    expect(result.query).toBe(value)
  })
})

// ---------------------------------------------------------------------------
// truncateResult
// ---------------------------------------------------------------------------

describe('truncateResult', () => {
  it('returns empty string for empty content', () => {
    expect(truncateResult({ content: [] })).toBe('')
  })

  it('returns full text if under max length', () => {
    const result = makeSuccessResult('Short result')
    expect(truncateResult(result)).toBe('Short result')
  })

  it('truncates long results', () => {
    const longText = 'y'.repeat(RESULT_SUMMARY_MAX_LENGTH + 100)
    const result = makeSuccessResult(longText)
    const truncated = truncateResult(result)
    expect(truncated.length).toBe(RESULT_SUMMARY_MAX_LENGTH + 3) // + '...'
    expect(truncated.endsWith('...')).toBe(true)
  })

  it('concatenates multiple text content blocks', () => {
    const result: McpToolResult = {
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ],
    }
    expect(truncateResult(result)).toBe('Part 1\nPart 2')
  })
})

// ---------------------------------------------------------------------------
// McpActivityLogger
// ---------------------------------------------------------------------------

describe('McpActivityLogger', () => {
  let mockDb: ReturnType<typeof makeMockDb>
  let logger: McpActivityLogger

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = makeMockDb()
    logger = new McpActivityLogger(mockDb as any)
  })

  describe('logActivity', () => {
    it('inserts into mcp_activity table', async () => {
      await logger.logActivity({
        tool_name: 'search_brain',
        parameters: { query: 'test' },
        result_summary: 'Found 5 results',
        duration_ms: 123,
        client_id: 'abc123',
      })

      expect(mockDb.insert).toHaveBeenCalledOnce()
      const insertChain = mockDb.insert.mock.results[0].value
      expect(insertChain.values).toHaveBeenCalledWith({
        tool_name: 'search_brain',
        client_id: 'abc123',
        parameters: { query: 'test' },
        result_summary: 'Found 5 results',
        duration_ms: 123,
        metadata: null,
      })
    })

    it('handles null optional fields', async () => {
      await logger.logActivity({ tool_name: 'brain_stats' })

      const insertChain = mockDb.insert.mock.results[0].value
      expect(insertChain.values).toHaveBeenCalledWith({
        tool_name: 'brain_stats',
        client_id: null,
        parameters: null,
        result_summary: null,
        duration_ms: null,
        metadata: null,
      })
    })

    it('inserts into activity feed when service is available', async () => {
      const mockFeed = makeMockActivityFeedService()
      const loggerWithFeed = new McpActivityLogger(mockDb as any, mockFeed as any)

      await loggerWithFeed.logActivity({
        tool_name: 'search_brain',
        duration_ms: 42,
        client_id: 'client-1',
      })

      expect(mockFeed.insert).toHaveBeenCalledOnce()
      expect(mockFeed.insert).toHaveBeenCalledWith({
        type: 'mcp',
        subtype: 'search_brain',
        summary: 'MCP tool "search_brain" called (42ms)',
        detail: {
          tool_name: 'search_brain',
          duration_ms: 42,
          client_id: 'client-1',
          has_error: false,
        },
      })
    })

    it('does not throw when activity feed insert fails', async () => {
      const mockFeed = makeMockActivityFeedService()
      mockFeed.insert.mockRejectedValue(new Error('feed down'))
      const loggerWithFeed = new McpActivityLogger(mockDb as any, mockFeed as any)

      // Should not throw
      await loggerWithFeed.logActivity({
        tool_name: 'test_tool',
      })
    })
  })

  describe('wrapToolHandler', () => {
    it('calls the original handler and returns its result', async () => {
      const handler = vi.fn().mockResolvedValue(makeSuccessResult())
      const wrapped = logger.wrapToolHandler('search_brain', handler, 'client-1')

      const result = await wrapped({ query: 'test' })

      expect(handler).toHaveBeenCalledWith({ query: 'test' })
      expect(result).toEqual(makeSuccessResult())
    })

    it('logs successful tool calls', async () => {
      const handler = vi.fn().mockResolvedValue(makeSuccessResult('Found 3 results'))
      const wrapped = logger.wrapToolHandler('search_brain', handler, 'client-1')

      await wrapped({ query: 'hello' })

      // Wait for the fire-and-forget log to land (deterministic, not a fixed sleep)
      await vi.waitFor(() => expect(mockDb.insert).toHaveBeenCalled())

      expect(mockDb.insert).toHaveBeenCalledOnce()
      const insertChain = mockDb.insert.mock.results[0].value
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_name: 'search_brain',
          client_id: 'client-1',
          parameters: { query: 'hello' },
        }),
      )
    })

    it('logs error tool calls and re-throws', async () => {
      const error = new Error('Database connection failed')
      const handler = vi.fn().mockRejectedValue(error)
      const wrapped = logger.wrapToolHandler('search_brain', handler, 'client-1')

      await expect(wrapped({ query: 'test' })).rejects.toThrow('Database connection failed')

      // Wait for the fire-and-forget log to land (deterministic, not a fixed sleep)
      await vi.waitFor(() => expect(mockDb.insert).toHaveBeenCalled())

      expect(mockDb.insert).toHaveBeenCalledOnce()
      const insertChain = mockDb.insert.mock.results[0].value
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_name: 'search_brain',
          result_summary: expect.stringContaining('ERROR: Database connection failed'),
          metadata: { error: true, error_message: 'Database connection failed' },
        }),
      )
    })

    it('sanitizes parameters before logging', async () => {
      const handler = vi.fn().mockResolvedValue(makeSuccessResult())
      const wrapped = logger.wrapToolHandler('capture_thought', handler)

      await wrapped({ content: 'idea', token: 'secret-123' })

      // Wait for the fire-and-forget log to land (deterministic, not a fixed sleep)
      await vi.waitFor(() => expect(mockDb.insert).toHaveBeenCalled())

      const insertChain = mockDb.insert.mock.results[0].value
      const call = insertChain.values.mock.calls[0][0]
      expect(call.parameters.token).toBe('[REDACTED]')
      expect(call.parameters.content).toBe('idea')
    })

    it('records duration_ms', async () => {
      const handler = vi.fn().mockImplementation(async () => {
        // Simulate work — just enough to register a non-zero duration
        return makeSuccessResult()
      })
      const wrapped = logger.wrapToolHandler('brain_stats', handler)

      await wrapped({})

      // Wait for the fire-and-forget log to land (deterministic, not a fixed sleep)
      await vi.waitFor(() => expect(mockDb.insert).toHaveBeenCalled())

      const insertChain = mockDb.insert.mock.results[0].value
      const call = insertChain.values.mock.calls[0][0]
      expect(typeof call.duration_ms).toBe('number')
      expect(call.duration_ms).toBeGreaterThanOrEqual(0)
    })

    it('does not block tool execution when logging fails', async () => {
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockRejectedValue(new Error('DB write failed')),
      })
      const handler = vi.fn().mockResolvedValue(makeSuccessResult())
      const wrapped = logger.wrapToolHandler('test_tool', handler)

      // Should still return the tool result despite logging failure
      const result = await wrapped({ query: 'test' })
      expect(result).toEqual(makeSuccessResult())
    })
  })
})
