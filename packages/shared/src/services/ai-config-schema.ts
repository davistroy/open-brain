import type { AIConfig } from '../types/config.js'

/**
 * Providers that carry real monetary cost per token.
 * ollama is exempt — it runs locally and has no per-token cost.
 * openai_compat tiers may be free (Jetson, Spark) or paid; they are NOT exempt.
 * Tiers using these providers MUST declare both cost fields explicitly
 * (explicit 0 is allowed for free endpoints like Jetson/Spark).
 */
export const PAID_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'openai_compat',
  'litellm',
  'deepseek',
])

/**
 * Validate a fully-parsed AIConfig against four business rules.
 * Throws with an actionable, operator-readable message on the first violation found.
 *
 * Rules enforced:
 *   1. Paid-provider tiers must declare both cost_per_1k_input and cost_per_1k_output
 *      (explicit 0 is accepted; undefined fails — the budget circuit breaker would be blind).
 *   2. task_routing entries must reference tiers that exist in model_tiers.
 *   3. Tier fallback references must exist in model_tiers.
 *   4. monthly_budget.soft_limit_usd and hard_limit_usd must both be > 0,
 *      and hard_limit_usd must be strictly greater than soft_limit_usd.
 *
 * Not called from reload() — reloads are log-and-keep (existing behavior).
 * Only called from ConfigService.load() for fail-fast startup enforcement.
 */
export function validateAiRoutingConfig(config: AIConfig): void {
  const tiers = config.model_tiers
  const routing = config.task_routing

  // Rule 1: paid-provider tiers must have both cost fields (undefined fails; 0 is OK)
  if (tiers) {
    for (const [tierKey, tier] of Object.entries(tiers)) {
      if (PAID_PROVIDERS.has(tier.provider)) {
        if (tier.cost_per_1k_input === undefined) {
          throw new Error(
            `Tier '${tierKey}' has provider='${tier.provider}' but cost_per_1k_input is undefined.\n` +
              `The budget circuit breaker would be blind to this tier's costs.\n` +
              `Set both cost_per_1k_input and cost_per_1k_output in config/ai-routing.yaml.`,
          )
        }
        if (tier.cost_per_1k_output === undefined) {
          throw new Error(
            `Tier '${tierKey}' has provider='${tier.provider}' but cost_per_1k_output is undefined.\n` +
              `The budget circuit breaker would be blind to this tier's costs.\n` +
              `Set both cost_per_1k_input and cost_per_1k_output in config/ai-routing.yaml.`,
          )
        }
      }
    }
  }

  // Rule 2: task_routing entries must reference existing tiers
  if (routing && tiers) {
    for (const [task, tierKey] of Object.entries(routing)) {
      if (!tiers[tierKey]) {
        throw new Error(
          `task_routing entry '${task}' maps to tier '${tierKey}' which does not exist in model_tiers.\n` +
            `Add '${tierKey}' to model_tiers or update task_routing to reference an existing tier.`,
        )
      }
    }
  }

  // Rule 3: fallback tier references must exist in model_tiers
  if (tiers) {
    for (const [tierKey, tier] of Object.entries(tiers)) {
      if (tier.fallback != null && !tiers[tier.fallback]) {
        throw new Error(
          `Tier '${tierKey}' declares fallback '${tier.fallback}' which does not exist in model_tiers.\n` +
            `Either add '${tier.fallback}' to model_tiers or set fallback: null for '${tierKey}'.`,
        )
      }
    }
  }

  // Rule 4: monthly_budget positivity and ordering
  const { soft_limit_usd, hard_limit_usd } = config.monthly_budget
  if (soft_limit_usd <= 0) {
    throw new Error(
      `monthly_budget.soft_limit_usd (${soft_limit_usd}) must be greater than 0.\n` +
        `Fix: set soft_limit_usd to a positive value in config/ai-routing.yaml.`,
    )
  }
  if (hard_limit_usd <= 0) {
    throw new Error(
      `monthly_budget.hard_limit_usd (${hard_limit_usd}) must be greater than 0.\n` +
        `Fix: set hard_limit_usd to a positive value in config/ai-routing.yaml.`,
    )
  }
  if (hard_limit_usd <= soft_limit_usd) {
    throw new Error(
      `monthly_budget.hard_limit_usd (${hard_limit_usd}) must be greater than monthly_budget.soft_limit_usd (${soft_limit_usd}).\n` +
        `Fix: set hard_limit_usd to a value greater than soft_limit_usd in config/ai-routing.yaml.`,
    )
  }
}
