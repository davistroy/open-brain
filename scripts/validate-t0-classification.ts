#!/usr/bin/env tsx
/**
 * T0 Classification Validation Suite
 *
 * Runs 50 labeled examples through classification endpoints and reports accuracy.
 * Tests three classification types:
 *   - Intent classification (capture | query | command | conversation)
 *   - Capture type classification (decision | idea | observation | task | win | blocker | question | reflection)
 *   - Brain view classification (career | personal | technical | work-internal | client)
 *
 * Usage:
 *   npx tsx scripts/validate-t0-classification.ts                          # T0 only (Ollama)
 *   npx tsx scripts/validate-t0-classification.ts --compare                # T0 + T1 comparison
 *   npx tsx scripts/validate-t0-classification.ts --t0-url http://ollama:11434/v1
 *   npx tsx scripts/validate-t0-classification.ts --t1-url https://api.anthropic.com/v1
 *
 * Environment variables (fallback when flags not provided):
 *   OLLAMA_URL        - T0 Ollama base URL (default: http://localhost:11434/v1)
 *   LITELLM_URL       - T1 API base URL (default: https://api.anthropic.com/v1)
 *   LITELLM_API_KEY   - API key for T1 calls
 *
 * Output: accuracy per task, disagreements, latency comparison
 * Threshold: 90% accuracy required per classification task before cutover
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClassificationExample {
  id: number
  input: string
  expected_brain_view: string
  expected_capture_type: string
  expected_intent: string
}

export interface FixtureFile {
  version: string
  description: string
  generated: string
  examples: ClassificationExample[]
}

export type ClassificationTask = 'intent' | 'capture_type' | 'brain_view'

export interface SingleResult {
  exampleId: number
  task: ClassificationTask
  expected: string
  predicted: string
  correct: boolean
  latencyMs: number
  tier: 't0' | 't1'
}

export interface TaskAccuracy {
  task: ClassificationTask
  total: number
  correct: number
  accuracy: number
  avgLatencyMs: number
  passesThreshold: boolean
}

export interface ValidationReport {
  tier: 't0' | 't1'
  taskAccuracies: TaskAccuracy[]
  disagreements: SingleResult[]
  overallAccuracy: number
  totalExamples: number
  totalLatencyMs: number
}

// ---------------------------------------------------------------------------
// Prompt builders — mirror the production prompt formats
// ---------------------------------------------------------------------------

const INTENT_SYSTEM_PROMPT = `You classify messages into exactly one of four categories:
- capture: information, thoughts, decisions, observations, tasks, or anything the user wants to remember
- query: questions or search requests directed at the knowledge base
- command: bot control commands (stats, help, status, brief, budget)
- conversation: casual chat, greetings, confirmations, or small talk

Reply with ONLY a JSON object: {"intent":"<category>"}
No explanation, no markdown fencing.`

const CAPTURE_TYPE_SYSTEM_PROMPT = `You classify text into exactly one capture type:
- decision: a choice that was made, with rationale
- idea: a new concept, proposal, or what-if thought
- observation: something noticed, a fact, or event report
- task: an action item or to-do
- win: an achievement or positive outcome
- blocker: an obstacle preventing progress
- question: an open question seeking an answer
- reflection: introspection, lessons learned, or meta-thinking

Reply with ONLY a JSON object: {"capture_type":"<type>"}
No explanation, no markdown fencing.`

const BRAIN_VIEW_SYSTEM_PROMPT = `You classify text into exactly one brain view category:
- career: professional development, job search, career decisions, consulting practice
- personal: personal life, health, relationships, hobbies, family, farm
- technical: technical learning, architecture, tools, experiments, code, infrastructure
- work-internal: internal work items, meeting notes, sprint planning, team processes
- client: client-facing work, deliverables, client feedback, engagements

Reply with ONLY a JSON object: {"brain_view":"<category>"}
No explanation, no markdown fencing.`

export const PROMPTS: Record<ClassificationTask, { system: string; responseKey: string }> = {
  intent: { system: INTENT_SYSTEM_PROMPT, responseKey: 'intent' },
  capture_type: { system: CAPTURE_TYPE_SYSTEM_PROMPT, responseKey: 'capture_type' },
  brain_view: { system: BRAIN_VIEW_SYSTEM_PROMPT, responseKey: 'brain_view' },
}

/** Accuracy threshold required before production cutover */
export const ACCURACY_THRESHOLD = 0.90

