import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EmailClassifier } from '../email-classifier.js'
import type { ClassificationResult } from '../email-classifier.js'
import type { EmailRules } from '../config-loader.js'
import { loadEmailRules } from '../config-loader.js'
import type { EmailMessage } from '../types.js'
import type { LLMGatewayService } from '../../llm-gateway.js'
import path from 'node:path'

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    messageId: 'test-msg-1',
    provider: 'hotmail',
    sender: 'someone@example.com',
    subject: 'Hello world',
    receivedAt: new Date().toISOString(),
    bodyPreview: 'This is a test email body preview',
    ...overrides,
  }
}

function makeRules(overrides: Partial<EmailRules> = {}): EmailRules {
  return {
    groups: {
      People: ['Jamie', 'Ashley'],
      Finance: ['Financial & Banking'],
      Technology: ['DevOps'],
      Shopping: ['Shopping & E-commerce'],
      Essentials: ['Account & Security', 'Newsletters & Marketing'],
      Lifestyle: ['Travel & Transportation'],
    },
    senderRules: new Map([
      ['ash.davis@hotmail.com', 'Ashley'],
      ['github.com', 'DevOps'],
      ['paypal.com', 'Financial & Banking'],
      ['chase.com', 'Financial & Banking'],
      ['ss.email.nextdoor.com', 'Community & Neighborhood'],
    ]),
    keywordRules: new Map([
      ['Account & Security', ['password', 'security', 'verify', 'authentication', 'reset', '2fa']],
      ['Financial & Banking', ['invoice', 'payment', 'bank', 'statement']],
      ['Travel & Transportation', ['flight', 'booking', 'reservation', 'hotel', 'itinerary']],
      ['Shopping & E-commerce', ['order', 'shipped', 'delivery', 'purchase', 'receipt']],
    ]),
    categories: new Set([
      'Jamie', 'Ashley', 'Financial & Banking', 'DevOps',
      'Shopping & E-commerce', 'Account & Security',
      'Newsletters & Marketing', 'Travel & Transportation',
      'Community & Neighborhood', 'Needs Review',
    ]),
    autoMoveThreshold: 0.85,
    jetson: {
      baseUrl: 'http://192.168.10.58:8080/v1',
      model: 'qwen3.5-4b',
      maxTokens: 256,
      temperature: 0.1,
    },
    protectedFolders: ['LICW', 'Receipts'],
    spamMaxAgeDays: 30,
    ...overrides,
  }
}

function makeMockLLMGateway(response?: string): LLMGatewayService {
  return {
    completeByTask: vi.fn().mockResolvedValue(response ?? '{"category": "Financial & Banking", "confidence": 0.92}'),
  } as unknown as LLMGatewayService
}

// ── Sender classification tests ──────────────────────────────────────────────

