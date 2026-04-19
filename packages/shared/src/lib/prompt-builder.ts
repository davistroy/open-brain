import { createLogger } from './logger.js'

const logger = createLogger('prompt-builder')

/**
 * Injection pattern descriptor — pattern + human-readable name used in log output.
 */
interface InjectionPattern {
  name: string
  regex: RegExp
}

/**
 * Known prompt-injection patterns stripped by SafePromptBuilder.
 * Replacement is `[REDACTED]` (not silent drop) so the LLM sees a signal
 * that something was removed and logs can detect sanitization events.
 */
const INJECTION_PATTERNS: InjectionPattern[] = [
  { name: 'ignore-previous-instructions', regex: /ignore\s+previous\s+instructions/gi },
  { name: 'ignore-all-instructions', regex: /ignore\s+all\s+instructions/gi },
  { name: 'llama2-inst-open', regex: /\[INST\]/gi },
  { name: 'llama2-inst-close', regex: /\[\/INST\]/gi },
  { name: 'chatml-im-start', regex: /<\|im_start\|>/gi },
  { name: 'chatml-im-end', regex: /<\|im_end\|>/gi },
  { name: 'llama2-sys-open', regex: /<<SYS>>/gi },
  { name: 'llama2-sys-close', regex: /<\/SYS>>/gi },
  { name: 'system-tag-open', regex: /<system>/gi },
  { name: 'system-tag-close', regex: /<\/system>/gi },
  { name: 'role-injection-assistant', regex: /^assistant:\s*/gim },
  { name: 'role-injection-user', regex: /^user:\s*/gim },
  { name: 'role-injection-system', regex: /^system:\s*/gim },
  { name: 'markdown-heading-injection', regex: /^###\s+/gm },
]

const REDACTED_MARKER = '[REDACTED]'

/**
 * SafePromptBuilder wraps user-controlled content in session-random XML-style
 * fenced delimiters and strips known prompt-injection patterns before any content
 * reaches an LLM call site.
 *
 * **Delimiter uniqueness:** Each instance generates a random `delimiterPrefix`
 * (e.g. `cap7f3a2b`) that makes it difficult for adversarial content to escape
 * the fence using an exact-match prefix guess.
 *
 * **Sanitization approach:** Injection patterns are replaced with `[REDACTED]`
 * (not silently dropped) so the LLM sees a signal that something was removed and
 * Loki logs can detect sanitization events.
 *
 * **Scope:** P14a — this module is additive. Call-site migration is P14b.
 *
 * @example
 * const builder = new SafePromptBuilder()
 * const fenced = builder.wrapContent(captureBody, captureId)
 * // <cap7f3a2b-uuid-here>
 * // Sanitized content...
 * // </cap7f3a2b-uuid-here>
 */
export class SafePromptBuilder {
  /**
   * Session-random delimiter prefix — generated once per SafePromptBuilder instance.
   * e.g. `cap7f3a2b` — unique enough to defeat exact-match evasion.
   */
  readonly delimiterPrefix: string

  constructor(opts?: { delimiterPrefix?: string }) {
    this.delimiterPrefix = opts?.delimiterPrefix ?? `cap${Math.random().toString(36).slice(2, 8)}`
  }

  /**
   * Strips known prompt-injection patterns from a string WITHOUT wrapping in
   * delimiters. Use for field values that appear inline in system instructions
   * (e.g. query strings, entity names, short labels).
   *
   * Logs at debug level when at least one pattern is stripped.
   *
   * @param text - Raw inline text to sanitize
   * @param context - Optional context label for logging (e.g. `query`, `entity-name`)
   * @returns Sanitized string with injection patterns replaced by `[REDACTED]`
   */
  sanitizeInline(text: string, context?: string): string {
    return this._strip(text, context ?? 'inline')
  }

  /**
   * Wraps a single user-controlled string in fenced delimiters and strips
   * known injection patterns. Returns the sanitized, delimited block.
   *
   * Delimiter format:
   *   <cap7f3a2b-abc-123>
   *   Sanitized content here.
   *   </cap7f3a2b-abc-123>
   *
   * When no `id` is provided the tag becomes `<cap7f3a2b-content>`.
   *
   * @param content - Raw user content (capture body, email body, etc.)
   * @param id - Optional capture ID for attribution (included in tag)
   * @returns Sanitized, delimited block
   */
  wrapContent(content: string, id?: string): string {
    const tagSuffix = id ?? 'content'
    const tag = `${this.delimiterPrefix}-${tagSuffix}`
    const sanitized = this._strip(content, id ?? 'content')
    return `<${tag}>\n${sanitized}\n</${tag}>`
  }

  /**
   * Convenience: wraps an array of capture-like objects into a numbered,
   * delimited block suitable for insertion into a `{{captures}}` template slot.
   *
   * Each capture is independently sanitized and wrapped. The returned string
   * is newline-joined.
   *
   * @param captures - Array of objects with optional `id` and required `content`
   * @returns Multi-block string, one fenced block per capture
   */
  wrapCaptures(captures: Array<{ id?: string; content: string }>): string {
    return captures
      .map((cap, i) => {
        const tagSuffix = cap.id ?? String(i)
        const tag = `${this.delimiterPrefix}-${tagSuffix}`
        const sanitized = this._strip(cap.content, cap.id ?? `index-${i}`)
        return `<${tag}>\n${sanitized}\n</${tag}>`
      })
      .join('\n')
  }

  /**
   * Internal: applies all injection patterns to `text`, logs if any stripped.
   */
  private _strip(text: string, context: string): string {
    let result = text
    const stripped: string[] = []

    for (const { name, regex } of INJECTION_PATTERNS) {
      // Reset lastIndex for global regexes between calls
      regex.lastIndex = 0
      if (regex.test(result)) {
        stripped.push(name)
      }
      regex.lastIndex = 0
      result = result.replace(regex, REDACTED_MARKER)
    }

    if (stripped.length > 0) {
      const preview = result.slice(0, 120).replace(/\n/g, '\n')
      logger.debug(
        { context, patterns: stripped, preview },
        `prompt-builder: stripped ${stripped.length} injection pattern(s)`,
      )
    }

    return result
  }
}
