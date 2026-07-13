/**
 * Open Brain Email Worker — Cloudflare Email Routing handler.
 *
 * Receives emails routed via Cloudflare Email Routing (e.g., brain@troy-davis.com),
 * checks the sender against an allowlist fetched from Core API, parses the email
 * with postal-mime, and POSTs the content as a capture. The existing pipeline
 * handles classification, embedding, and entity extraction.
 */

import PostalMime from 'postal-mime'

interface Env {
  CAPTURES_URL: string
  DEFAULT_BRAIN_VIEW: string
  DEFAULT_CAPTURE_TYPE: string
}

/**
 * INT-M3: classify a failed core-api HTTP call for Cloudflare Email Routing.
 *
 * - 5xx → transient: throw so Cloudflare RETRIES delivery later (core-api was
 *   down/restarting — the mail is fine and should not be bounced).
 * - 4xx → permanent: the request is malformed; retrying can't fix it, so the
 *   caller may `setReject` (permanent bounce).
 *
 * Network errors (fetch throws) are inherently transient — let them propagate
 * out of the handler, which Cloudflare also treats as a retryable failure.
 */
export function isTransientStatus(status: number): boolean {
  return status >= 500
}

/** Derive the allowlist settings endpoint from the captures POST URL. */
export function buildAllowlistUrl(capturesUrl: string): string {
  return capturesUrl.replace(/\/captures\/?$/, '') + '/settings/email_allowlist'
}

/** Extract the allowlist entries from the settings API response body. */
export function parseAllowlistEntries(data: { value?: string[] }): string[] {
  return data.value ?? []
}

/** Common email signature delimiters — strip everything after the first match */
const SIGNATURE_PATTERNS = [
  /^--\s*$/m,                          // standard "-- " delimiter
  /^_{3,}$/m,                          // ___ underscores
  /^-{3,}$/m,                          // --- dashes
  /^Sent from my (iPhone|iPad|Galaxy|Pixel|Android)/mi,
  /^Get Outlook for/mi,
  /^Sent from Mail for/mi,
  /^On .+ wrote:$/m,                   // quoted reply header
  /^From: .+$/m,                       // forwarded email header block
]

export function stripSignature(text: string): string {
  let earliest = text.length
  for (const pattern of SIGNATURE_PATTERNS) {
    const match = pattern.exec(text)
    if (match && match.index < earliest) {
      earliest = match.index
    }
  }
  return text.slice(0, earliest).trim()
}

/** Collapse excessive whitespace/newlines but preserve paragraph breaks */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Build capture content from email fields */
export function buildCaptureContent(subject: string, body: string): string {
  const parts: string[] = []
  if (subject) {
    parts.push(`Subject: ${subject}`)
    parts.push('')  // blank line separator
  }
  parts.push(body)
  return parts.join('\n')
}

/**
 * Check sender against allowlist. Supports exact email match and @domain match.
 */
export function isSenderAllowed(sender: string, allowlist: string[]): boolean {
  const senderLower = sender.toLowerCase()
  const atIdx = senderLower.indexOf('@')
  const senderDomain = atIdx >= 0 ? senderLower.slice(atIdx) : ''

  return allowlist.some(entry => {
    const e = entry.toLowerCase()
    return e === senderLower || (e.startsWith('@') && e === senderDomain)
  })
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    const from = message.from
    const to = message.to
    const subject = message.headers.get('subject') ?? '(no subject)'

    console.log(`Email received: from=${from} to=${to} subject="${subject}"`)

    // ── Allowlist check (fail fast) ──────────────────────────────────────────
    const allowlistUrl = buildAllowlistUrl(env.CAPTURES_URL)
    try {
      const alRes = await fetch(allowlistUrl, {
        headers: { 'X-Open-Brain-Caller': 'email-worker' },
      })
      if (alRes.ok) {
        const alData = await alRes.json() as { value?: string[] }
        const entries = parseAllowlistEntries(alData)
        if (!isSenderAllowed(from, entries)) {
          console.log(`Sender ${from} not in allowlist — rejecting`)
          message.setReject(`Sender ${from} not authorized`)
          return
        }
      } else {
        // INT-M3: an allowlist fetch failure is always server-side (core-api
        // unreachable or erroring) — never the sender's fault. Throw so
        // Cloudflare RETRIES delivery instead of permanently bouncing a
        // legitimate email during a core-api restart.
        throw new Error(`Allowlist fetch failed: HTTP ${alRes.status}`)
      }
    } catch (err) {
      // Network error or the throw above — transient; rethrow so Cloudflare
      // retries delivery (do NOT setReject, which is a permanent bounce).
      console.error('Allowlist fetch error:', err)
      throw err instanceof Error ? err : new Error(String(err))
    }

    // ── Parse email ──────────────────────────────────────────────────────────
    const rawEmail = await new Response(message.raw).arrayBuffer()
    const parser = new PostalMime()
    const parsed = await parser.parse(rawEmail)

    // Prefer plain text body; fall back to stripping HTML tags
    let body = parsed.text ?? ''
    if (!body && parsed.html) {
      body = parsed.html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
    }

    body = stripSignature(body)
    body = normalizeWhitespace(body)

    if (!body) {
      console.log('Empty email body after parsing — skipping capture creation')
      return
    }

    const content = buildCaptureContent(subject, body)

    // Enforce 50K content limit (matches Zod schema)
    const trimmedContent = content.length > 49_000 ? content.slice(0, 49_000) + '\n\n[truncated]' : content

    // Collect attachment info as metadata (don't upload the binary data)
    // postal-mime's Attachment.content is ArrayBuffer | Uint8Array | string
    // (string only when an explicit attachmentEncoding option is set, which we
    // don't set — but tsc requires the union to be narrowed regardless).
    const attachments = (parsed.attachments ?? []).map(att => ({
      filename: att.filename ?? 'unnamed',
      mimeType: att.mimeType,
      size: typeof att.content === 'string' ? att.content.length : att.content.byteLength,
    }))

    // ── Create capture ───────────────────────────────────────────────────────
    const capturePayload = {
      content: trimmedContent,
      capture_type: env.DEFAULT_CAPTURE_TYPE,
      brain_view: env.DEFAULT_BRAIN_VIEW,
      source: 'email',
      metadata: {
        source_metadata: {
          from,
          to,
          subject,
          message_id: message.headers.get('message-id') ?? undefined,
          date: message.headers.get('date') ?? undefined,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
      },
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Open-Brain-Caller': 'email-worker',
    }

    console.log(`POSTing capture: ${trimmedContent.length} chars, ${attachments.length} attachments`)

    const response = await fetch(env.CAPTURES_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(capturePayload),
    })

    if (!response.ok) {
      const errorBody = await response.text()
      console.error(`Capture creation failed: ${response.status} ${response.statusText} — ${errorBody}`)
      // INT-M3: 5xx → transient (throw so Cloudflare retries delivery — inbound
      // mail during a core-api restart is no longer bounced). 4xx → permanent
      // (malformed request; retrying won't help) → setReject.
      if (isTransientStatus(response.status)) {
        throw new Error(`Capture API returned ${response.status} (transient — Cloudflare will retry)`)
      }
      message.setReject(`Capture API returned ${response.status}`)
      return
    }

    const result = await response.json() as { id: string; pipeline_status: string }
    console.log(`Capture created: id=${result.id} status=${result.pipeline_status}`)
  },
}