describe('EmailClassifier', () => {
  describe('classifyBySender', () => {
    it('matches exact email address (case-insensitive)', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'Ash.Davis@Hotmail.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toEqual({ category: 'Ashley', confidence: 1.0, tier: 'sender' })
    })

    it('matches exact email address (already lowercase)', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'ash.davis@hotmail.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toEqual({ category: 'Ashley', confidence: 1.0, tier: 'sender' })
    })

    it('matches domain suffix rule (exact domain)', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'noreply@github.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toEqual({ category: 'DevOps', confidence: 1.0, tier: 'sender' })
    })

    it('matches domain suffix rule (subdomain)', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'alerts@notifications.paypal.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toEqual({ category: 'Financial & Banking', confidence: 1.0, tier: 'sender' })
    })

    it('matches multi-level subdomain rule', () => {
      const classifier = new EmailClassifier(makeRules())
      // ss.email.nextdoor.com is itself a domain rule
      const email = makeEmail({ sender: 'noreply@ss.email.nextdoor.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toEqual({ category: 'Community & Neighborhood', confidence: 1.0, tier: 'sender' })
    })

    it('returns null for unknown sender', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'someone@unknown-domain.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toBeNull()
    })

    it('returns null for sender without @ sign', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'invalid-email-address' })

      const result = classifier.classifyBySender(email)

      expect(result).toBeNull()
    })

    it('does not match partial domain names', () => {
      const classifier = new EmailClassifier(makeRules())
      // "fakegithub.com" should NOT match the "github.com" rule
      const email = makeEmail({ sender: 'noreply@fakegithub.com' })

      const result = classifier.classifyBySender(email)

      expect(result).toBeNull()
    })
  })

  // ── Keyword classification tests ───────────────────────────────────────────

  describe('classifyByKeyword', () => {
    it('matches a single keyword', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ subject: 'Your password has been changed' })

      const result = classifier.classifyByKeyword(email)

      expect(result).not.toBeNull()
      expect(result!.category).toBe('Account & Security')
      expect(result!.tier).toBe('keyword')
      // 1 hit: 0.5 + 0.15 * 1 = 0.65
      expect(result!.confidence).toBeCloseTo(0.65, 5)
    })

    it('matches multiple keywords and increases confidence', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ subject: 'Reset your password and verify security' })

      const result = classifier.classifyByKeyword(email)

      expect(result).not.toBeNull()
      expect(result!.category).toBe('Account & Security')
      // 3 hits (reset, password, security): 0.5 + 0.15 * 3 = 0.95 -> capped at 0.9
      expect(result!.confidence).toBeCloseTo(0.9, 5)
    })

    it('caps confidence at 0.9', () => {
      const classifier = new EmailClassifier(makeRules())
      // 4+ hits should still cap at 0.9
      const email = makeEmail({ subject: 'verify password reset security authentication 2fa' })

      const result = classifier.classifyByKeyword(email)

      expect(result).not.toBeNull()
      expect(result!.confidence).toBe(0.9)
    })

    it('picks the category with the most keyword hits', () => {
      const classifier = new EmailClassifier(makeRules())
      // "order" matches Shopping (1 hit), "payment" matches Financial (1 hit),
      // "shipped delivery" adds 2 more to Shopping (3 total)
      const email = makeEmail({ subject: 'Your order has shipped for delivery payment' })

      const result = classifier.classifyByKeyword(email)

      expect(result).not.toBeNull()
      expect(result!.category).toBe('Shopping & E-commerce')
    })

    it('is case-insensitive', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ subject: 'YOUR FLIGHT Booking Confirmation' })

      const result = classifier.classifyByKeyword(email)

      expect(result).not.toBeNull()
      expect(result!.category).toBe('Travel & Transportation')
    })

    it('returns null for no keyword matches', () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ subject: 'Hello friend how are you' })

      const result = classifier.classifyByKeyword(email)

      expect(result).toBeNull()
    })
  })

  // ── LLM classification tests ──────────────────────────────────────────────

  describe('classifyByLLM', () => {
    it('parses clean JSON response', async () => {
      const mockGateway = makeMockLLMGateway('{"category": "Financial & Banking", "confidence": 0.92}')
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail({ sender: 'unknown@random.com', subject: 'Wire transfer notification' })

      const result = await classifier.classifyByLLM(email)

      expect(result).toEqual({ category: 'Financial & Banking', confidence: 0.92, tier: 'jetson' })
      expect(mockGateway.completeByTask).toHaveBeenCalledWith(
        expect.stringContaining('Classify this email'),
        'email_classification',
        { temperature: 0.1, maxTokens: 256 },
      )
    })

    it('strips markdown code blocks', async () => {
      const response = '```json\n{"category": "DevOps", "confidence": 0.88}\n```'
      const mockGateway = makeMockLLMGateway(response)
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toEqual({ category: 'DevOps', confidence: 0.88, tier: 'jetson' })
    })

    it('strips <think> tags from reasoning models', async () => {
      const response = '<think>The email is about financial matters because it mentions a bank statement.</think>\n{"category": "Financial & Banking", "confidence": 0.95}'
      const mockGateway = makeMockLLMGateway(response)
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toEqual({ category: 'Financial & Banking', confidence: 0.95, tier: 'jetson' })
    })

    it('handles combined <think> tags and markdown code blocks', async () => {
      const response = '<think>This is a DevOps notification from GitHub.</think>\n```json\n{"category": "DevOps", "confidence": 0.90}\n```'
      const mockGateway = makeMockLLMGateway(response)
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toEqual({ category: 'DevOps', confidence: 0.90, tier: 'jetson' })
    })

    it('defaults confidence to 0.85 when not provided', async () => {
      const response = '{"category": "Ashley"}'
      const mockGateway = makeMockLLMGateway(response)
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toEqual({ category: 'Ashley', confidence: 0.85, tier: 'jetson' })
    })

    it('returns null for unknown category', async () => {
      const response = '{"category": "Nonexistent Category", "confidence": 0.90}'
      const mockGateway = makeMockLLMGateway(response)
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toBeNull()
    })

    it('returns null when LLM gateway is not available', async () => {
      const classifier = new EmailClassifier(makeRules(), null)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toBeNull()
    })

    it('returns null on LLM error', async () => {
      const mockGateway = {
        completeByTask: vi.fn().mockRejectedValue(new Error('Connection refused')),
      } as unknown as LLMGatewayService
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toBeNull()
    })

    it('returns null on invalid JSON response', async () => {
      const mockGateway = makeMockLLMGateway('This is not valid JSON at all')
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toBeNull()
    })

    it('returns null when category field is empty', async () => {
      const mockGateway = makeMockLLMGateway('{"category": "", "confidence": 0.5}')
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail()

      const result = await classifier.classifyByLLM(email)

      expect(result).toBeNull()
    })

    it('truncates body preview to 500 chars in prompt', async () => {
      const longBody = 'A'.repeat(1000)
      const mockGateway = makeMockLLMGateway('{"category": "Ashley", "confidence": 0.85}')
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail({ bodyPreview: longBody })

      await classifier.classifyByLLM(email)

      const callArgs = (mockGateway.completeByTask as ReturnType<typeof vi.fn>).mock.calls[0]
      const prompt = callArgs[0] as string
      // Body preview in prompt should be truncated
      expect(prompt).toContain('A'.repeat(500))
      expect(prompt).not.toContain('A'.repeat(501))
    })
  })

  // ── Tiered fallback tests ─────────────────────────────────────────────────

  describe('classify (tiered dispatch)', () => {
    it('returns sender match without checking keyword or LLM', async () => {
      const mockGateway = makeMockLLMGateway()
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail({ sender: 'noreply@github.com', subject: 'Your invoice payment' })

      const result = await classifier.classify(email)

      expect(result.category).toBe('DevOps')
      expect(result.tier).toBe('sender')
      expect(result.confidence).toBe(1.0)
      // LLM should NOT have been called
      expect(mockGateway.completeByTask).not.toHaveBeenCalled()
    })

    it('falls through to keyword when sender does not match', async () => {
      const mockGateway = makeMockLLMGateway()
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail({ sender: 'unknown@random.com', subject: 'Your flight booking confirmation' })

      const result = await classifier.classify(email)

      expect(result.category).toBe('Travel & Transportation')
      expect(result.tier).toBe('keyword')
      // LLM should NOT have been called
      expect(mockGateway.completeByTask).not.toHaveBeenCalled()
    })

    it('falls through to LLM when sender and keyword do not match', async () => {
      const mockGateway = makeMockLLMGateway('{"category": "Jamie", "confidence": 0.88}')
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail({ sender: 'unknown@random.com', subject: 'Something unrelated' })

      const result = await classifier.classify(email)

      expect(result.category).toBe('Jamie')
      expect(result.tier).toBe('jetson')
      expect(result.confidence).toBe(0.88)
      expect(mockGateway.completeByTask).toHaveBeenCalledTimes(1)
    })

    it('returns "Needs Review" when all tiers fail', async () => {
      const mockGateway = {
        completeByTask: vi.fn().mockRejectedValue(new Error('LLM down')),
      } as unknown as LLMGatewayService
      const classifier = new EmailClassifier(makeRules(), mockGateway)
      const email = makeEmail({ sender: 'unknown@random.com', subject: 'Something unrelated' })

      const result = await classifier.classify(email)

      expect(result.category).toBe('Needs Review')
      expect(result.tier).toBe('manual')
      expect(result.confidence).toBe(0.0)
    })

    it('returns "Needs Review" when no LLM gateway and no rules match', async () => {
      const classifier = new EmailClassifier(makeRules())
      const email = makeEmail({ sender: 'unknown@random.com', subject: 'Something unrelated' })

      const result = await classifier.classify(email)

      expect(result.category).toBe('Needs Review')
      expect(result.tier).toBe('manual')
      expect(result.confidence).toBe(0.0)
    })
  })

  // ── Config loader tests ───────────────────────────────────────────────────

  describe('loadEmailRules', () => {
    it('loads email-categories.yaml correctly', () => {
      const configPath = path.resolve(__dirname, '../../../../../../config/email-categories.yaml')
      const rules = loadEmailRules(configPath)

      // Verify groups loaded
      expect(Object.keys(rules.groups).length).toBeGreaterThan(5)
      expect(rules.groups['People']).toContain('Jamie')
      expect(rules.groups['People']).toContain('Ashley')

      // Verify categories built from groups
      expect(rules.categories.has('Jamie')).toBe(true)
      expect(rules.categories.has('Ashley')).toBe(true)
      expect(rules.categories.has('DevOps')).toBe(true)
      expect(rules.categories.has('Financial & Banking')).toBe(true)
      expect(rules.categories.size).toBeGreaterThan(20)

      // Verify sender rules normalized to lowercase
      expect(rules.senderRules.has('ash.davis@hotmail.com')).toBe(true)
      expect(rules.senderRules.get('ash.davis@hotmail.com')).toBe('Ashley')
      expect(rules.senderRules.has('github.com')).toBe(true)
      expect(rules.senderRules.get('github.com')).toBe('DevOps')

      // Verify keyword rules loaded and lowercased
      expect(rules.keywordRules.has('Account & Security')).toBe(true)
      const securityKeywords = rules.keywordRules.get('Account & Security')!
      expect(securityKeywords).toContain('password')
      expect(securityKeywords).toContain('security')
      expect(securityKeywords).toContain('2fa')

      // Verify thresholds
      expect(rules.autoMoveThreshold).toBe(0.85)

      // Verify jetson config
      expect(rules.jetson.model).toBe('qwen3.5-4b')
      expect(rules.jetson.temperature).toBe(0.1)

      // Verify protected folders
      expect(rules.protectedFolders).toContain('LICW')
      expect(rules.protectedFolders).toContain('Receipts')

      // Verify spam config
      expect(rules.spamMaxAgeDays).toBe(30)
    })

    it('throws on missing config file', () => {
      expect(() => loadEmailRules('/nonexistent/path.yaml')).toThrow()
    })
  })
})