// ---------------------------------------------------------------------------
// LLM caller — uses OpenAI-compatible /chat/completions
// ---------------------------------------------------------------------------

export interface LLMEndpoint {
  baseUrl: string
  apiKey: string
  model: string
  tier: 't0' | 't1'
  timeoutMs: number
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint and extracts
 * the classification value from the JSON response.
 */
export async function classifyOne(
  endpoint: LLMEndpoint,
  task: ClassificationTask,
  inputText: string,
): Promise<{ predicted: string; latencyMs: number }> {
  const { system, responseKey } = PROMPTS[task]

  const start = Date.now()

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), endpoint.timeoutMs)

  let response: Response
  try {
    response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: inputText },
        ],
        temperature: 0,
        max_completion_tokens: 64,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }

  const latencyMs = Date.now() - start

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }

  const raw = data.choices?.[0]?.message?.content?.trim() ?? ''

  // Parse JSON from the response, stripping markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  let predicted: string
  try {
    const parsed = JSON.parse(cleaned)
    predicted = String(parsed[responseKey] ?? '').toLowerCase().trim()
  } catch {
    // If not valid JSON, try to extract a bare word
    predicted = cleaned.toLowerCase().replace(/[^a-z_-]/g, '').trim()
  }

  return { predicted, latencyMs }
}

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

export function loadFixtures(fixturesPath?: string): ClassificationExample[] {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const defaultPath = resolve(__dirname, '..', 'tests', 'fixtures', 'classification-examples.json')
  const filePath = fixturesPath ?? defaultPath

  const raw = readFileSync(filePath, 'utf-8')
  const fixture: FixtureFile = JSON.parse(raw)

  if (!Array.isArray(fixture.examples) || fixture.examples.length === 0) {
    throw new Error(`No examples found in ${filePath}`)
  }

  return fixture.examples
}

/** Maps example fields to the expected value for a given task */
export function getExpected(example: ClassificationExample, task: ClassificationTask): string {
  switch (task) {
    case 'intent': return example.expected_intent
    case 'capture_type': return example.expected_capture_type
    case 'brain_view': return example.expected_brain_view
  }
}

// ---------------------------------------------------------------------------
// Validation runner
// ---------------------------------------------------------------------------

