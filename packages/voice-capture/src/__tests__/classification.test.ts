import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClassificationService } from '../services/classification.js'

// Mock the OpenAI SDK
vi.mock('openai', () => {
  const mockCreate = vi.fn()
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
    __mockCreate: mockCreate,
  }
})

// Helper to get the mock create function from OpenAI module
async function getMockCreate() {
  const openaiModule = await import('openai')
  // The mock instance is created per ClassificationService constructor call;
  // we need to grab it from the mock implementation
  const OpenAIMock = openaiModule.default as unknown as ReturnType<typeof vi.fn>
  const instance = OpenAIMock.mock.results[OpenAIMock.mock.results.length - 1]?.value
  return instance?.chat?.completions?.create as ReturnType<typeof vi.fn>
}

describe('ClassificationService', () => {
  let service: ClassificationService
  let mockCreate: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    service = new ClassificationService()
    mockCreate = await getMockCreate()
  })

  describe('classify — success paths', () => {
    it('returns template, confidence, fields, and transcript_raw on valid JSON response', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'idea',
              confidence: 0.92,
              fields: [
                { name: 'summary', value: 'An idea about AI knowledge management' },
                { name: 'topics', value: 'AI, knowledge, automation' },
              ],
            }),
          },
        }],
      })

      const result = await service.classify('I have an idea about building an AI knowledge base.')

      expect(result.template).toBe('idea')
      expect(result.confidence).toBe(0.92)
      expect(result.fields).toHaveLength(2)
      expect(result.fields[0].name).toBe('summary')
      expect(result.fields[1].name).toBe('topics')
      expect(result.transcript_raw).toBe('I have an idea about building an AI knowledge base.')
    })

    it('classifies a decision with rationale field', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'decision',
              confidence: 0.88,
              fields: [
                { name: 'summary', value: 'Decided to use TypeScript monorepo' },
                { name: 'topics', value: 'architecture, TypeScript' },
                { name: 'rationale', value: 'Better code sharing and type safety' },
              ],
            }),
          },
        }],
      })

      const result = await service.classify('We decided to go with a TypeScript monorepo for better type safety.')

      expect(result.template).toBe('decision')
      expect(result.fields.find(f => f.name === 'rationale')).toBeDefined()
    })

    it('classifies a task with action field', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'task',
              confidence: 0.95,
              fields: [
                { name: 'summary', value: 'Need to write unit tests' },
                { name: 'topics', value: 'testing, voice-capture' },
                { name: 'action', value: 'Write Vitest unit tests for all service classes' },
              ],
            }),
          },
        }],
      })

      const result = await service.classify('I need to write unit tests for the voice capture service.')

      expect(result.template).toBe('task')
      expect(result.fields.find(f => f.name === 'action')).toBeDefined()
    })

    it('accepts all eight valid capture types', async () => {
      const types = ['decision', 'idea', 'observation', 'task', 'win', 'blocker', 'question', 'reflection'] as const

      for (const captureType of types) {
        vi.clearAllMocks()
        service = new ClassificationService()
        mockCreate = await getMockCreate()

        mockCreate.mockResolvedValueOnce({
          choices: [{
            message: {
              content: JSON.stringify({
                template: captureType,
                confidence: 0.8,
                fields: [
                  { name: 'summary', value: 'Test summary' },
                  { name: 'topics', value: 'test' },
                ],
              }),
            },
          }],
        })

        const result = await service.classify(`Test transcript for ${captureType}`)
        expect(result.template).toBe(captureType)
      }
    })
  })

  describe('classify — fallback / degraded paths', () => {
    it('defaults to observation when LLM returns invalid JSON', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: 'not valid json at all',
          },
        }],
      })

      const result = await service.classify('Some voice memo text.')

      expect(result.template).toBe('observation')
      expect(result.confidence).toBe(0.5)
    })

    it('defaults to observation when template is not a valid capture type', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'invalid_type',
              confidence: 0.9,
              fields: [],
            }),
          },
        }],
      })

      const result = await service.classify('Test transcript.')

      expect(result.template).toBe('observation')
    })

    it('defaults confidence to 0.5 when missing from response', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'idea',
              fields: [
                { name: 'summary', value: 'test' },
                { name: 'topics', value: 'test' },
              ],
            }),
          },
        }],
      })

      const result = await service.classify('Test.')

      expect(result.confidence).toBe(0.5)
    })

    it('clamps confidence to [0, 1] range', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'observation',
              confidence: 1.5,
              fields: [],
            }),
          },
        }],
      })

      const result = await service.classify('Test transcript.')
      expect(result.confidence).toBeLessThanOrEqual(1)
      expect(result.confidence).toBeGreaterThanOrEqual(0)
    })

    it('uses default fields when fields is missing from response', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'observation',
              confidence: 0.7,
            }),
          },
        }],
      })

      const result = await service.classify('Some text here.')

      expect(result.fields).toHaveLength(2)
      expect(result.fields[0].name).toBe('summary')
      expect(result.fields[1].name).toBe('topics')
    })

    it('defaults to observation when message content is empty', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: '',
          },
        }],
      })

      const result = await service.classify('Test transcript.')

      expect(result.template).toBe('observation')
    })

    it('propagates errors thrown by OpenAI SDK', async () => {
      mockCreate.mockRejectedValueOnce(new Error('LiteLLM timeout'))

      await expect(service.classify('Test transcript.')).rejects.toThrow('LiteLLM timeout')
    })
  })

  describe('classify — request construction', () => {
    it('embeds transcript text in the prompt', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({
              template: 'reflection',
              confidence: 0.75,
              fields: [
                { name: 'summary', value: 'test' },
                { name: 'topics', value: 'test' },
              ],
            }),
          },
        }],
      })

      const transcript = 'Unique transcript content xyz-123'
      await service.classify(transcript)

      const [callArgs] = mockCreate.mock.calls
      const userMessage = callArgs[0].messages[0]
      expect(userMessage.content).toContain(transcript)
    })

    it('uses temperature 0.1 for deterministic classification', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({ template: 'idea', confidence: 0.8, fields: [] }),
          },
        }],
      })

      await service.classify('Test.')

      const [callArgs] = mockCreate.mock.calls
      expect(callArgs[0].temperature).toBe(0.1)
    })

    it('sends request to the fast LiteLLM model alias', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{
          message: {
            content: JSON.stringify({ template: 'idea', confidence: 0.8, fields: [] }),
          },
        }],
      })

      await service.classify('Test.')

      const [callArgs] = mockCreate.mock.calls
      expect(callArgs[0].model).toBe('fast')
    })
  })
})
