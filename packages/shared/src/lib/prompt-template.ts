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
