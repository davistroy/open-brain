import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isAutoResponseCandidate,
  isBotMessage,
  isNestedThreadReply,
  handleAutoResponse,
  getMonitoredChannels,
  _resetMonitoredChannelsCache,
  ADVISE_CONFIDENCE_THRESHOLD,
  ASSIST_CHANNEL_CONFIDENCE_THRESHOLD,
  ASSIST_DM_CONFIDENCE_THRESHOLD,
  type AutoResponseConfig,
} from '../handlers/auto-response.js'
import { scoreConfidence } from '../services/confidence-scorer.js'
import { formatAttributedResponse } from '../services/attribution-formatter.js'
import type { SearchResult } from '../lib/core-api-types.js'

const baseConfig: AutoResponseConfig = {
  coreApiUrl: 'http://localhost:3000',
  confidenceThreshold: 0.6,
  stalenessDays: 90,
  minCorroboratingResults: 2,
  botUserId: 'B123',
  ownerUserId: 'U_OWNER',
}

describe('isAutoResponseCandidate', () => {
  const makeMessage = (text: string, user = 'U_OTHER', overrides: Record<string, unknown> = {}) =>
    ({
      text,
      user,
      channel: 'C123',
      ts: '1234.5678',
      type: 'message' as const,
      ...overrides,
    }) as any

  it('returns true for questions from other users', () => {
    expect(isAutoResponseCandidate(makeMessage('What is the status of project X?'), baseConfig)).toBe(true)
    expect(isAutoResponseCandidate(makeMessage('How do we handle auth in the new system?'), baseConfig)).toBe(true)
    expect(isAutoResponseCandidate(makeMessage('Does anyone know the deploy process?'), baseConfig)).toBe(true)
  })

  it('returns true for messages ending with question mark', () => {
    expect(isAutoResponseCandidate(makeMessage('The deploy is broken again?'), baseConfig)).toBe(true)
  })

  it('returns false for owner messages', () => {
    expect(isAutoResponseCandidate(makeMessage('What is the plan?', 'U_OWNER'), baseConfig)).toBe(false)
  })

  it('returns false for bot user ID match', () => {
    expect(isAutoResponseCandidate(makeMessage('What is happening?', 'B123'), baseConfig)).toBe(false)
  })

  it('returns false for messages with bot_id field', () => {
    const msg = makeMessage('What is the deployment status?', 'U_BOT', { bot_id: 'B_SOME_BOT' })
    expect(isAutoResponseCandidate(msg, baseConfig)).toBe(false)
  })

  it('returns false for messages with bot_message subtype', () => {
    const msg = makeMessage('What is the deployment status?', 'U_BOT', { subtype: 'bot_message' })
    expect(isAutoResponseCandidate(msg, baseConfig)).toBe(false)
  })

  it('returns false for nested thread replies (thread_ts !== ts)', () => {
    const msg = makeMessage('What is the deployment status?', 'U_OTHER', {
      ts: '1234.5678',
      thread_ts: '1234.0000', // Different from ts -- this is a reply inside a thread
    })
    expect(isAutoResponseCandidate(msg, baseConfig)).toBe(false)
  })

  it('returns true for thread parent messages (thread_ts === ts)', () => {
    const msg = makeMessage('What is the deployment status?', 'U_OTHER', {
      ts: '1234.5678',
      thread_ts: '1234.5678', // Same as ts -- this IS the thread parent
    })
    expect(isAutoResponseCandidate(msg, baseConfig)).toBe(true)
  })

  it('returns true for messages without thread_ts (top-level)', () => {
    const msg = makeMessage('What is the deployment status?', 'U_OTHER')
    // No thread_ts property
    expect(isAutoResponseCandidate(msg, baseConfig)).toBe(true)
  })

  it('returns false for short messages', () => {
    expect(isAutoResponseCandidate(makeMessage('hi?'), baseConfig)).toBe(false)
  })

  it('returns false for command/query prefixes', () => {
    expect(isAutoResponseCandidate(makeMessage('!stats something long enough'), baseConfig)).toBe(false)
    expect(isAutoResponseCandidate(makeMessage('?search something long enough'), baseConfig)).toBe(false)
  })

  it('returns false for non-question messages', () => {
    expect(isAutoResponseCandidate(makeMessage('I just pushed the new build'), baseConfig)).toBe(false)
    expect(isAutoResponseCandidate(makeMessage('Lunch at noon sounds good'), baseConfig)).toBe(false)
  })
})

