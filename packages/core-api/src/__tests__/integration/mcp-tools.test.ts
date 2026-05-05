/**
 * Integration tests — MCP Tool Handlers
 *
 * Tests the 8 core MCP tool handler functions against a real Postgres database.
 * Instead of exercising the Streamable HTTP transport layer (which adds SSE framing
 * complexity), we import the tool functions directly and pass real service instances
 * backed by the test database. This validates the actual SQL queries and data flow.
 *
 * Tools tested:
 *   search_brain     — semantic/FTS hybrid search (embedding stub returns zero vectors)
 *   list_captures    — list with filters and pagination
 *   brain_stats      — aggregate statistics response shape
 *   capture_thought  — create capture via MCP tool, verify it persists
 *   get_entity       — look up entity by name and ID
 *   list_entities    — browse entities with type filter and sort
 *   get_weekly_brief — retrieve from skills_log (may be empty)
 *   get_capture      — fetch full capture content + linked entities
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { ConfigService } from '@open-brain/shared'
import {
  initTestDatabase,
  teardownTestDatabase,
  getTestApp,
  getTestDb,
  getTestPool,
  type TestAppContext,
} from './setup.js'
import {
  cleanDatabase,
  createTestCapture,
  createTestEntity,
  linkEntityToCapture,
} from './helpers.js'

// MCP tool handlers — imported directly to test against real DB
import { searchBrainTool, type SearchBrainInput } from '../../mcp/tools/search-brain.js'
import { listCapturesTool, type ListCapturesInput } from '../../mcp/tools/list-captures.js'
import { brainStatsTool, type BrainStatsInput } from '../../mcp/tools/brain-stats.js'
import { captureThoughtTool, type CaptureThoughtInput } from '../../mcp/tools/capture-thought.js'
import { getEntityTool, type GetEntityInput } from '../../mcp/tools/get-entity.js'
import { listEntitiesTool, type ListEntitiesInput } from '../../mcp/tools/list-entities.js'
import { getWeeklyBriefTool, type GetWeeklyBriefInput } from '../../mcp/tools/get-weekly-brief.js'
import { getCaptureTool, type GetCaptureInput } from '../../mcp/tools/get-capture.js'

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

let ctx: TestAppContext
let configService: ConfigService

beforeAll(async () => {
  // Set MCP_BEARER_TOKEN so auth does not fail-closed in any incidental checks
  process.env.MCP_BEARER_TOKEN = 'test-token'

  await initTestDatabase()
  ctx = getTestApp()

  // Create a ConfigService from the real config/ directory — same as setup.ts
  const configDir = join(__dirname, '..', '..', '..', '..', '..', 'config')
  configService = new ConfigService(configDir)
  configService.load()
})

afterAll(async () => {
  await teardownTestDatabase()
  delete process.env.MCP_BEARER_TOKEN
})

beforeEach(async () => {
  await cleanDatabase()
})

// ---------------------------------------------------------------------------
// search_brain
// ---------------------------------------------------------------------------

describe('MCP tool: search_brain', () => {
  it('returns "no captures found" when database is empty', async () => {
    const input: SearchBrainInput = {
      query: 'nonexistent topic',
      limit: 10,
      threshold: 0.0,
      include_related: false,
    }

    const result = await searchBrainTool(input, ctx.searchService)
    expect(result).toContain('No captures found')
  })

  it('returns results when captures exist (FTS match)', async () => {
    await createTestCapture({
      content: 'PostgreSQL migration strategy for the new cloud architecture',
      capture_type: 'decision',
      brain_view: 'technical',
      source: 'api',
    })
    await createTestCapture({
      content: 'Weekly team standup notes about project velocity',
      capture_type: 'observation',
      brain_view: 'career',
      source: 'slack',
    })

    const input: SearchBrainInput = {
      query: 'PostgreSQL migration',
      limit: 10,
      threshold: 0.0,
      include_related: false,
    }

    const result = await searchBrainTool(input, ctx.searchService)
    // FTS should find the PostgreSQL capture; result is formatted text
    expect(result).toContain('Search results for')
    expect(result).toContain('PostgreSQL')
  })

  it('respects source_filter parameter', async () => {
    await createTestCapture({
      content: 'Voice memo about quarterly planning session',
      source: 'voice',
    })
    await createTestCapture({
      content: 'API capture about quarterly budget review',
      source: 'api',
    })

    const input: SearchBrainInput = {
      query: 'quarterly',
      limit: 10,
      threshold: 0.0,
      source_filter: 'voice',
      include_related: false,
    }

    const result = await searchBrainTool(input, ctx.searchService)
    // If FTS finds both, the source_filter should narrow to voice only
    if (!result.includes('No captures found')) {
      expect(result).toContain('voice')
      expect(result).not.toContain('(api)')
    }
  })
})

// ---------------------------------------------------------------------------
// list_captures
// ---------------------------------------------------------------------------

describe('MCP tool: list_captures', () => {
  it('returns "no captures found" message when empty', async () => {
    const input: ListCapturesInput = { limit: 20 }

    const result = await listCapturesTool(input, ctx.captureService)
    expect(result).toContain('No captures found')
  })

  it('lists captures with correct count', async () => {
    await createTestCapture({ content: 'Capture one' })
    await createTestCapture({ content: 'Capture two' })
    await createTestCapture({ content: 'Capture three' })

    const input: ListCapturesInput = { limit: 20 }

    const result = await listCapturesTool(input, ctx.captureService)
    expect(result).toContain('Captures (showing 3 of 3 total)')
    expect(result).toContain('Capture one')
    expect(result).toContain('Capture two')
    expect(result).toContain('Capture three')
  })

  it('filters by type', async () => {
    await createTestCapture({ content: 'Decision about tech stack', capture_type: 'decision' })
    await createTestCapture({ content: 'Idea for automation', capture_type: 'idea' })

    const input: ListCapturesInput = { limit: 20, type: 'decision' }

    const result = await listCapturesTool(input, ctx.captureService)
    expect(result).toContain('DECISION')
    expect(result).toContain('Decision about tech stack')
    expect(result).not.toContain('Idea for automation')
  })

  it('filters by source', async () => {
    await createTestCapture({ content: 'Slack message', source: 'slack' })
    await createTestCapture({ content: 'Voice memo', source: 'voice' })

    const input: ListCapturesInput = { limit: 20, source: 'slack' }

    const result = await listCapturesTool(input, ctx.captureService)
    expect(result).toContain('Slack message')
    expect(result).not.toContain('Voice memo')
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await createTestCapture({ content: `Batch capture ${i}` })
    }

    const input: ListCapturesInput = { limit: 3 }

    const result = await listCapturesTool(input, ctx.captureService)
    expect(result).toContain('showing 3 of 10 total')
  })
})

// ---------------------------------------------------------------------------
// brain_stats
// ---------------------------------------------------------------------------

describe('MCP tool: brain_stats', () => {
  it('returns zero counts when database is empty', async () => {
    const input: BrainStatsInput = { period: 'all' }

    const result = await brainStatsTool(input, ctx.captureService)
    expect(result).toContain('Brain Statistics')
    expect(result).toContain('Total captures: 0')
    expect(result).toContain('Pipeline health')
  })

  it('reflects accurate counts after inserting captures', async () => {
    await createTestCapture({ capture_type: 'idea', brain_view: 'technical', source: 'api' })
    await createTestCapture({ capture_type: 'idea', brain_view: 'technical', source: 'api' })
    await createTestCapture({ capture_type: 'decision', brain_view: 'career', source: 'slack' })
    await createTestCapture({ capture_type: 'task', brain_view: 'personal', source: 'voice' })

    const input: BrainStatsInput = { period: 'all' }

    const result = await brainStatsTool(input, ctx.captureService)
    expect(result).toContain('Total captures: 4')
    expect(result).toContain('api: 2')
    expect(result).toContain('slack: 1')
    expect(result).toContain('voice: 1')
    expect(result).toContain('idea: 2')
    expect(result).toContain('decision: 1')
    expect(result).toContain('task: 1')
  })

  it('includes entity count when entities exist', async () => {
    await createTestEntity({ name: 'TestEntity', entity_type: 'concept' })
    await createTestEntity({ name: 'AnotherEntity', entity_type: 'person' })

    const input: BrainStatsInput = { period: 'all' }

    const result = await brainStatsTool(input, ctx.captureService)
    expect(result).toContain('Total entities: 2')
  })
})

// ---------------------------------------------------------------------------
// capture_thought
// ---------------------------------------------------------------------------

describe('MCP tool: capture_thought', () => {
  it('creates a capture and returns confirmation with ID', async () => {
    const input: CaptureThoughtInput = {
      content: 'MCP integration test thought capture',
      brain_view: 'technical',
      capture_type: 'idea',
      tags: ['mcp-test', 'integration'],
    }

    const result = await captureThoughtTool(input, ctx.captureService, configService)
    expect(result).toContain('Captured successfully')
    expect(result).toContain('ID:')
    expect(result).toContain('Type:   idea')
    expect(result).toContain('View:   technical')
    expect(result).toContain('Status: pending')
    expect(result).toContain('Tags:   mcp-test, integration')
  })

  it('persists the capture in the database', async () => {
    const input: CaptureThoughtInput = {
      content: 'Persisted MCP capture test',
      capture_type: 'decision',
    }

    const result = await captureThoughtTool(input, ctx.captureService, configService)

    // Extract the ID from the result text
    const idMatch = result.match(/ID:\s+([0-9a-f-]+)/)
    expect(idMatch).not.toBeNull()
    const captureId = idMatch![1]

    // Verify it exists in the database via captureService
    const capture = await ctx.captureService.getById(captureId)
    expect(capture.content).toBe('Persisted MCP capture test')
    expect(capture.source).toBe('mcp')
    expect(capture.capture_type).toBe('decision')
  })

  it('defaults to observation type when capture_type is omitted', async () => {
    const input: CaptureThoughtInput = {
      content: 'Default type test via MCP',
    }

    const result = await captureThoughtTool(input, ctx.captureService, configService)
    expect(result).toContain('Type:   observation')
  })
})

// ---------------------------------------------------------------------------
// get_entity
// ---------------------------------------------------------------------------

describe('MCP tool: get_entity', () => {
  it('returns entity details by name', async () => {
    await createTestEntity({
      name: 'PostgreSQL',
      entity_type: 'tool',
    })

    const input: GetEntityInput = { name: 'PostgreSQL' }

    const result = await getEntityTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('Entity: PostgreSQL')
    expect(result).toContain('Type:   tool')
    expect(result).toContain('ID:')
  })

  it('returns entity details by ID', async () => {
    const entity = await createTestEntity({
      name: 'LLM',
      entity_type: 'concept',
    })

    const input: GetEntityInput = { id: entity.id as string }

    const result = await getEntityTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('Entity: LLM')
    expect(result).toContain('Type:   concept')
  })

  it('returns "not found" for nonexistent entity name', async () => {
    const input: GetEntityInput = { name: 'NonexistentEntity' }

    const result = await getEntityTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('No entity found')
  })

  it('returns "not found" for nonexistent entity ID', async () => {
    const input: GetEntityInput = { id: '00000000-0000-0000-0000-000000000000' }

    const result = await getEntityTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('No entity found')
  })

  it('includes linked captures in response', async () => {
    const entity = await createTestEntity({
      name: 'BullMQ',
      entity_type: 'tool',
    })
    const capture = await createTestCapture({
      content: 'BullMQ queue processing improvements',
      capture_type: 'idea',
    })

    await linkEntityToCapture(entity.id as string, capture.id as string, 'mentioned', 0.95)

    const input: GetEntityInput = { name: 'BullMQ' }

    const result = await getEntityTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('Entity: BullMQ')
    expect(result).toContain('Recent captures')
    expect(result).toContain('BullMQ queue processing')
  })
})

// ---------------------------------------------------------------------------
// list_entities
// ---------------------------------------------------------------------------

describe('MCP tool: list_entities', () => {
  it('returns "no entities found" when empty', async () => {
    const input: ListEntitiesInput = { sort_by: 'mention_count', limit: 20 }

    const result = await listEntitiesTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('No entities found')
  })

  it('lists entities with correct count', async () => {
    await createTestEntity({ name: 'Entity Alpha', entity_type: 'person' })
    await createTestEntity({ name: 'Entity Beta', entity_type: 'tool' })
    await createTestEntity({ name: 'Entity Gamma', entity_type: 'concept' })

    const input: ListEntitiesInput = { sort_by: 'name', limit: 20 }

    const result = await listEntitiesTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('Entities')
    expect(result).toContain('Entity Alpha')
    expect(result).toContain('Entity Beta')
    expect(result).toContain('Entity Gamma')
  })

  it('filters by entity type', async () => {
    await createTestEntity({ name: 'PersonEntity', entity_type: 'person' })
    await createTestEntity({ name: 'ToolEntity', entity_type: 'tool' })

    const input: ListEntitiesInput = { sort_by: 'name', limit: 20, type_filter: 'person' }

    const result = await listEntitiesTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('PersonEntity')
    expect(result).not.toContain('ToolEntity')
  })

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await createTestEntity({ name: `Entity-${i.toString().padStart(2, '0')}`, entity_type: 'concept' })
    }

    const input: ListEntitiesInput = { sort_by: 'name', limit: 3 }

    const result = await listEntitiesTool(input, getTestDb(), ctx.entityService)
    expect(result).toContain('Entities')
    // Should show 3 of 10
    expect(result).toContain('3 shown')
  })
})

// ---------------------------------------------------------------------------
// get_weekly_brief
// ---------------------------------------------------------------------------

describe('MCP tool: get_weekly_brief', () => {
  it('returns "no weekly briefs" when skills_log is empty', async () => {
    const input: GetWeeklyBriefInput = { weeks_ago: 0 }

    const result = await getWeeklyBriefTool(input, getTestDb())
    expect(result).toContain('No weekly briefs generated yet')
  })

  it('returns brief content when a skills_log entry exists', async () => {
    // Insert a weekly-brief entry directly into skills_log
    const pool = getTestPool()
    await pool.query(`
      INSERT INTO skills_log (skill_name, output_summary, result, created_at)
      VALUES ('weekly-brief', 'Test brief summary', '{"content": "Full weekly brief content for integration test"}', NOW())
    `)

    const input: GetWeeklyBriefInput = { weeks_ago: 0 }

    const result = await getWeeklyBriefTool(input, getTestDb())
    expect(result).toContain('Weekly Brief')
    expect(result).toContain('Full weekly brief content for integration test')
  })

  it('returns "not found" for weeks_ago beyond available briefs', async () => {
    const input: GetWeeklyBriefInput = { weeks_ago: 52 }

    const result = await getWeeklyBriefTool(input, getTestDb())
    expect(result).toContain('No weekly brief found from 52 weeks ago')
  })
})

// ---------------------------------------------------------------------------
// get_capture
// ---------------------------------------------------------------------------

describe('MCP tool: get_capture', () => {
  it('returns full capture content by ID', async () => {
    const capture = await createTestCapture({
      content: 'Full content for MCP get_capture integration test with detailed notes',
      capture_type: 'decision',
      brain_view: 'technical',
      source: 'api',
      tags: ['mcp-test'],
    })

    const input: GetCaptureInput = { id: capture.id as string }

    const result = await getCaptureTool(input, ctx.captureService, getTestDb())
    expect(result).toContain('Capture — DECISION')
    expect(result).toContain(`ID: ${capture.id}`)
    expect(result).toContain('Source: api')
    expect(result).toContain('View: technical')
    expect(result).toContain('Tags: mcp-test')
    expect(result).toContain('--- Content ---')
    expect(result).toContain('Full content for MCP get_capture integration test')
  })

  it('includes linked entities in response', async () => {
    const capture = await createTestCapture({
      content: 'Capture with linked entity for get_capture test',
      capture_type: 'observation',
    })
    const entity = await createTestEntity({
      name: 'Drizzle ORM',
      entity_type: 'tool',
    })

    await linkEntityToCapture(entity.id as string, capture.id as string, 'mentioned', 0.9)

    const input: GetCaptureInput = { id: capture.id as string }

    const result = await getCaptureTool(input, ctx.captureService, getTestDb())
    expect(result).toContain('--- Linked Entities ---')
    expect(result).toContain('Drizzle ORM')
  })

  it('throws for nonexistent capture ID', async () => {
    const input: GetCaptureInput = { id: '00000000-0000-0000-0000-000000000000' }

    // CaptureService.getById throws when capture is not found
    await expect(
      getCaptureTool(input, ctx.captureService, getTestDb()),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// MCP /mcp endpoint auth (sanity check via Hono app)
// ---------------------------------------------------------------------------

describe('MCP /mcp endpoint auth', () => {
  it('rejects requests without Authorization header', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('Unauthorized')
  })

  it('rejects requests with invalid bearer token', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer wrong-token',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 1,
      }),
    })

    const res = await ctx.app.fetch(req)
    expect(res.status).toBe(401)
  })

  it('accepts requests with valid bearer token', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-token',
        'Accept': 'application/json, text/event-stream',
        'X-Open-Brain-Caller': 'integration-test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1.0.0' },
        },
      }),
    })

    const res = await ctx.app.fetch(req)
    // Streamable HTTP returns 200 with SSE or JSON
    expect([200, 202]).toContain(res.status)
  })
})
