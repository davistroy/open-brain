import OpenAI from 'openai'
import { createLogger, createOpenAIClient } from '@open-brain/shared'
import { resolveClassificationModel } from '../lib/classification-model.js'

const logger = createLogger('voice-classification')

export type CaptureType =
  | 'decision'
  | 'idea'
  | 'observation'
  | 'task'
  | 'win'
  | 'blocker'
  | 'question'
  | 'reflection'

export interface ClassificationField {
  name: string
  value: string
}

export interface ClassificationResult {
  template: CaptureType
  confidence: number
  fields: ClassificationField[]
  transcript_raw: string
}

const CAPTURE_TYPES: CaptureType[] = [
  'decision',
  'idea',
  'observation',
  'task',
  'win',
  'blocker',
  'question',
  'reflection',
]

const CLASSIFICATION_PROMPT = `You are classifying a voice memo transcript into one of the following capture types: decision, idea, observation, task, win, blocker, question, reflection.

Transcript:
"""
{{transcript}}
"""

Respond with a JSON object only — no markdown, no explanation. Format:
{
  "template": "<capture_type>",
  "confidence": <0.0 to 1.0>,
  "fields": [
    { "name": "summary", "value": "<one sentence summary>" },
    { "name": "topics", "value": "<comma-separated key topics>" }
  ]
}

Rules:
- template must be exactly one of: decision, idea, observation, task, win, blocker, question, reflection
- confidence is your certainty (0.0 = unsure, 1.0 = certain)
- Always include summary and topics fields
- For tasks: add { "name": "action", "value": "<specific action required>" }
- For decisions: add { "name": "rationale", "value": "<brief rationale>" }
- For blockers: add { "name": "impact", "value": "<what is blocked>" }`

/**
 * ClassificationService uses LiteLLM (via OpenAI SDK) to classify a voice
 * transcript into one of the eight capture types. Returns structured
 * pre_extracted metadata for downstream pipeline stages.
 */
export class ClassificationService {
  private client: OpenAI

  constructor() {
    // Prefer shared OpenAI client factory (reads OPENAI_BASE_URL / OPENAI_API_KEY).
    // Falls back to a direct OpenAI construction for test compatibility (tests vi.mock('openai')).
    this.client = createOpenAIClient({ timeout: 'fast' }) ?? new OpenAI({
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || 'unconfigured',
      timeout: 30_000,
    })
  }

  async classify(transcriptText: string): Promise<ClassificationResult> {
    const prompt = CLASSIFICATION_PROMPT.replace('{{transcript}}', transcriptText)

    logger.info({ textLength: transcriptText.length }, 'Classifying voice transcript')

    // INT-M2 (voice): this OpenAI call's spend is not yet recorded in ai_audit_log, so the
    // budget circuit breaker does not see it. The high-volume blind spot (embeddings) is
    // closed via EmbeddingService.recordSpend. voice-capture is intentionally thin (no DB,
    // no ai-routing config) — the resilient way to record this low-volume, human-gated
    // spend is to attach `response.usage` to the capture payload and let core-api (which
    // owns the DB + cost config) write the row at ingest. Tracked follow-up: INT-M2-voice.
    const response = await this.client.chat.completions.create({
      model: resolveClassificationModel(),
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_completion_tokens: 512,
    })
    const raw = response.choices[0]?.message?.content ?? ''

    let parsed: { template?: string; confidence?: number; fields?: ClassificationField[] }
    try {
      parsed = JSON.parse(raw)
    } catch {
      logger.warn({ raw }, 'Classification response was not valid JSON — defaulting to observation')
      parsed = {}
    }

    const template = CAPTURE_TYPES.includes(parsed.template as CaptureType)
      ? (parsed.template as CaptureType)
      : 'observation'

    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0.5

    const fields = Array.isArray(parsed.fields) ? parsed.fields : [
      { name: 'summary', value: transcriptText.slice(0, 200) },
      { name: 'topics', value: '' },
    ]

    const result: ClassificationResult = {
      template,
      confidence,
      fields,
      transcript_raw: transcriptText,
    }

    logger.info(
      { template, confidence },
      'Classification complete',
    )

    return result
  }
}