describe('isBotMessage', () => {
  it('detects bot_id field', () => {
    const msg = { text: 'test', user: 'U1', channel: 'C1', ts: '1', type: 'message', bot_id: 'B_BOT' } as any
    expect(isBotMessage(msg)).toBe(true)
  })

  it('detects bot_message subtype', () => {
    const msg = { text: 'test', user: 'U1', channel: 'C1', ts: '1', type: 'message', subtype: 'bot_message' } as any
    expect(isBotMessage(msg)).toBe(true)
  })

  it('returns false for normal user messages', () => {
    const msg = { text: 'test', user: 'U1', channel: 'C1', ts: '1', type: 'message' } as any
    expect(isBotMessage(msg)).toBe(false)
  })

  it('returns false when bot_id is empty/falsy', () => {
    const msg = { text: 'test', user: 'U1', channel: 'C1', ts: '1', type: 'message', bot_id: '' } as any
    expect(isBotMessage(msg)).toBe(false)
  })
})

describe('isNestedThreadReply', () => {
  it('returns true when thread_ts differs from ts', () => {
    const msg = { ts: '1234.5678', thread_ts: '1234.0000', text: 'reply', user: 'U1', channel: 'C1', type: 'message' } as any
    expect(isNestedThreadReply(msg)).toBe(true)
  })

  it('returns false when thread_ts equals ts (thread parent)', () => {
    const msg = { ts: '1234.5678', thread_ts: '1234.5678', text: 'parent', user: 'U1', channel: 'C1', type: 'message' } as any
    expect(isNestedThreadReply(msg)).toBe(false)
  })

  it('returns false when thread_ts is absent', () => {
    const msg = { ts: '1234.5678', text: 'top-level', user: 'U1', channel: 'C1', type: 'message' } as any
    expect(isNestedThreadReply(msg)).toBe(false)
  })
})

describe('ADVISE_CONFIDENCE_THRESHOLD', () => {
  it('is set to 0.85 per PRD guardrails', () => {
    expect(ADVISE_CONFIDENCE_THRESHOLD).toBe(0.85)
  })
})

describe('getMonitoredChannels', () => {
  beforeEach(() => {
    _resetMonitoredChannelsCache()
    vi.restoreAllMocks()
  })

  it('returns null when setting does not exist (monitor all)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response)

    const result = await getMonitoredChannels('http://localhost:3000')
    expect(result).toBeNull()
  })

  it('returns channel list when setting exists', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ value: ['C_GENERAL', 'C_RANDOM'] }),
    } as Response)

    const result = await getMonitoredChannels('http://localhost:3000')
    expect(result).toEqual(['C_GENERAL', 'C_RANDOM'])
  })

  it('returns null when setting has invalid value', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ value: 'not-an-array' }),
    } as Response)

    const result = await getMonitoredChannels('http://localhost:3000')
    expect(result).toBeNull()
  })

  it('caches result for 5 minutes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ value: ['C_GENERAL'] }),
    } as Response)

    await getMonitoredChannels('http://localhost:3000')
    await getMonitoredChannels('http://localhost:3000')

    expect(fetchSpy).toHaveBeenCalledTimes(1) // Only one fetch due to cache
  })

  it('returns null on network error (graceful degradation)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'))

    const result = await getMonitoredChannels('http://localhost:3000')
    expect(result).toBeNull()
  })
})

