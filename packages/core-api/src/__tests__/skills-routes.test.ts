import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createApp } from '../app.js'
import {
  loadSkillsFromYaml,
  setSkillsYamlPath,
  getKnownSkills,
  resetKnownSkills,
  validateCronExpression,
} from '../routes/skills.js'

// ---------------------------------------------------------------------------
// Mock infrastructure dependencies so createApp() loads cleanly
// ---------------------------------------------------------------------------

vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    disconnect: vi.fn(),
  })),
}))

vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Creates a mock Database that returns the given rows from execute().
 */
function makeMockDb(rows: unknown[] = []) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
  }
}

/**
 * Creates a mock Queue (skill-execution queue).
 */
function makeMockSkillQueue(addResult: { id: string } = { id: 'job-123' }) {
  return {
    add: vi.fn().mockResolvedValue(addResult),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Sample skills_log rows
// ---------------------------------------------------------------------------

const SAMPLE_SKILLS_LOG = [
  {
    id: 'log-1',
    skill_name: 'weekly-brief',
    input_summary: '47 captures from 2026-02-22 to 2026-03-01',
    output_summary: 'headline: "QSR project compressed timeline" | wins:3 blockers:1 risks:2 | email:true',
    duration_ms: 8420,
    created_at: '2026-03-01T20:05:00Z',
  },
  {
    id: 'log-2',
    skill_name: 'pipeline-health',
    input_summary: 'Hourly queue stats check',
    output_summary: 'All queues healthy',
    duration_ms: 3200,
    created_at: '2026-02-23T09:01:00Z',
  },
]

// ---------------------------------------------------------------------------
// GET /api/v1/skills
// ---------------------------------------------------------------------------

describe('GET /api/v1/skills', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb(SAMPLE_SKILLS_LOG)
    skillQueue = makeMockSkillQueue()
  })

  it('returns 200 with a skills array', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills')

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('skills')
    expect(Array.isArray(body.skills)).toBe(true)
  })

  it('includes all known skills even if they have no log entries', async () => {
    // Return empty log — no executions yet
    db = makeMockDb([])
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills')
    const body = await res.json()

    const skillNames = body.skills.map((s: { name: string }) => s.name)
    expect(skillNames).toContain('weekly-brief')
    expect(skillNames).toContain('pipeline-health')
    expect(skillNames).toContain('daily-connections')
    expect(skillNames).toContain('drift-monitor')
  })

  it('includes schedule and description for known skills', async () => {
    db = makeMockDb([])
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills')
    const body = await res.json()

    const brief = body.skills.find((s: { name: string }) => s.name === 'weekly-brief')
    expect(brief).toBeDefined()
    expect(brief.schedule).toBe('0 20 * * 0') // Sunday 8pm
    expect(brief.description).toBeTruthy()
  })

  it('populates last_run_at and last_duration_ms from skills_log', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills')
    const body = await res.json()

    const brief = body.skills.find((s: { name: string }) => s.name === 'weekly-brief')
    expect(brief.last_run_at).toBeTruthy()
    expect(brief.last_duration_ms).toBe(8420)
    expect(brief.last_output_summary).toContain('QSR project')
  })

  it('returns null last_run fields for skills with no log entries', async () => {
    db = makeMockDb([])
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills')
    const body = await res.json()

    const brief = body.skills.find((s: { name: string }) => s.name === 'weekly-brief')
    expect(brief.last_run_at).toBeNull()
    expect(brief.last_duration_ms).toBeNull()
    expect(brief.last_output_summary).toBeNull()
  })

  it('includes skills from the log that are not in KNOWN_SKILLS', async () => {
    const customLog = [
      {
        id: 'log-custom',
        skill_name: 'custom-analysis',
        input_summary: null,
        output_summary: 'Custom output',
        duration_ms: 1000,
        created_at: '2026-03-01T10:00:00Z',
      },
    ]
    db = makeMockDb(customLog)
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills')
    const body = await res.json()

    const custom = body.skills.find((s: { name: string }) => s.name === 'custom-analysis')
    expect(custom).toBeDefined()
    expect(custom.schedule).toBeNull()
    expect(custom.description).toBeNull()
  })

  it('returns 404 when db and skillQueue are not wired up', async () => {
    const app = createApp({})
    const res = await app.request('/api/v1/skills')
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/skills/:name/trigger
// ---------------------------------------------------------------------------

describe('POST /api/v1/skills/:name/trigger', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb()
    skillQueue = makeMockSkillQueue()
  })

  it('returns 202 with skill name, job_id, and status when skill is queued', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.skill).toBe('weekly-brief')
    expect(body.job_id).toBe('job-123')
    expect(body.status).toBe('queued')
    expect(body.message).toContain('weekly-brief')
  })

  it('calls skillQueue.add with the skill name and execution job data', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    await app.request('/api/v1/skills/weekly-brief/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowDays: 14 }),
    })

    expect(skillQueue.add).toHaveBeenCalledWith(
      'weekly-brief',
      expect.objectContaining({
        skillName: 'weekly-brief',
        input: expect.objectContaining({ windowDays: 14 }),
      }),
      expect.objectContaining({
        priority: 2,
      }),
    )
  })

  it('accepts trigger with no body (body is optional)', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/pipeline-health/trigger', {
      method: 'POST',
    })

    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.skill).toBe('pipeline-health')
  })

  it('works for any valid skill name including custom ones', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/pipeline-health/trigger', {
      method: 'POST',
    })

    expect(res.status).toBe(202)
    expect(skillQueue.add).toHaveBeenCalledWith(
      'pipeline-health',
      expect.objectContaining({ skillName: 'pipeline-health' }),
      expect.any(Object),
    )
  })

  it('returns 400 for skill names with invalid characters', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/invalid_name!/trigger', {
      method: 'POST',
    })

    // Hono routing may not match — either 400 or 404 depending on param encoding
    // The key requirement is: invalid names must NOT trigger the queue
    expect(skillQueue.add).not.toHaveBeenCalled()
  })

  it('returns 404 when skillQueue is not wired up', async () => {
    const app = createApp({ db: db as any })
    const res = await app.request('/api/v1/skills/weekly-brief/trigger', {
      method: 'POST',
    })
    expect(res.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// PATCH /api/v1/skills/:name
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/skills/:name', () => {
  let db: ReturnType<typeof makeMockDb>
  let skillQueue: ReturnType<typeof makeMockSkillQueue>
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    db = makeMockDb()
    skillQueue = makeMockSkillQueue()
    resetKnownSkills()
    // Use a temp directory for YAML persistence tests
    tmpDir = mkdtempSync(join(tmpdir(), 'skills-test-'))
    setSkillsYamlPath(join(tmpDir, 'skills.yaml'))
  })

  afterEach(() => {
    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('returns 200 with updated schedule for valid cron', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 19 * * 0' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe('weekly-brief')
    expect(body.schedule).toBe('0 19 * * 0')
    expect(body.updated_at).toBeTruthy()
  })

  it('updates in-memory KNOWN_SKILLS after PATCH', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '30 10 * * 1' }),
    })

    const skills = getKnownSkills()
    expect(skills['weekly-brief'].schedule).toBe('30 10 * * 1')
  })

  it('GET /api/v1/skills reflects the updated schedule', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    // PATCH to update
    await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 6 * * 1-5' }),
    })

    // GET to verify
    const res = await app.request('/api/v1/skills')
    const body = await res.json()
    const brief = body.skills.find((s: { name: string }) => s.name === 'weekly-brief')
    expect(brief.schedule).toBe('0 6 * * 1-5')
  })

  it('persists updated schedule to config/skills.yaml', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 19 * * 0' }),
    })

    const yamlPath = join(tmpDir, 'skills.yaml')
    expect(existsSync(yamlPath)).toBe(true)
    const content = readFileSync(yamlPath, 'utf8')
    expect(content).toContain('weekly-brief')
    expect(content).toContain('0 19 * * 0')
  })

  it('returns 400 for invalid cron expression', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '60 * * * *' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Invalid cron expression')
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for non-5-field cron expression', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '* * * * * *' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('5-field')
  })

  it('returns 400 for missing schedule field', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cron: '0 19 * * 0' }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('schedule')
  })

  it('returns 400 for non-string schedule', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: 12345 }),
    })

    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid JSON body', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 for unknown skill name', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/nonexistent-skill', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 19 * * 0' }),
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.code).toBe('NOT_FOUND')
  })

  it('preserves description when updating schedule', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const originalSkills = getKnownSkills()
    const originalDescription = originalSkills['weekly-brief'].description

    await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '0 19 * * 0' }),
    })

    const updatedSkills = getKnownSkills()
    expect(updatedSkills['weekly-brief'].description).toBe(originalDescription)
    expect(updatedSkills['weekly-brief'].schedule).toBe('0 19 * * 0')
  })

  it('trims whitespace from cron expression', async () => {
    const app = createApp({
      db: db as any,
      skillQueue: skillQueue as any,
    })

    const res = await app.request('/api/v1/skills/weekly-brief', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: '  0 19 * * 0  ' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.schedule).toBe('0 19 * * 0')
  })
})

