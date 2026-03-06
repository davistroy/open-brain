import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GovernanceEngine } from '../services/governance-engine.js'
import { AntiVaguenessGate } from '../services/anti-vagueness.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-test-1',
    session_type: 'governance',
    status: 'active',
    config: {
      max_turns: 20,
      turn_count: 2,
      focus_brain_views: [],
      last_activity_at: new Date().toISOString(),
      governance_state: {
        topics_covered: [],
        vagueness_skips: {},
        assessment_generated: false,
      },
      ...overrides,
    },
    context_capture_ids: [],
    summary: null,
    created_at: new Date(),
    updated_at: new Date(),
    completed_at: null,
  }
}

function makeTranscript(entries: Array<{ role: 'user' | 'assistant'; content: string }> = []) {
  return entries.map((e, i) => ({
    id: `msg-${i}`,
    session_id: 'session-test-1',
    role: e.role,
    content: e.content,
    metadata: null,
    created_at: new Date(),
  }))
}

function makeLlmGateway(response = 'Board response here.') {
  return {
    complete: vi.fn().mockResolvedValue(response),
    completeWithPromptTemplate: vi.fn().mockResolvedValue(response),
  } as any
}

function makeSearchService(results: unknown[] = []) {
  return {
    search: vi.fn().mockResolvedValue(results),
  } as any
}

function makeBetService(betOverrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn().mockResolvedValue({
      id: 'bet-auto-1',
      commitment: 'Test commitment',
      status: 'open',
      ...betOverrides,
    }),
  } as any
}

// ---------------------------------------------------------------------------
// AntiVaguenessGate — unit tests
// ---------------------------------------------------------------------------

