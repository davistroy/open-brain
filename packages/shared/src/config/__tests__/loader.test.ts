import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigService } from '../loader.js'

function makeTmpDir(): string {
  const dir = join(tmpdir(), `open-brain-test-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const validBrainViews = `
views:
  - name: career
    description: Career stuff
  - name: personal
    description: Personal stuff
`

const validPipeline = `
stages:
  - name: classify
    enabled: true
retry:
  max_attempts: 3
  backoff_ms: [1000, 5000]
`

const validAi = `
litellm_url: "https://llm.k4jda.net"
models:
  fast: fast
  synthesis: synthesis
  governance: governance
  intent: intent
  embedding: spark-qwen3-embedding-4b
monthly_budget:
  soft_limit_usd: 30
  hard_limit_usd: 50
`

const validNotifications = `
pushover:
  enabled: false
weekly_brief:
  enabled: true
`

function writeValidConfigs(dir: string): void {
  writeFileSync(join(dir, 'brain-views.yaml'), validBrainViews)
  writeFileSync(join(dir, 'pipeline.yaml'), validPipeline)
  writeFileSync(join(dir, 'ai-routing.yaml'), validAi)
  writeFileSync(join(dir, 'notifications.yaml'), validNotifications)
}

describe('ConfigService', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTmpDir()
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true })
  })

  it('loads valid config without errors', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    expect(() => service.load()).not.toThrow()
  })

  it('throws on startup if a config file is missing', () => {
    // Only write 3 of 4 files
    writeFileSync(join(tmpDir, 'brain-views.yaml'), validBrainViews)
    writeFileSync(join(tmpDir, 'pipeline.yaml'), validPipeline)
    writeFileSync(join(tmpDir, 'ai-routing.yaml'), validAi)
    // Missing notifications.yaml
    const service = new ConfigService(tmpDir)
    expect(() => service.load()).toThrow()
  })

  it('throws on startup if YAML is invalid', () => {
    writeValidConfigs(tmpDir)
    writeFileSync(join(tmpDir, 'brain-views.yaml'), 'invalid: yaml: [unclosed')
    const service = new ConfigService(tmpDir)
    expect(() => service.load()).toThrow()
  })

  it('getBrainViews returns view names', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    service.load()
    expect(service.getBrainViews()).toEqual(['career', 'personal'])
  })

  it('reload keeps previous config on failure', () => {
    writeValidConfigs(tmpDir)
    const service = new ConfigService(tmpDir)
    service.load()

    // Break one config file
    writeFileSync(join(tmpDir, 'brain-views.yaml'), 'invalid: [unclosed')
    const results = service.reload()

    const failed = results.find(r => r.file === 'brain-views.yaml')
    expect(failed?.success).toBe(false)
    expect(failed?.error).toBeTruthy()

    // Previous config still works
    expect(service.getBrainViews()).toEqual(['career', 'personal'])
  })

  it('throws if get() called before load()', () => {
    const service = new ConfigService(tmpDir)
    expect(() => service.get('brainViews')).toThrow('not loaded')
  })
})