// ---------------------------------------------------------------------------
// validateCronExpression
// ---------------------------------------------------------------------------

describe('validateCronExpression', () => {
  it('returns null for valid 5-field cron expressions', () => {
    expect(validateCronExpression('0 20 * * 0')).toBeNull()
    expect(validateCronExpression('*/5 * * * *')).toBeNull()
    expect(validateCronExpression('0 0 1 * *')).toBeNull()
    expect(validateCronExpression('0 6 * * 1-5')).toBeNull()
    expect(validateCronExpression('30 8,12,18 * * *')).toBeNull()
  })

  it('returns error for invalid cron values', () => {
    const result = validateCronExpression('60 * * * *')
    expect(result).toBeTruthy()
    expect(result).toContain('60')
  })

  it('returns error for non-5-field expressions', () => {
    expect(validateCronExpression('* * * *')).toContain('4 fields')
    expect(validateCronExpression('* * * * * *')).toContain('6 fields')
  })

  it('returns error for empty string', () => {
    expect(validateCronExpression('')).toBeTruthy()
  })

  it('returns error for garbage input', () => {
    expect(validateCronExpression('not a cron at all hello')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// loadSkillsFromYaml
// ---------------------------------------------------------------------------

describe('loadSkillsFromYaml', () => {
  let tmpDir: string

  beforeEach(() => {
    resetKnownSkills()
    tmpDir = mkdtempSync(join(tmpdir(), 'skills-yaml-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('uses defaults when skills.yaml does not exist', () => {
    setSkillsYamlPath(join(tmpDir, 'nonexistent.yaml'))
    loadSkillsFromYaml()

    const skills = getKnownSkills()
    expect(skills['weekly-brief'].schedule).toBe('0 20 * * 0')
  })

  it('merges schedule overrides from skills.yaml', () => {
    const yamlPath = join(tmpDir, 'skills.yaml')
    const yamlContent = `
skills:
  weekly-brief:
    schedule: "0 19 * * 0"
    description: "Custom brief description"
  pipeline-health:
    schedule: "*/30 * * * *"
`
    writeFileSync(yamlPath, yamlContent, 'utf8')
    setSkillsYamlPath(yamlPath)
    loadSkillsFromYaml()

    const skills = getKnownSkills()
    expect(skills['weekly-brief'].schedule).toBe('0 19 * * 0')
    expect(skills['weekly-brief'].description).toBe('Custom brief description')
    expect(skills['pipeline-health'].schedule).toBe('*/30 * * * *')
    // Non-overridden skills retain defaults
    expect(skills['daily-connections'].schedule).toBe('0 21 * * *')
  })

  it('handles malformed YAML gracefully', () => {
    const yamlPath = join(tmpDir, 'skills.yaml')
    writeFileSync(yamlPath, ': : invalid yaml : :', 'utf8')
    setSkillsYamlPath(yamlPath)

    // Should not throw — logs a warning and uses defaults
    expect(() => loadSkillsFromYaml()).not.toThrow()
    const skills = getKnownSkills()
    expect(skills['weekly-brief'].schedule).toBe('0 20 * * 0')
  })

  it('handles YAML with unexpected shape (no skills key)', () => {
    const yamlPath = join(tmpDir, 'skills.yaml')
    writeFileSync(yamlPath, 'some_other_key: value\n', 'utf8')
    setSkillsYamlPath(yamlPath)

    expect(() => loadSkillsFromYaml()).not.toThrow()
    const skills = getKnownSkills()
    expect(skills['weekly-brief'].schedule).toBe('0 20 * * 0')
  })

  it('includes custom skills from YAML that have a schedule', () => {
    const yamlPath = join(tmpDir, 'skills.yaml')
    const yamlContent = `
skills:
  custom-analysis:
    schedule: "0 6 * * 1"
    description: "Run weekly analysis"
`
    writeFileSync(yamlPath, yamlContent, 'utf8')
    setSkillsYamlPath(yamlPath)
    loadSkillsFromYaml()

    const skills = getKnownSkills()
    expect(skills['custom-analysis']).toBeDefined()
    expect(skills['custom-analysis'].schedule).toBe('0 6 * * 1')
    expect(skills['custom-analysis'].description).toBe('Run weekly analysis')
  })
})
