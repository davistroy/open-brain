/**
 * Unit tests for the T0 Classification Validation Suite.
 *
 * Tests the validation logic, report generation, and fixture loading
 * WITHOUT requiring a live LLM endpoint. LLM calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  loadFixtures,
  getExpected,
  classifyOne,
  buildReport,
  formatReport,
  formatComparison,
  parseArgs,
  runValidation,
  ACCURACY_THRESHOLD,
  PROMPTS,
} from '../scripts/validate-t0-classification.js'
import type {
  ClassificationExample,
  SingleResult,
  LLMEndpoint,
  ClassificationTask,
  ValidationReport,
} from '../scripts/validate-t0-classification.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_EXAMPLES: ClassificationExample[] = [
  {
    id: 1,
    input: 'I decided to pursue the VP of Engineering role.',
    expected_brain_view: 'career',
    expected_capture_type: 'decision',
    expected_intent: 'capture',
  },
  {
    id: 2,
    input: 'What career decisions have I logged?',
    expected_brain_view: 'career',
    expected_capture_type: 'question',
    expected_intent: 'query',
  },
  {
    id: 3,
    input: 'The Alpine Docker image resolves localhost to IPv6.',
    expected_brain_view: 'technical',
    expected_capture_type: 'observation',
    expected_intent: 'capture',
  },
]

function mockEndpoint(tier: 't0' | 't1' = 't0'): LLMEndpoint {
  return {
    baseUrl: 'http://mock-llm:11434/v1',
    apiKey: 'test-key',
    model: 'test-model',
    tier,
    timeoutMs: 5000,
  }
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

function createMockFetchResponse(responseContent: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({
      choices: [{ message: { content: responseContent } }],
    }),
    text: async () => responseContent,
  }
}

// ---------------------------------------------------------------------------
// Tests: Fixture Loading
// ---------------------------------------------------------------------------

describe('loadFixtures', () => {
  it('loads the classification-examples.json fixture file', () => {
    const examples = loadFixtures()
    expect(examples).toHaveLength(50)
    expect(examples[0]).toHaveProperty('id')
    expect(examples[0]).toHaveProperty('input')
    expect(examples[0]).toHaveProperty('expected_brain_view')
    expect(examples[0]).toHaveProperty('expected_capture_type')
    expect(examples[0]).toHaveProperty('expected_intent')
  })

  it('has exactly 10 examples per brain view', () => {
    const examples = loadFixtures()
    const views = ['career', 'personal', 'technical', 'work-internal', 'client']
    for (const view of views) {
      const count = examples.filter((e) => e.expected_brain_view === view).length
      expect(count, `Expected 10 examples for brain view "${view}", got ${count}`).toBe(10)
    }
  })

  it('all brain views are represented', () => {
    const examples = loadFixtures()
    const views = new Set(examples.map((e) => e.expected_brain_view))
    expect(views).toEqual(new Set(['career', 'personal', 'technical', 'work-internal', 'client']))
  })

  it('all capture types are represented', () => {
    const examples = loadFixtures()
    const types = new Set(examples.map((e) => e.expected_capture_type))
    expect(types.size).toBeGreaterThanOrEqual(7) // at least 7 of 8 types
    // Must include the common types
    expect(types).toContain('decision')
    expect(types).toContain('observation')
    expect(types).toContain('task')
    expect(types).toContain('idea')
    expect(types).toContain('win')
    expect(types).toContain('question')
  })

  it('has both capture and query intents', () => {
    const examples = loadFixtures()
    const intents = new Set(examples.map((e) => e.expected_intent))
    expect(intents).toContain('capture')
    expect(intents).toContain('query')
  })

  it('every example has a non-empty input string', () => {
    const examples = loadFixtures()
    for (const ex of examples) {
      expect(ex.input.length, `Example ${ex.id} has empty input`).toBeGreaterThan(10)
    }
  })

  it('example IDs are unique and sequential 1-50', () => {
    const examples = loadFixtures()
    const ids = examples.map((e) => e.id)
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })
})

// ---------------------------------------------------------------------------
// Tests: getExpected
// ---------------------------------------------------------------------------

describe('getExpected', () => {
  const example: ClassificationExample = {
    id: 1,
    input: 'test',
    expected_brain_view: 'career',
    expected_capture_type: 'decision',
    expected_intent: 'capture',
  }

  it('returns intent value for intent task', () => {
    expect(getExpected(example, 'intent')).toBe('capture')
  })

  it('returns capture_type value for capture_type task', () => {
    expect(getExpected(example, 'capture_type')).toBe('decision')
  })

  it('returns brain_view value for brain_view task', () => {
    expect(getExpected(example, 'brain_view')).toBe('career')
  })
})

// ---------------------------------------------------------------------------
// Tests: classifyOne
// ---------------------------------------------------------------------------

describe('classifyOne', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('parses JSON response and extracts intent', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"intent":"capture"}'),
    )

    const result = await classifyOne(mockEndpoint(), 'intent', 'test input')
    expect(result.predicted).toBe('capture')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('parses capture_type from JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"capture_type":"decision"}'),
    )

    const result = await classifyOne(mockEndpoint(), 'capture_type', 'test input')
    expect(result.predicted).toBe('decision')
  })

  it('parses brain_view from JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"brain_view":"technical"}'),
    )

    const result = await classifyOne(mockEndpoint(), 'brain_view', 'test input')
    expect(result.predicted).toBe('technical')
  })

  it('handles markdown-fenced JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('```json\n{"intent":"query"}\n```'),
    )

    const result = await classifyOne(mockEndpoint(), 'intent', 'test input')
    expect(result.predicted).toBe('query')
  })

  it('falls back to bare word extraction on malformed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('capture'),
    )

    const result = await classifyOne(mockEndpoint(), 'intent', 'test input')
    expect(result.predicted).toBe('capture')
  })

  it('sends correct request body for intent task', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"intent":"capture"}'),
    )

    await classifyOne(mockEndpoint(), 'intent', 'my test text')

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const url = fetchCall[0] as string
    const opts = fetchCall[1] as RequestInit
    const body = JSON.parse(opts.body as string)

    expect(url).toBe('http://mock-llm:11434/v1/chat/completions')
    expect(body.model).toBe('test-model')
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('capture')
    expect(body.messages[1].role).toBe('user')
    expect(body.messages[1].content).toBe('my test text')
    expect(body.temperature).toBe(0)
    expect(body.max_completion_tokens).toBe(64)
  })

  it('throws on non-2xx response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('Internal server error', 500),
    )

    await expect(classifyOne(mockEndpoint(), 'intent', 'test'))
      .rejects.toThrow('HTTP 500')
  })

  it('includes Authorization header when API key is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"intent":"capture"}'),
    )

    await classifyOne(mockEndpoint('t1'), 'intent', 'test')

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = fetchCall[1] as RequestInit
    const headers = opts.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
  })

  it('omits Authorization header when API key is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"intent":"capture"}'),
    )

    const endpoint = { ...mockEndpoint(), apiKey: '' }
    await classifyOne(endpoint, 'intent', 'test')

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = fetchCall[1] as RequestInit
    const headers = opts.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: buildReport
// ---------------------------------------------------------------------------

describe('buildReport', () => {
  function makeResults(correctMap: Record<ClassificationTask, boolean[]>): SingleResult[] {
    const results: SingleResult[] = []
    let id = 1
    for (const [task, corrects] of Object.entries(correctMap) as [ClassificationTask, boolean[]][]) {
      for (const correct of corrects) {
        results.push({
          exampleId: id++,
          task,
          expected: 'expected',
          predicted: correct ? 'expected' : 'wrong',
          correct,
          latencyMs: correct ? 100 : 150,
          tier: 't0',
        })
      }
    }
    return results
  }

  it('computes per-task accuracy correctly', () => {
    const results = makeResults({
      intent: [true, true, true, true, false],           // 80%
      capture_type: [true, true, true, true, true],       // 100%
      brain_view: [true, true, true, false, false],       // 60%
    })

    const report = buildReport(results, 't0', 5)

    const intentAcc = report.taskAccuracies.find((a) => a.task === 'intent')!
    expect(intentAcc.accuracy).toBeCloseTo(0.8)
    expect(intentAcc.correct).toBe(4)
    expect(intentAcc.total).toBe(5)
    expect(intentAcc.passesThreshold).toBe(false) // 80% < 90%

    const captureTypeAcc = report.taskAccuracies.find((a) => a.task === 'capture_type')!
    expect(captureTypeAcc.accuracy).toBeCloseTo(1.0)
    expect(captureTypeAcc.passesThreshold).toBe(true)

    const brainViewAcc = report.taskAccuracies.find((a) => a.task === 'brain_view')!
    expect(brainViewAcc.accuracy).toBeCloseTo(0.6)
    expect(brainViewAcc.passesThreshold).toBe(false)
  })

  it('identifies disagreements', () => {
    const results = makeResults({
      intent: [true, false],
      capture_type: [true, true],
      brain_view: [false, true],
    })

    const report = buildReport(results, 't0', 2)
    expect(report.disagreements).toHaveLength(2)
    expect(report.disagreements.every((d) => !d.correct)).toBe(true)
  })

  it('computes overall accuracy across all tasks', () => {
    const results = makeResults({
      intent: [true, true],       // 2/2
      capture_type: [true, false], // 1/2
      brain_view: [true, true],   // 2/2
    })

    const report = buildReport(results, 't0', 2)
    // 5 correct out of 6 total = 83.3%
    expect(report.overallAccuracy).toBeCloseTo(5 / 6)
  })

  it('handles empty results', () => {
    const report = buildReport([], 't0', 0)
    expect(report.overallAccuracy).toBe(0)
    expect(report.disagreements).toHaveLength(0)
  })

  it('90% threshold is set correctly', () => {
    expect(ACCURACY_THRESHOLD).toBe(0.90)
  })

  it('passesThreshold is true at exactly 90%', () => {
    const results = makeResults({
      intent: Array(9).fill(true).concat([false]),  // 9/10 = 90%
      capture_type: [],
      brain_view: [],
    })

    const report = buildReport(results, 't0', 10)
    const intentAcc = report.taskAccuracies.find((a) => a.task === 'intent')!
    expect(intentAcc.accuracy).toBeCloseTo(0.9)
    expect(intentAcc.passesThreshold).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tests: formatReport
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  it('includes tier name in header', () => {
    const report: ValidationReport = {
      tier: 't0',
      taskAccuracies: [
        { task: 'intent', total: 50, correct: 48, accuracy: 0.96, avgLatencyMs: 120, passesThreshold: true },
        { task: 'capture_type', total: 50, correct: 45, accuracy: 0.90, avgLatencyMs: 130, passesThreshold: true },
        { task: 'brain_view', total: 50, correct: 47, accuracy: 0.94, avgLatencyMs: 110, passesThreshold: true },
      ],
      disagreements: [],
      overallAccuracy: 0.933,
      totalExamples: 50,
      totalLatencyMs: 18000,
    }

    const output = formatReport(report)
    expect(output).toContain('T0')
    expect(output).toContain('50')
    expect(output).toContain('PASS')
  })

  it('shows FAIL for tasks below threshold', () => {
    const report: ValidationReport = {
      tier: 't0',
      taskAccuracies: [
        { task: 'intent', total: 50, correct: 40, accuracy: 0.80, avgLatencyMs: 120, passesThreshold: false },
        { task: 'capture_type', total: 50, correct: 48, accuracy: 0.96, avgLatencyMs: 130, passesThreshold: true },
        { task: 'brain_view', total: 50, correct: 46, accuracy: 0.92, avgLatencyMs: 110, passesThreshold: true },
      ],
      disagreements: [
        { exampleId: 5, task: 'intent', expected: 'capture', predicted: 'query', correct: false, latencyMs: 100, tier: 't0' },
      ],
      overallAccuracy: 0.893,
      totalExamples: 50,
      totalLatencyMs: 18000,
    }

    const output = formatReport(report)
    expect(output).toContain('FAIL')
    expect(output).toContain('80.0%')
    expect(output).toContain('Disagreements')
    expect(output).toContain('expected="capture"')
    expect(output).toContain('got="query"')
  })
})

// ---------------------------------------------------------------------------
// Tests: formatComparison
// ---------------------------------------------------------------------------

describe('formatComparison', () => {
  it('shows both T0 and T1 accuracy and latency', () => {
    const t0: ValidationReport = {
      tier: 't0',
      taskAccuracies: [
        { task: 'intent', total: 50, correct: 46, accuracy: 0.92, avgLatencyMs: 80, passesThreshold: true },
        { task: 'capture_type', total: 50, correct: 45, accuracy: 0.90, avgLatencyMs: 90, passesThreshold: true },
        { task: 'brain_view', total: 50, correct: 47, accuracy: 0.94, avgLatencyMs: 70, passesThreshold: true },
      ],
      disagreements: [],
      overallAccuracy: 0.92,
      totalExamples: 50,
      totalLatencyMs: 12000,
    }

    const t1: ValidationReport = {
      tier: 't1',
      taskAccuracies: [
        { task: 'intent', total: 50, correct: 49, accuracy: 0.98, avgLatencyMs: 200, passesThreshold: true },
        { task: 'capture_type', total: 50, correct: 48, accuracy: 0.96, avgLatencyMs: 210, passesThreshold: true },
        { task: 'brain_view', total: 50, correct: 49, accuracy: 0.98, avgLatencyMs: 190, passesThreshold: true },
      ],
      disagreements: [],
      overallAccuracy: 0.973,
      totalExamples: 50,
      totalLatencyMs: 30000,
    }

    const output = formatComparison(t0, t1)
    expect(output).toContain('T0 vs T1')
    expect(output).toContain('92.0%')
    expect(output).toContain('98.0%')
    expect(output).toContain('80ms')
    expect(output).toContain('200ms')
    expect(output).toContain('12.0s')
    expect(output).toContain('30.0s')
  })
})

// ---------------------------------------------------------------------------
// Tests: parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('parses --compare flag', () => {
    const args = parseArgs(['--compare'])
    expect(args.compare).toBe(true)
  })

  it('defaults compare to false', () => {
    const args = parseArgs([])
    expect(args.compare).toBe(false)
  })

  it('parses --t0-url', () => {
    const args = parseArgs(['--t0-url', 'http://my-ollama:11434/v1'])
    expect(args.t0Url).toBe('http://my-ollama:11434/v1')
  })

  it('parses --t1-url', () => {
    const args = parseArgs(['--t1-url', 'https://custom-api.com/v1'])
    expect(args.t1Url).toBe('https://custom-api.com/v1')
  })

  it('parses --t0-model', () => {
    const args = parseArgs(['--t0-model', 'llama3:8b'])
    expect(args.t0Model).toBe('llama3:8b')
  })

  it('parses --t1-model', () => {
    const args = parseArgs(['--t1-model', 'claude-sonnet-4-20250514'])
    expect(args.t1Model).toBe('claude-sonnet-4-20250514')
  })

  it('parses --t1-api-key', () => {
    const args = parseArgs(['--t1-api-key', 'sk-test-123'])
    expect(args.t1ApiKey).toBe('sk-test-123')
  })

  it('parses --fixtures', () => {
    const args = parseArgs(['--fixtures', '/custom/path.json'])
    expect(args.fixturesPath).toBe('/custom/path.json')
  })

  it('handles multiple flags together', () => {
    const args = parseArgs([
      '--compare',
      '--t0-url', 'http://ollama:11434/v1',
      '--t1-api-key', 'sk-test',
    ])
    expect(args.compare).toBe(true)
    expect(args.t0Url).toBe('http://ollama:11434/v1')
    expect(args.t1ApiKey).toBe('sk-test')
  })
})

// ---------------------------------------------------------------------------
// Tests: runValidation (with mocked fetch)
// ---------------------------------------------------------------------------

describe('runValidation', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('runs all three tasks for each example and returns a report', async () => {
    // Mock fetch to return correct answers for all tasks
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string)
      const userContent = body.messages[1].content as string
      const systemContent = body.messages[0].content as string

      // Determine which task based on system prompt content
      let response: string
      if (systemContent.includes('four categories')) {
        // Intent classification
        response = userContent.includes('What career') ? '{"intent":"query"}' : '{"intent":"capture"}'
      } else if (systemContent.includes('capture type')) {
        // Capture type classification
        if (userContent.includes('decided')) response = '{"capture_type":"decision"}'
        else if (userContent.includes('What career')) response = '{"capture_type":"question"}'
        else response = '{"capture_type":"observation"}'
      } else {
        // Brain view classification
        if (userContent.includes('career') || userContent.includes('VP of Engineering')) response = '{"brain_view":"career"}'
        else response = '{"brain_view":"technical"}'
      }

      return createMockFetchResponse(response)
    })

    const report = await runValidation(mockEndpoint(), SAMPLE_EXAMPLES)

    expect(report.tier).toBe('t0')
    expect(report.totalExamples).toBe(3)
    // 3 examples x 3 tasks = 9 total results
    expect(report.taskAccuracies).toHaveLength(3)

    for (const ta of report.taskAccuracies) {
      expect(ta.total).toBe(3)
    }
  })

  it('handles LLM errors gracefully without crashing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'))

    const report = await runValidation(mockEndpoint(), [SAMPLE_EXAMPLES[0]])

    // Should still produce a report (all predictions will be __error__)
    expect(report.totalExamples).toBe(1)
    expect(report.disagreements.length).toBeGreaterThan(0)
  })

  it('can run against a subset of tasks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      createMockFetchResponse('{"intent":"capture"}'),
    )

    const report = await runValidation(mockEndpoint(), [SAMPLE_EXAMPLES[0]], ['intent'])

    const intentAcc = report.taskAccuracies.find((a) => a.task === 'intent')
    expect(intentAcc).toBeDefined()
    expect(intentAcc!.total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Tests: Prompt configuration
// ---------------------------------------------------------------------------

describe('PROMPTS', () => {
  it('has all three classification tasks configured', () => {
    expect(PROMPTS).toHaveProperty('intent')
    expect(PROMPTS).toHaveProperty('capture_type')
    expect(PROMPTS).toHaveProperty('brain_view')
  })

  it('intent prompt mentions all four categories', () => {
    const { system } = PROMPTS.intent
    expect(system).toContain('capture')
    expect(system).toContain('query')
    expect(system).toContain('command')
    expect(system).toContain('conversation')
  })

  it('capture_type prompt mentions all eight types', () => {
    const { system } = PROMPTS.capture_type
    expect(system).toContain('decision')
    expect(system).toContain('idea')
    expect(system).toContain('observation')
    expect(system).toContain('task')
    expect(system).toContain('win')
    expect(system).toContain('blocker')
    expect(system).toContain('question')
    expect(system).toContain('reflection')
  })

  it('brain_view prompt mentions all five views', () => {
    const { system } = PROMPTS.brain_view
    expect(system).toContain('career')
    expect(system).toContain('personal')
    expect(system).toContain('technical')
    expect(system).toContain('work-internal')
    expect(system).toContain('client')
  })

  it('response keys match expected JSON field names', () => {
    expect(PROMPTS.intent.responseKey).toBe('intent')
    expect(PROMPTS.capture_type.responseKey).toBe('capture_type')
    expect(PROMPTS.brain_view.responseKey).toBe('brain_view')
  })
})