describe('AntiVaguenessGate', () => {
  describe('heuristic fast-path (no LLM)', () => {
    it('flags obviously vague answers without LLM', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate('What are your top priorities?', 'working on it', 'priorities')

      expect(result.passes).toBe(false)
      expect(result.pushback_message).toBeDefined()
      expect(result.confidence).toBeGreaterThan(0.5)
    })

    it('flags short answers without specifics', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate('What decisions did you make?', 'busy', 'decisions')

      expect(result.passes).toBe(false)
    })

    it('passes answers with specific details (numbers, names)', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate(
        'What are your top priorities?',
        'Phase 13 governance implementation — specifically the GovernanceEngine class, targeting completion by Friday March 7.',
        'priorities',
      )

      expect(result.passes).toBe(true)
    })

    it('passes answers with dollar amounts', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate(
        'What decisions did you make?',
        'Decided to cap the QSR client project at $15K — any scope beyond that triggers a change order.',
        'decisions',
      )

      expect(result.passes).toBe(true)
    })

    it('flags "making progress" as vague', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate('What did you accomplish?', 'Making progress.', 'priorities')

      expect(result.passes).toBe(false)
    })

    it('returns topic-specific pushback message for priorities', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate('What is your top priority?', 'fine', 'priorities')

      expect(result.passes).toBe(false)
      expect(result.pushback_message).toContain('single top priority')
    })

    it('returns topic-specific pushback message for bets', async () => {
      const gate = new AntiVaguenessGate()

      const result = await gate.evaluate('Walk me through your active bets.', 'same as usual', 'bets')

      expect(result.passes).toBe(false)
      expect(result.pushback_message).toContain('active bet')
    })
  })

  describe('LLM evaluation path', () => {
    it('calls LLM for ambiguous answers and parses response', async () => {
      const mockGateway = {
        complete: vi.fn().mockResolvedValue(
          JSON.stringify({ passes: false, confidence: 0.85, reason: 'No specifics', pushback_question: 'What specific client?' }),
        ),
      } as any

      const gate = new AntiVaguenessGate(mockGateway)

      const result = await gate.evaluate(
        'Tell me about your priorities.',
        'I have been focused on consulting work and some technical projects.',
        'priorities',
        'test-session-1',
      )

      expect(mockGateway.complete).toHaveBeenCalled()
      expect(result.passes).toBe(false)
      expect(result.pushback_message).toBe('What specific client?')
    })

    it('fails open (passes) when LLM call throws', async () => {
      const mockGateway = {
        complete: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
      } as any

      const gate = new AntiVaguenessGate(mockGateway)

      // Use a long enough answer that passes the fast-path heuristic, so the LLM gets called
      const result = await gate.evaluate(
        'What are your bets?',
        'I have several ongoing bets related to various projects and client engagements across multiple domains.',
        'bets',
      )

      // Should fail open — don't block session due to LLM outage
      expect(result.passes).toBe(true)
    })

    it('fails open when LLM returns invalid JSON', async () => {
      const mockGateway = {
        complete: vi.fn().mockResolvedValue('Sorry, I cannot evaluate that.'),
      } as any

      const gate = new AntiVaguenessGate(mockGateway)

      const result = await gate.evaluate('Question?', 'Answer with some reasonable length here.', 'outlook')

      expect(result.passes).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// GovernanceEngine — unit tests
// ---------------------------------------------------------------------------

describe('GovernanceEngine', () => {
  const PROMPTS_DIR = 'C:/Users/Troy Davis/dev/personal/open-brain/config/prompts'

  // -------------------------------------------------------------------------
  // processResponse — basic flow
  // -------------------------------------------------------------------------
  describe('processResponse()', () => {
    it('calls LLM with governance alias and returns bot message', async () => {
      const llm = makeLlmGateway('Board message about priorities.')
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)

      const session = makeSession()
      const transcript = makeTranscript([
        { role: 'assistant', content: 'What are your top priorities?' },
      ])

      const result = await engine.processResponse(session, transcript, 'I am working on Phase 13 governance engine, targeting completion by Friday.')

      expect(llm.complete).toHaveBeenCalledWith(
        expect.any(String),
        'governance',
        expect.objectContaining({ temperature: 0.3, sessionId: 'session-test-1' }),
      )
      expect(result.bot_message).toBe('Board message about priorities.')
    })

    it('marks topic as covered after substantive answer', async () => {
      const llm = makeLlmGateway('Good. Now let\'s talk about decisions.')
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)

      const session = makeSession()
      const transcript = makeTranscript([
        { role: 'assistant', content: 'What is your top priority right now?' },
      ])

      const result = await engine.processResponse(
        session,
        transcript,
        'Top priority: completing Phase 13 governance engine for the open-brain project, due by March 7.',
      )

      expect(result.state_update?.topics_covered).toContain('priorities')
    })

    it('returns pushback when answer is vague (below max skips)', async () => {
      const llm = makeLlmGateway('Good. Now let\'s talk about decisions.')
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)

      // turn_count: 0 → Operator (turns 0-1)
      const session = makeSession({ turn_count: 0 })
      const transcript = makeTranscript([
        { role: 'assistant', content: 'What is your top priority right now?' },
      ])

      const result = await engine.processResponse(session, transcript, 'working on it')

      // LLM should NOT have been called — pushback is immediate
      expect(llm.complete).not.toHaveBeenCalled()
      expect(result.bot_message).toContain('[Operator]')
      expect(result.state_update?.vagueness_skips?.priorities).toBe(1)
    })

    it('advances topic after max vagueness skips reached', async () => {
      const llm = makeLlmGateway('Moving on. What decisions have you made this week?')
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)

      // Already has 2 skips for 'priorities' — next vague answer should advance
      const session = makeSession({
        governance_state: {
          topics_covered: [],
          vagueness_skips: { priorities: 2 },
          assessment_generated: false,
        },
      })
      const transcript = makeTranscript([
        { role: 'assistant', content: 'I asked twice. Let\'s move on.' },
      ])

      const result = await engine.processResponse(session, transcript, 'working on it')

      // LLM should have been called — max skips reached, advancing
      expect(llm.complete).toHaveBeenCalled()
      // priorities should be covered now
      expect(result.state_update?.topics_covered).toContain('priorities')
    })

    it('integrates search results as evidence when SearchService provided', async () => {
      const llm = makeLlmGateway('Based on your recent captures, I see...')
      const search = makeSearchService([
        {
          capture: {
            id: 'cap-1',
            content: 'Decided to scope QSR project to $15K fixed fee.',
            brain_view: 'work-internal',
            capture_type: 'decision',
            created_at: new Date(),
          },
          score: 0.85,
        },
      ])
      const engine = new GovernanceEngine(llm, PROMPTS_DIR, search)

      const session = makeSession()
      const transcript = makeTranscript([
        { role: 'assistant', content: 'Tell me about your priorities.' },
      ])

      const result = await engine.processResponse(
        session,
        transcript,
        'Focused on QSR client delivery and Phase 13 implementation.',
      )

      expect(search.search).toHaveBeenCalledWith(
        'Focused on QSR client delivery and Phase 13 implementation.',
        expect.objectContaining({ limit: 5 }),
      )
      expect(result.context_capture_ids).toContain('cap-1')
    })

    it('continues without search results when SearchService unavailable', async () => {
      const llm = makeLlmGateway('Understood. Next topic.')
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)  // No SearchService

      const session = makeSession()
      const transcript = makeTranscript([])

      const result = await engine.processResponse(
        session,
        transcript,
        'Working on client deliverables and Phase 13.',
      )

      expect(result.bot_message).toBe('Understood. Next topic.')
    })
  })

  // -------------------------------------------------------------------------
  // Assessment generation + bet creation
  // -------------------------------------------------------------------------
  describe('assessment generation', () => {
    const ASSESSMENT_JSON = JSON.stringify({
      assessment_type: 'board_quick_check',
      board_role: 'Integrator',
      areas_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
      key_findings: ['Phase 13 is on track', 'Energy is sustainable'],
      risks_identified: ['LiteLLM Jetson device thermal throttling'],
      honest_assessment: 'Execution is solid but the Jetson risk needs a mitigation plan before Phase 14.',
      prediction: {
        commitment: 'Phase 13 governance engine deployed to production by March 15, 2026',
        confidence: 0.8,
        resolution_date: '2026-03-15',
        criteria: 'governance-engine.ts passes all tests and is running in Docker on homeserver',
      },
    })

    it('parses assessment and creates bet when all topics covered', async () => {
      const llm = makeLlmGateway(ASSESSMENT_JSON)
      const betService = makeBetService()
      const engine = new GovernanceEngine(llm, PROMPTS_DIR, undefined, betService)

      // All 5 topics already covered
      const session = makeSession({
        governance_state: {
          topics_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
          vagueness_skips: {},
          assessment_generated: false,
        },
      })
      const transcript = makeTranscript([
        { role: 'assistant', content: 'Give me your 90-day outlook.' },
      ])

      const result = await engine.processResponse(
        session,
        transcript,
        'The trajectory is strong — all phases on track for Q1 completion.',
      )

      expect(betService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          commitment: 'Phase 13 governance engine deployed to production by March 15, 2026',
          criteria: 'governance-engine.ts passes all tests and is running in Docker on homeserver',
          confidence: 0.8,
          session_id: 'session-test-1',
        }),
      )
      expect(result.context_capture_ids).toContain('bet-auto-1')
      expect(result.state_update?.assessment_generated).toBe(true)
    })

    it('does not create duplicate bet when assessment_generated is already true', async () => {
      const llm = makeLlmGateway(ASSESSMENT_JSON)
      const betService = makeBetService()
      const engine = new GovernanceEngine(llm, PROMPTS_DIR, undefined, betService)

      // Already generated
      const session = makeSession({
        governance_state: {
          topics_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
          vagueness_skips: {},
          assessment_generated: true,  // Already done
        },
      })
      const transcript = makeTranscript([])

      await engine.processResponse(session, transcript, 'Any final thoughts?')

      // Bet creation should NOT be called again
      expect(betService.create).not.toHaveBeenCalled()
    })

    it('handles assessment with missing prediction fields gracefully', async () => {
      const incompleteAssessment = JSON.stringify({
        assessment_type: 'board_quick_check',
        board_role: 'Integrator',
        areas_covered: ['priorities'],
        key_findings: ['Something happened'],
        honest_assessment: 'Mixed results.',
        // prediction is missing
      })

      const llm = makeLlmGateway(incompleteAssessment)
      const betService = makeBetService()
      const engine = new GovernanceEngine(llm, PROMPTS_DIR, undefined, betService)

      const session = makeSession({
        governance_state: {
          topics_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
          vagueness_skips: {},
          assessment_generated: false,
        },
      })

      const result = await engine.processResponse(
        makeSession({
          governance_state: {
            topics_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
            vagueness_skips: {},
            assessment_generated: false,
          },
        }),
        [],
        'Final message.',
      )

      // Should NOT throw and bet should NOT be created
      expect(betService.create).not.toHaveBeenCalled()
      expect(result.bot_message).toBe(incompleteAssessment)
    })

    it('continues gracefully when BetService create throws', async () => {
      const llm = makeLlmGateway(ASSESSMENT_JSON)
      const betService = {
        create: vi.fn().mockRejectedValue(new Error('DB connection lost')),
      } as any
      const engine = new GovernanceEngine(llm, PROMPTS_DIR, undefined, betService)

      const session = makeSession({
        governance_state: {
          topics_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
          vagueness_skips: {},
          assessment_generated: false,
        },
      })

      // Should not throw even when bet creation fails
      const result = await engine.processResponse(session, [], 'Final message.')

      expect(result.bot_message).toBe(ASSESSMENT_JSON)
      // No bet capture ID in result since creation failed
    })
  })

  // -------------------------------------------------------------------------
  // Minimum coverage guardrail
  // -------------------------------------------------------------------------
  describe('coverage guardrails', () => {
    it('enforces all 5 topics must be covered for assessment', async () => {
      // Session with only 2 topics covered — not enough for assessment
      const assessmentJson = JSON.stringify({
        assessment_type: 'board_quick_check',
        board_role: 'Integrator',
        areas_covered: ['priorities', 'decisions'],
        key_findings: ['Early'],
        honest_assessment: 'Too early to assess.',
        prediction: {
          commitment: 'Something will happen',
          confidence: 0.5,
          resolution_date: '2026-06-01',
          criteria: 'Something happens',
        },
      })

      const llm = makeLlmGateway(assessmentJson)
      const betService = makeBetService()
      const engine = new GovernanceEngine(llm, PROMPTS_DIR, undefined, betService)

      const session = makeSession({
        governance_state: {
          topics_covered: ['priorities', 'decisions'],
          vagueness_skips: {},
          assessment_generated: false,
        },
      })

      await engine.processResponse(session, [], 'My 90-day outlook is strong.')

      // Bet should NOT be created — not all 5 topics covered
      expect(betService.create).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Board role rotation
  // -------------------------------------------------------------------------
  describe('board role attribution', () => {
    it('attributes pushback to correct board role by turn number', async () => {
      const llm = makeLlmGateway('Strategic question.')
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)

      // Turn 3 = Strategist
      const session = makeSession({ turn_count: 3 })
      const transcript = makeTranscript([
        { role: 'assistant', content: 'What decisions have you made?' },
      ])

      const result = await engine.processResponse(session, transcript, 'busy')

      // Pushback should come from Strategist (turn 3)
      expect(result.bot_message).toContain('[Strategist]')
    })

    it('uses Integrator role when all topics covered', async () => {
      const integrationResponse = 'Integrator synthesis here.'
      const llm = makeLlmGateway(integrationResponse)
      const engine = new GovernanceEngine(llm, PROMPTS_DIR)

      const session = makeSession({
        governance_state: {
          topics_covered: ['priorities', 'decisions', 'bets', 'energy', 'outlook'],
          vagueness_skips: {},
          assessment_generated: true,
        },
      })
      const transcript = makeTranscript([
        { role: 'assistant', content: 'Any final thoughts?' },
      ])

      // The rendered prompt should contain 'Integrator' for the board_role variable
      await engine.processResponse(session, transcript, 'Nothing further.')

      const callArgs = llm.complete.mock.calls[0]
      expect(callArgs[0]).toContain('Integrator')
    })
  })
})
