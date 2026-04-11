import { z } from 'zod'
import type { EmailDraftService } from '../../services/email-draft.js'
import type { SearchService } from '../../services/search.js'

// ─── draft_email ────────────────────────────────────────────────────────────

export const draftEmailSchema = z.object({
  to: z.string().min(1).describe('Recipient email address'),
  subject: z.string().min(1).describe('Email subject line'),
  body: z.string().min(1).describe('Email body text'),
  cc: z.string().optional().describe('Optional CC email address'),
})

export type DraftEmailInput = z.infer<typeof draftEmailSchema>

export async function draftEmailTool(
  input: DraftEmailInput,
  emailDraftService: EmailDraftService,
): Promise<string> {
  const draft = await emailDraftService.create({
    to: input.to,
    subject: input.subject,
    body: input.body,
    cc: input.cc,
    source: 'mcp',
  })

  const lines = [
    `Email draft created.`,
    ``,
    `ID:      ${draft.id}`,
    `To:      ${draft.to_address}`,
    `Subject: ${draft.subject}`,
    `Status:  ${draft.status}`,
    `Mode:    ${draft.send_mode}`,
  ]

  if (draft.cc_address) {
    lines.push(`CC:      ${draft.cc_address}`)
  }

  lines.push(
    ``,
    `The draft requires review before sending.`,
    `Use send_email with the draft ID to approve and send.`,
  )

  return lines.join('\n')
}

// ─── send_email ─────────────────────────────────────────────────────────────

export const sendEmailSchema = z.object({
  draft_id: z.string().min(1).describe('The UUID of the email draft to approve and send'),
})

export type SendEmailInput = z.infer<typeof sendEmailSchema>

export async function sendEmailTool(
  input: SendEmailInput,
  emailDraftService: EmailDraftService,
): Promise<string> {
  const draft = await emailDraftService.approveThenSend(input.draft_id)

  const lines = [
    `Email sent successfully.`,
    ``,
    `ID:      ${draft.id}`,
    `To:      ${draft.to_address}`,
    `Subject: ${draft.subject}`,
    `Status:  ${draft.status}`,
    `Sent at: ${draft.sent_at ? new Date(draft.sent_at).toISOString() : 'unknown'}`,
  ]

  return lines.join('\n')
}

// ─── search_email_captures ──────────────────────────────────────────────────

export const searchEmailCapturesSchema = z.object({
  query: z.string().min(1).describe('Search query to find email captures'),
  limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of results to return'),
  days: z.number().int().min(1).optional().describe('Limit results to the last N days'),
})

export type SearchEmailCapturesInput = z.infer<typeof searchEmailCapturesSchema>

export async function searchEmailCapturesTool(
  input: SearchEmailCapturesInput,
  searchService: SearchService,
): Promise<string> {
  const dateFrom = input.days
    ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000)
    : undefined

  const results = await searchService.search(input.query, {
    limit: input.limit,
    dateFrom,
  })

  // Filter to only email-source captures (inbound 'email' and outbound 'email-outbound')
  const emailResults = results.filter(
    (r) => (r.capture.source as string) === 'email' || (r.capture.source as string) === 'email-outbound',
  )

  if (emailResults.length === 0) {
    return `No email captures found matching "${input.query}"${input.days ? ` in the last ${input.days} days` : ''}.`
  }

  const lines: string[] = [
    `Email captures matching: "${input.query}"`,
    `Found ${emailResults.length} result${emailResults.length !== 1 ? 's' : ''}`,
    '',
  ]

  for (let i = 0; i < emailResults.length; i++) {
    const { capture, score } = emailResults[i]
    const date = new Date(capture.captured_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    const matchPct = Math.round(score * 100)
    const preview = capture.content.length > 500
      ? capture.content.slice(0, 500).trimEnd() + '...'
      : capture.content

    lines.push(
      `${i + 1}. [${matchPct}% match] ${capture.capture_type.toUpperCase()} — ${date} (${capture.source})`,
    )
    lines.push(`   ID: ${capture.id}`)
    if (capture.brain_view) lines.push(`   View: ${capture.brain_view}`)
    lines.push(`   ${preview}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