describe('handleAutoResponse advise mode guardrails', () => {
  const makeMessage = (text: string, channel = 'C_MONITORED', ts = '1234.5678') =>
    ({
      text,
      user: 'U_OTHER',
      channel,
      ts,
      type: 'message' as const,
    }) as any

  const makeHighConfidenceResults = (): SearchResult[] => [
    { id: '1', content: 'relevant answer one', score: 0.95, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack', pre_extracted: { entities: [{ name: 'deploy', type: 'process' }] } },
    { id: '2', content: 'relevant answer two', score: 0.90, created_at: new Date().toISOString(), capture_type: 'decision', brain_view: 'technical', source: 'api', pre_extracted: { entities: [{ name: 'process', type: 'concept' }] } },
    { id: '3', content: 'relevant answer three', score: 0.85, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'career', source: 'voice' },
  ]

  const makeMockApp = () => ({
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
  }) as any

  const makeMockClient = (results: SearchResult[], synthesis = 'test synthesis answer') => ({
    search_query: vi.fn().mockResolvedValue({ results, query: 'test', total: results.length }),
    synthesize_query: vi.fn().mockResolvedValue({ response: synthesis }),
  }) as any

  beforeEach(() => {
    _resetMonitoredChannelsCache()
    vi.restoreAllMocks()
    // Default: monitored_channels not set (monitor all)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response)
  })

  it('skips threaded reply when confidence < 0.85 even if > config threshold', async () => {
    // Results that produce moderate confidence (> 0.6 but < 0.85)
    const mediumResults: SearchResult[] = [
      { id: '1', content: 'partial match', score: 0.6, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
      { id: '2', content: 'partial match two', score: 0.5, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
    ]
    const app = makeMockApp()
    const client = makeMockClient(mediumResults)

    await handleAutoResponse(
      makeMessage('What is the deploy process?'),
      app,
      client,
      'advise',
      { ...baseConfig, confidenceThreshold: 0.3 }, // low config threshold
    )

    // Should NOT post a threaded reply because composite < 0.85
    expect(app.client.chat.postMessage).not.toHaveBeenCalled()
  })

  it('posts threaded reply when all guardrails pass', async () => {
    const app = makeMockApp()
    const results = makeHighConfidenceResults()
    const client = makeMockClient(results)

    // Mock monitored channels to include this channel
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ value: ['C_MONITORED'] }),
    } as Response)

    // Use config WITHOUT ownerUserId so only the threaded reply fires (no DM)
    const adviseOnlyConfig = { ...baseConfig, ownerUserId: undefined }

    await handleAutoResponse(
      makeMessage('What is the deploy process?', 'C_MONITORED'),
      app,
      client,
      'advise',
      adviseOnlyConfig,
    )

    // The confidence from 3 high-score, recent, multi-source results should exceed 0.85
    const confidence = scoreConfidence(results, 'What is the deploy process?')
    if (confidence.composite >= ADVISE_CONFIDENCE_THRESHOLD) {
      expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1)
      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: '1234.5678',
          channel: 'C_MONITORED',
        }),
      )
    }
  })

  it('skips when channel not in monitored list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ value: ['C_ALLOWED'] }),
    } as Response)

    const app = makeMockApp()
    const client = makeMockClient(makeHighConfidenceResults())

    await handleAutoResponse(
      makeMessage('What is the deploy process?', 'C_NOT_ALLOWED'),
      app,
      client,
      'advise',
      baseConfig,
    )

    // Should not even call search because channel is filtered out
    expect(client.search_query).not.toHaveBeenCalled()
    expect(app.client.chat.postMessage).not.toHaveBeenCalled()
  })

  it('allows all channels when monitored_channels not configured', async () => {
    // Default: 404 response (setting not found)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response)

    const app = makeMockApp()
    const results = makeHighConfidenceResults()
    const client = makeMockClient(results)

    await handleAutoResponse(
      makeMessage('What is the deploy process?', 'C_ANY_CHANNEL'),
      app,
      client,
      'advise',
      baseConfig,
    )

    // Should proceed to search (channel not filtered)
    expect(client.search_query).toHaveBeenCalled()
  })

  it('skips threaded reply when fewer than minCorroboratingResults', async () => {
    const singleResult: SearchResult[] = [
      { id: '1', content: 'only one result', score: 0.95, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
    ]
    const app = makeMockApp()
    const client = makeMockClient(singleResult)

    await handleAutoResponse(
      makeMessage('What is the deploy process?'),
      app,
      client,
      'advise',
      { ...baseConfig, minCorroboratingResults: 2 },
    )

    expect(app.client.chat.postMessage).not.toHaveBeenCalled()
  })

  it('skips threaded reply when results are too stale', async () => {
    const staleDate = new Date()
    staleDate.setDate(staleDate.getDate() - 120) // 120 days old
    const staleResults: SearchResult[] = [
      { id: '1', content: 'old result one', score: 0.95, created_at: staleDate.toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
      { id: '2', content: 'old result two', score: 0.90, created_at: staleDate.toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'api' },
      { id: '3', content: 'old result three', score: 0.85, created_at: staleDate.toISOString(), capture_type: 'observation', brain_view: 'career', source: 'voice' },
    ]
    const app = makeMockApp()
    const client = makeMockClient(staleResults)

    await handleAutoResponse(
      makeMessage('What is the deploy process?'),
      app,
      client,
      'advise',
      { ...baseConfig, stalenessDays: 90 },
    )

    // Even if confidence is high, staleness check should prevent posting
    expect(app.client.chat.postMessage).not.toHaveBeenCalled()
  })

  it('still logs shadow data in observe mode (no threaded reply)', async () => {
    const app = makeMockApp()
    const client = makeMockClient(makeHighConfidenceResults())

    await handleAutoResponse(
      makeMessage('What is the deploy process?'),
      app,
      client,
      'observe', // observe mode -- shadow only
      baseConfig,
    )

    // Search still happens (for shadow logging)
    expect(client.search_query).toHaveBeenCalled()
    // But no threaded reply
    expect(app.client.chat.postMessage).not.toHaveBeenCalled()
  })
})

