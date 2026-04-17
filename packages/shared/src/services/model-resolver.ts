/**
 * model-resolver — pure task -> model resolver for the three-tier routing config.
 *
 * Resolves a task name (e.g., `email_compose`) to the concrete model id that
 * should be passed to the LLM SDK, via `ai-routing.yaml`'s `task_routing`
 * (task -> tier key) and `model_tiers` (tier key -> model metadata) maps.
 *
 * Callers hold the loaded `AIConfig` (from `ConfigService.get('ai')`) and pass
 * it in — this function is pure, dependency-injected, and has no I/O so it is
 * trivial to unit-test.
 *
 * Hard-fails on misconfiguration:
 *   - unknown task name (not present in `task_routing`)
 *   - task mapped to a tier key that does not exist in `model_tiers`
 *   - `task_routing` or `model_tiers` missing entirely (legacy / misconfigured)
 *
 * Error messages always name the offending alias and list known aliases so the
 * operator can fix `config/ai-routing.yaml` without additional investigation.
 */
import type { AIConfig } from '../types/config.js'

/** Structured result returned by `resolveTaskModel`. */
export interface ResolvedTaskModel {
  /** Concrete model id suitable for `openai.chat.completions.create({ model, ... })`. */
  readonly model: string
  /** Tier key (e.g., `t2_quality`) that the task routed to. */
  readonly tierKey: string
}

/**
 * Typed error thrown when a task cannot be resolved. Carries the offending
 * task name so callers can log/metric on it without re-parsing the message.
 */
export class ModelResolverError extends Error {
  public readonly taskName: string

  constructor(message: string, taskName: string) {
    super(message)
    this.name = 'ModelResolverError'
    this.taskName = taskName
  }
}

/**
 * Resolve a task name to its concrete model.
 *
 * @param config   the `ai` slice of the loaded config (from `ConfigService.get('ai')`)
 * @param taskName the logical task name (e.g., `email_compose`, `entity_extraction`)
 * @returns `{ model, tierKey }` where `model` can be passed directly to the LLM SDK
 * @throws {ModelResolverError} if the task or its tier cannot be resolved
 */
export function resolveTaskModel(
  config: AIConfig,
  taskName: string,
): ResolvedTaskModel {
  const taskRouting = config.task_routing
  const modelTiers = config.model_tiers

  if (!taskRouting || !modelTiers) {
    throw new ModelResolverError(
      `Cannot resolve task '${taskName}': ai-routing.yaml is missing 'task_routing' or 'model_tiers'. ` +
        `Ensure config/ai-routing.yaml defines both sections.`,
      taskName,
    )
  }

  const tierKey = taskRouting[taskName]
  if (!tierKey) {
    const knownTasks = Object.keys(taskRouting).sort()
    throw new ModelResolverError(
      `Unknown task alias '${taskName}'. Known task aliases: ${knownTasks.length > 0 ? knownTasks.join(', ') : '(none)'}.`,
      taskName,
    )
  }

  const tier = modelTiers[tierKey]
  if (!tier) {
    const knownTiers = Object.keys(modelTiers).sort()
    throw new ModelResolverError(
      `Task '${taskName}' is routed to tier '${tierKey}', but that tier is not defined in model_tiers. ` +
        `Known tiers: ${knownTiers.length > 0 ? knownTiers.join(', ') : '(none)'}.`,
      taskName,
    )
  }

  return { model: tier.model, tierKey }
}
