import OpenAI from 'openai'
import pino from 'pino'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const LITELLM_URL = process.env.LITELLM_URL ?? 'https://llm.k4jda.net'
const LITELLM_API_KEY = process.env.LITELLM_API_KEY ?? ''
const CLASSIFICATION_TIMEOUT_MS = 30_000
const CLASSIFICATION_MODEL = 'fast' // LiteLLM alias

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
    this.client = new OpenAI({
      baseURL: LITELLM_URL,
      apiKey: LITELLM_API_KEY,
      timeout: CLASSIFICATION_TIMEOUT_MS,
    })
  }

  async classify(transcriptText: string): Promise<ClassificationResult> {
    const prompt = CLASSIFICATION_PROMPT.replace('{{transcript}}', transcriptText)

    logger.info({ textLength: transcriptText.length }, 'Classifying voice transcript')

    const response = await this.client.chat.completions.create({
      model: CLASSIFICATION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 512,
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
