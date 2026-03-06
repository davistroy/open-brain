export type AITaskType =
  | 'classify'
  | 'embed'
  | 'synthesize'
  | 'govern'
  | 'intent'

export interface AIOptions {
  task_type: AITaskType
  model?: string         // override — uses config alias if omitted
  max_tokens?: number
  temperature?: number
  system_prompt?: string
}

export interface AIResponse {
  content: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  duration_ms: number
}

export interface EmbeddingResponse {
  embedding: number[]   // always 768 dimensions
  model: string
  duration_ms: number
}
