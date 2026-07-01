import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { createLogger } from '@open-brain/shared'

const log = createLogger('voice-classification-model')

const FALLBACK_MODEL = 'gpt-5.4'
// Resolve from the `models.intent` alias, NOT `task_routing.voice_classification`.
// Rationale: ClassificationService uses the OpenAI client bound to OPENAI_BASE_URL
// (api.openai.com in prod), so the model string MUST be OpenAI-servable. The
// task_routing tier for voice_classification is `t1_jetson` (model `qwen3.5-4b`,
// an openai_compat endpoint on the Jetson LAN box) — sending that to api.openai.com
// would 404. `models.intent` (→ gpt-5.4) is the OpenAI-servable alias that
// slack-bot already reads via this same lightweight js-yaml pattern. This makes
// the model config-driven (SA-7) without changing the working runtime behavior or
// making this thin service tier-aware. (Full T1/Jetson routing for voice — the
// cost-tiering ideal — would require voice-capture to build its client from the
// tier's base_url + a fallback chain; that's a larger change, out of scope here.)
const MODEL_ALIAS = 'intent'

interface AiRoutingYaml {
  models?: Record<string, unknown>
}

/**
 * Resolve the classification model used by ClassificationService, with this precedence:
 *
 *   1. CLASSIFICATION_MODEL env var (explicit override — preserved from original behaviour)
 *   2. config/ai-routing.yaml: `models.intent` (an OpenAI-servable alias)
 *   3. Hardcoded fallback 'gpt-5.4' if the config is unavailable or unparseable
 *
 * Mirrors the lightweight YAML-load pattern in brain-views.ts:
 *   - Reads CONFIG_DIR env var, defaulting to '/app/config'
 *   - Never throws — any file/parse error produces the fallback (graceful degradation)
 *   - Read per-call (no module-level cache) so the function is trivially testable.
 */
export function resolveClassificationModel(): string {
  // Priority 1: explicit env override
  const envOverride = process.env.CLASSIFICATION_MODEL
  if (envOverride) return envOverride

  // Priority 2: config/ai-routing.yaml `models.intent`
  const configDir = process.env.CONFIG_DIR ?? '/app/config'
  const configPath = join(configDir, 'ai-routing.yaml')

  if (!existsSync(configPath)) return FALLBACK_MODEL

  try {
    const raw = yaml.load(readFileSync(configPath, 'utf8')) as AiRoutingYaml | null
    const model = raw?.models?.[MODEL_ALIAS]
    if (typeof model === 'string' && model.length > 0) return model
    return FALLBACK_MODEL
  } catch (err) {
    log.warn({ err, configPath }, 'Failed to load ai-routing.yaml — falling back to default classification model')
    return FALLBACK_MODEL
  }
}
