import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Loads a prompt template file from disk.
 *
 * @param promptsDir - Directory containing prompt template files
 * @param templateName - Filename (with extension) of the template to load
 * @returns The raw template string
 * @throws Error if the file does not exist
 */
export function loadPromptTemplate(promptsDir: string, templateName: string): string {
  const templatePath = join(promptsDir, templateName)

  if (!existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`)
  }

  return readFileSync(templatePath, 'utf8')
}

/**
 * Renders a prompt template by replacing `{{key}}` placeholders with values.
 *
 * - Missing variables (keys in the template but not in `vars`) are left as-is.
 * - Extra variables (keys in `vars` but not in the template) are silently ignored.
 *
 * @param template - The raw template string with `{{key}}` placeholders
 * @param vars - Key/value pairs to substitute
 * @returns The rendered template string
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  let rendered = template

  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value)
  }

  return rendered
}

/**
 * Convenience: loads a template file and renders it in one call.
 *
 * @param promptsDir - Directory containing prompt template files
 * @param templateName - Filename (with extension) of the template to load
 * @param vars - Key/value pairs to substitute
 * @returns The rendered template string
 */
export function loadAndRenderPromptTemplate(
  promptsDir: string,
  templateName: string,
  vars: Record<string, string>,
): string {
  const template = loadPromptTemplate(promptsDir, templateName)
  return renderPromptTemplate(template, vars)
}

/**
 * TemplateCache loads prompt templates from disk on first access and
 * serves subsequent reads from an in-memory Map. Templates are static
 * at runtime, so this eliminates all hot-path disk I/O.
 *
 * Use `preload()` at startup for fail-fast validation, or rely on
 * lazy loading via `get()` / `render()`.
 */
export class TemplateCache {
  private cache = new Map<string, string>()
  private promptsDir: string

  constructor(promptsDir: string) {
    this.promptsDir = promptsDir
  }

  /**
   * Returns the raw template string, loading from disk on first access.
   * Throws if the template file does not exist.
   */
  get(templateName: string): string {
    const cached = this.cache.get(templateName)
    if (cached !== undefined) return cached

    const content = loadPromptTemplate(this.promptsDir, templateName)
    this.cache.set(templateName, content)
    return content
  }

  /**
   * Loads a template (from cache or disk) and renders it with the given variables.
   */
  render(templateName: string, vars: Record<string, string>): string {
    const template = this.get(templateName)
    return renderPromptTemplate(template, vars)
  }

  /**
   * Eagerly loads templates into cache. Call at startup for fail-fast validation.
   */
  preload(...names: string[]): void {
    for (const name of names) {
      this.get(name)
    }
  }

  /** Clears the cache (for hot-reload in development). */
  invalidate(): void {
    this.cache.clear()
  }
}