export async function runValidation(
  endpoint: LLMEndpoint,
  examples: ClassificationExample[],
  tasks: ClassificationTask[] = ['intent', 'capture_type', 'brain_view'],
): Promise<ValidationReport> {
  const results: SingleResult[] = []

  for (const example of examples) {
    for (const task of tasks) {
      const expected = getExpected(example, task)

      let predicted: string
      let latencyMs: number

      try {
        const result = await classifyOne(endpoint, task, example.input)
        predicted = result.predicted
        latencyMs = result.latencyMs
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  [FAIL] Example ${example.id} / ${task}: ${msg}`)
        predicted = '__error__'
        latencyMs = 0
      }

      results.push({
        exampleId: example.id,
        task,
        expected,
        predicted,
        correct: predicted === expected,
        latencyMs,
        tier: endpoint.tier,
      })
    }
  }

  return buildReport(results, endpoint.tier, examples.length)
}

export function buildReport(
  results: SingleResult[],
  tier: 't0' | 't1',
  totalExamples: number,
): ValidationReport {
  const tasks: ClassificationTask[] = ['intent', 'capture_type', 'brain_view']

  const taskAccuracies = tasks.map((task) => {
    const taskResults = results.filter((r) => r.task === task)
    const correct = taskResults.filter((r) => r.correct).length
    const total = taskResults.length
    const avgLatency = total > 0
      ? taskResults.reduce((sum, r) => sum + r.latencyMs, 0) / total
      : 0

    return {
      task,
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      avgLatencyMs: Math.round(avgLatency),
      passesThreshold: total > 0 ? (correct / total) >= ACCURACY_THRESHOLD : false,
    }
  })

  const allCorrect = results.filter((r) => r.correct).length
  const disagreements = results.filter((r) => !r.correct)
  const totalLatencyMs = results.reduce((sum, r) => sum + r.latencyMs, 0)

  return {
    tier,
    taskAccuracies,
    disagreements,
    overallAccuracy: results.length > 0 ? allCorrect / results.length : 0,
    totalExamples,
    totalLatencyMs,
  }
}

// ---------------------------------------------------------------------------
// Report formatter
// ---------------------------------------------------------------------------

export function formatReport(report: ValidationReport): string {
  const lines: string[] = []

  lines.push('')
  lines.push(`=== ${report.tier.toUpperCase()} Classification Validation Report ===`)
  lines.push(`Total examples: ${report.totalExamples}`)
  lines.push(`Total time: ${(report.totalLatencyMs / 1000).toFixed(1)}s`)
  lines.push(`Overall accuracy: ${(report.overallAccuracy * 100).toFixed(1)}%`)
  lines.push('')

  lines.push('--- Per-Task Accuracy ---')
  lines.push(
    'Task'.padEnd(25) +
    'Correct'.padEnd(10) +
    'Total'.padEnd(8) +
    'Accuracy'.padEnd(12) +
    'Avg Latency'.padEnd(14) +
    'Pass',
  )
  lines.push('-'.repeat(75))

  for (const ta of report.taskAccuracies) {
    const pass = ta.passesThreshold ? 'PASS' : 'FAIL'
    lines.push(
      ta.task.padEnd(25) +
      String(ta.correct).padEnd(10) +
      String(ta.total).padEnd(8) +
      `${(ta.accuracy * 100).toFixed(1)}%`.padEnd(12) +
      `${ta.avgLatencyMs}ms`.padEnd(14) +
      pass,
    )
  }

  if (report.disagreements.length > 0) {
    lines.push('')
    lines.push(`--- Disagreements (${report.disagreements.length}) ---`)
    for (const d of report.disagreements) {
      lines.push(`  Example ${d.exampleId} / ${d.task}: expected="${d.expected}" got="${d.predicted}"`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

export function formatComparison(t0Report: ValidationReport, t1Report: ValidationReport): string {
  const lines: string[] = []

  lines.push('')
  lines.push('=== T0 vs T1 Comparison ===')
  lines.push('')
  lines.push(
    'Task'.padEnd(25) +
    'T0 Accuracy'.padEnd(14) +
    'T1 Accuracy'.padEnd(14) +
    'T0 Latency'.padEnd(14) +
    'T1 Latency'.padEnd(14) +
    'Delta',
  )
  lines.push('-'.repeat(85))

  const tasks: ClassificationTask[] = ['intent', 'capture_type', 'brain_view']
  for (const task of tasks) {
    const t0 = t0Report.taskAccuracies.find((a) => a.task === task)
    const t1 = t1Report.taskAccuracies.find((a) => a.task === task)
    if (!t0 || !t1) continue

    const delta = ((t0.accuracy - t1.accuracy) * 100).toFixed(1)
    const sign = Number(delta) >= 0 ? '+' : ''

    lines.push(
      task.padEnd(25) +
      `${(t0.accuracy * 100).toFixed(1)}%`.padEnd(14) +
      `${(t1.accuracy * 100).toFixed(1)}%`.padEnd(14) +
      `${t0.avgLatencyMs}ms`.padEnd(14) +
      `${t1.avgLatencyMs}ms`.padEnd(14) +
      `${sign}${delta}%`,
    )
  }

  lines.push('')
  const t0Total = (t0Report.totalLatencyMs / 1000).toFixed(1)
  const t1Total = (t1Report.totalLatencyMs / 1000).toFixed(1)
  lines.push(`Total time: T0=${t0Total}s, T1=${t1Total}s`)
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI argument parser
// ---------------------------------------------------------------------------

interface CLIArgs {
  compare: boolean
  t0Url: string
  t0Model: string
  t1Url: string
  t1Model: string
  t1ApiKey: string
  fixturesPath?: string
}

export function parseArgs(argv: string[]): CLIArgs {
  const args: CLIArgs = {
    compare: false,
    t0Url: process.env.OLLAMA_URL ?? 'http://localhost:11434/v1',
    t0Model: 'gemma4:12b-q4_K_M',
    t1Url: process.env.LITELLM_URL ?? 'https://api.anthropic.com/v1',
    t1Model: 'claude-haiku-4-5-20251001',
    t1ApiKey: process.env.LITELLM_API_KEY ?? '',
  }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--compare':
        args.compare = true
        break
      case '--t0-url':
        args.t0Url = argv[++i] ?? args.t0Url
        break
      case '--t0-model':
        args.t0Model = argv[++i] ?? args.t0Model
        break
      case '--t1-url':
        args.t1Url = argv[++i] ?? args.t1Url
        break
      case '--t1-model':
        args.t1Model = argv[++i] ?? args.t1Model
        break
      case '--t1-api-key':
        args.t1ApiKey = argv[++i] ?? args.t1ApiKey
        break
      case '--fixtures':
        args.fixturesPath = argv[++i]
        break
    }
  }

  return args
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  console.log('Loading classification examples...')
  const examples = loadFixtures(args.fixturesPath)
  console.log(`Loaded ${examples.length} examples`)

  // --- T0 validation ---
  const t0Endpoint: LLMEndpoint = {
    baseUrl: args.t0Url.replace(/\/$/, ''),
    apiKey: '',  // Ollama needs no API key
    model: args.t0Model,
    tier: 't0',
    timeoutMs: 15_000,
  }

  console.log(`\nRunning T0 validation (${t0Endpoint.model} @ ${t0Endpoint.baseUrl})...`)
  const t0Report = await runValidation(t0Endpoint, examples)
  console.log(formatReport(t0Report))

  // Check 90% threshold
  const t0AllPass = t0Report.taskAccuracies.every((ta) => ta.passesThreshold)
  if (t0AllPass) {
    console.log('T0 PASSES all accuracy thresholds (>=90%). Ready for cutover.')
  } else {
    const failures = t0Report.taskAccuracies
      .filter((ta) => !ta.passesThreshold)
      .map((ta) => `${ta.task} (${(ta.accuracy * 100).toFixed(1)}%)`)
    console.log(`T0 FAILS threshold on: ${failures.join(', ')}. These tasks should stay on T1.`)
  }

  // --- T1 comparison (optional) ---
  if (args.compare) {
    if (!args.t1ApiKey) {
      console.error('\nERROR: --compare requires T1 API key (set LITELLM_API_KEY or --t1-api-key)')
      process.exit(1)
    }

    const t1Endpoint: LLMEndpoint = {
      baseUrl: args.t1Url.replace(/\/$/, ''),
      apiKey: args.t1ApiKey,
      model: args.t1Model,
      tier: 't1',
      timeoutMs: 20_000,
    }

    console.log(`\nRunning T1 baseline (${t1Endpoint.model} @ ${t1Endpoint.baseUrl})...`)
    const t1Report = await runValidation(t1Endpoint, examples)
    console.log(formatReport(t1Report))
    console.log(formatComparison(t0Report, t1Report))
  }
}

// Run if executed directly (not imported as module)
const isMainModule = process.argv[1]?.replace(/\\/g, '/').includes('validate-t0-classification')
if (isMainModule) {
  main().catch((err) => {
    console.error('Validation failed:', err)
    process.exit(1)
  })
}