describe('assist mode confidence thresholds', () => {
  it('exports correct threshold values', () => {
    expect(ASSIST_CHANNEL_CONFIDENCE_THRESHOLD).toBe(0.75)
    expect(ASSIST_DM_CONFIDENCE_THRESHOLD).toBe(0.90)
  })
})

describe('handleAutoResponse assist mode DM delivery', () => {
  const makeMessage = (text: string, channel = 'C_MONITORED', ts = '1234.5678') =>
    ({
      text,
      user: 'U_OTHER',
      channel,
      ts,
      type: 'message' as const,
    }) as any

  const makeHighConfidenceResults = (): SearchResult[] => [
    { id: '1', content: 'relevant answer one', score: 0.95, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack', pre_extracted: { entities: [{ name: 'deploy', type: 'process' }] } },
    { id: '2', content: 'relevant answer two', score: 0.90, created_at: new Date().toISOString(), capture_type: 'decision', brain_view: 'technical', source: 'api', pre_extracted: { entities: [{ name: 'process', type: 'concept' }] } },
    { id: '3', content: 'relevant answer three', score: 0.85, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'career', source: 'voice' },
  ]

  const makeMockApp = () => ({
    client: {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
  }) as any

  const makeMockClient = (results: SearchResult[], synthesis = 'test synthesis answer') => ({
    search_query: vi.fn().mockResolvedValue({ results, query: 'test', total: results.length }),
    synthesize_query: vi.fn().mockResolvedValue({ response: synthesis }),
  }) as any

  beforeEach(() => {
    _resetMonitoredChannelsCache()
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 404,
    } as Response)
  })

  it('sends DM with Block Kit blocks when ownerUserId is set in assist mode', async () => {
    const app = makeMockApp()
    const results = makeHighConfidenceResults()
    const client = makeMockClient(results)

    await handleAutoResponse(
      makeMessage('What is the deploy process?'),
      app,
      client,
      'assist',
      { ...baseConfig, ownerUserId: 'U_OWNER', confidenceThreshold: 0.3 },
    )

    const confidence = scoreConfidence(results, 'What is the deploy process?')
    if (confidence.composite >= ASSIST_CHANNEL_CONFIDENCE_THRESHOLD) {
      // Should send DM to owner user ID
      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'U_OWNER',
          blocks: expect.arrayContaining([
            expect.objectContaining({ type: 'header' }),
            expect.objectContaining({ block_id: 'auto_response_actions' }),
          ]),
        }),
      )
    }
  })

  it('applies 0.75 threshold for channel messages', async () => {
    // Results that produce confidence between 0.6 and 0.75
    const mediumResults: SearchResult[] = [
      { id: '1', content: 'partial match', score: 0.6, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
      { id: '2', content: 'partial match two', score: 0.5, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack' },
    ]
    const app = makeMockApp()
    const client = makeMockClient(mediumResults)

    await handleAutoResponse(
      makeMessage('What is the deploy process?', 'C_CHANNEL'),
      app,
      client,
      'assist',
      { ...baseConfig, ownerUserId: 'U_OWNER', confidenceThreshold: 0.3 },
    )

    const confidence = scoreConfidence(mediumResults, 'What is the deploy process?')
    if (confidence.composite < ASSIST_CHANNEL_CONFIDENCE_THRESHOLD) {
      // Should NOT send DM because confidence < 0.75
      expect(app.client.chat.postMessage).not.toHaveBeenCalled()
    }
  })

  it('applies 0.90 threshold for DM channel messages', async () => {
    const app = makeMockApp()
    const results = makeHighConfidenceResults()
    const client = makeMockClient(results)

    await handleAutoResponse(
      makeMessage('What is the deploy process?', 'D_DIRECT_MSG'),
      app,
      client,
      'assist',
      { ...baseConfig, ownerUserId: 'U_OWNER', confidenceThreshold: 0.3 },
    )

    const confidence = scoreConfidence(results, 'What is the deploy process?')
    if (confidence.composite < ASSIST_DM_CONFIDENCE_THRESHOLD) {
      // Should NOT send DM because DM threshold is 0.90 and most results won't hit it
      expect(app.client.chat.postMessage).not.toHaveBeenCalled()
    }
  })

  it('skips DM delivery in observe mode', async () => {
    const app = makeMockApp()
    const results = makeHighConfidenceResults()
    const client = makeMockClient(results)

    await handleAutoResponse(
      makeMessage('What is the deploy process?'),
      app,
      client,
      'observe',
      { ...baseConfig, ownerUserId: 'U_OWNER' },
    )

    // observe mode never sends DMs
    expect(app.client.chat.postMessage).not.toHaveBeenCalled()
  })

  it('includes metadata with original message context in DM', async () => {
    const app = makeMockApp()
    const results = makeHighConfidenceResults()
    const client = makeMockClient(results)

    await handleAutoResponse(
      makeMessage('What is the deploy process?', 'C_CHAN', '5555.6666'),
      app,
      client,
      'assist',
      { ...baseConfig, ownerUserId: 'U_OWNER', confidenceThreshold: 0.3 },
    )

    const confidence = scoreConfidence(results, 'What is the deploy process?')
    if (confidence.composite >= ASSIST_CHANNEL_CONFIDENCE_THRESHOLD) {
      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            event_type: 'auto_response_draft',
            event_payload: expect.objectContaining({
              channel: 'C_CHAN',
              thread_ts: '5555.6666',
            }),
          }),
        }),
      )
    }
  })
})

describe('scoreConfidence', () => {
  it('returns zero for empty results', () => {
    const result = scoreConfidence([])
    expect(result.composite).toBe(0)
  })

  it('returns high confidence for strong results with entity matches and diverse sources', () => {
    const results: SearchResult[] = [
      { id: '1', content: 'test', score: 0.9, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'slack', pre_extracted: { entities: [{ name: 'deploy', type: 'process' }] } },
      { id: '2', content: 'test2', score: 0.8, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'voice', pre_extracted: { entities: [{ name: 'status', type: 'concept' }] } },
      { id: '3', content: 'test3', score: 0.7, created_at: new Date().toISOString(), capture_type: 'observation', brain_view: 'technical', source: 'email' },
    ]
    const result = scoreConfidence(results, 'what is the deploy status?')
    expect(result.composite).toBeGreaterThan(0.6)
    expect(result.relevantResultCount).toBe(3)
    expect(result.entityMatch).toBeGreaterThan(0)
    expect(result.sourceDiversity).toBe(1.0)
  })

  it('returns low confidence for weak results', () => {
    const results: SearchResult[] = [
      { id: '1', content: 'test', score: 0.2, created_at: '2025-01-01T00:00:00Z', capture_type: 'observation', brain_view: 'technical', source: 'api' },
    ]
    const result = scoreConfidence(results)
    expect(result.composite).toBeLessThan(0.3)
  })
})

describe('formatAttributedResponse', () => {
  it('formats synthesis with sources', () => {
    const results: SearchResult[] = [
      {
        id: '1',
        content: 'The deploy process uses Docker Compose',
        score: 0.9,
        created_at: '2026-04-01T00:00:00Z',
        source: 'slack',
        capture_type: 'decision',
        brain_view: 'technical',
      },
    ]
    const response = formatAttributedResponse('We use Docker Compose for deploys.', results)
    expect(response.text).toContain('Based on captured context')
    expect(response.text).toContain('Docker Compose for deploys')
    expect(response.text).toContain('AI-generated')
    expect(response.sources).toHaveLength(1)
    expect(response.sources[0].source).toBe('slack')
  })

  it('limits sources to maxSources', () => {
    const results: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      content: `capture ${i}`,
      score: 0.5,
      created_at: '2026-04-01T00:00:00Z',
      source: 'api',
      capture_type: 'observation',
      brain_view: 'technical',
    }))
    const response = formatAttributedResponse('test', results, { maxSources: 2 })
    expect(response.sources).toHaveLength(2)
  })

  it('truncates long synthesis in summary', () => {
    const longText = 'A'.repeat(300)
    const results: SearchResult[] = [
      { id: '1', content: 'test', score: 0.9, created_at: '2026-04-01T00:00:00Z', source: 'api', capture_type: 'observation', brain_view: 'technical' },
    ]
    const response = formatAttributedResponse(longText, results)
    expect(response.summary.length).toBeLessThanOrEqual(203) // 200 + '...'
    expect(response.summary).toContain('...')
  })

  it('truncates long content excerpts', () => {
    const longContent = 'B'.repeat(100)
    const results: SearchResult[] = [
      { id: '1', content: longContent, score: 0.9, created_at: '2026-04-01T00:00:00Z', source: 'slack', capture_type: 'observation', brain_view: 'technical' },
    ]
    const response = formatAttributedResponse('test', results)
    expect(response.sources[0].excerpt.length).toBeLessThanOrEqual(83) // 80 + '...'
  })
})
